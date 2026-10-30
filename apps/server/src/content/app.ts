import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { findArtifact } from "../api/artifacts-db.ts";
import type { Deps } from "../api/deps.ts";
import type { Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { guestCaller } from "../auth/resolve.ts";
import { findOrg } from "../db/index.ts";
import { people, versions } from "../db/schema.ts";
import { createApp } from "../http/app.ts";
import { ApiError } from "../http/errors.ts";
import { blobKey } from "../publish/blobs.ts";
import { bucketOrigin } from "../s3.ts";
import { type ContentPayload, verifyContentToken } from "./token.ts";

const RECHECK_MS = 5000;
const CACHE_BYTES = 64 * 1024 * 1024;
/** Spike S8: what browsers send for iframes, sub-resources and media. `document` never passes. */
const ALLOWED_DEST = new Set([
  "iframe",
  "empty",
  "script",
  "style",
  "image",
  "font",
  "audio",
  "video",
  "track",
]);

/** Least recently used, by bytes. A blob's content never changes, so entries never go stale. */
class BlobCache {
  private readonly entries = new Map<string, Uint8Array>();
  private bytes = 0;

  get(hash: string) {
    const body = this.entries.get(hash);
    if (body) {
      this.entries.delete(hash);
      this.entries.set(hash, body);
    }
    return body;
  }

  set(hash: string, body: Uint8Array) {
    if (body.length > CACHE_BYTES) return;
    this.entries.set(hash, body);
    this.bytes += body.length;
    for (const [oldest, value] of this.entries) {
      if (this.bytes <= CACHE_BYTES) break;
      this.entries.delete(oldest);
      this.bytes -= value.length;
    }
  }
}

/** Live previews (03): bundle files, by path, behind a token that's re-checked on every request. */
export function createContentApp(deps: Deps) {
  const { env, log, db, bucket, clock } = deps;
  const app = createApp(log);
  const host = env.contentUrl && new URL(env.contentUrl).host;
  const blobs = new BlobCache();
  const checks = new Map<string, { ok: boolean; at: number }>();

  const cspFor = (origins: string[]) =>
    env.contentUrl
      ? (() => {
          const self = env.contentUrl;
          const store = bucketOrigin(env.s3);
          const viewers = origins.join(" ");
          return [
            `default-src ${self}`,
            `script-src ${self} 'unsafe-inline'`,
            `style-src ${self} 'unsafe-inline'`,
            `font-src ${self}`,
            `img-src ${self} data: blob: ${store}`,
            `media-src ${self} blob: ${store}`,
            `connect-src ${self}`,
            `frame-ancestors ${viewers}`,
            "base-uri 'none'",
            "form-action 'none'",
            "sandbox allow-scripts",
          ].join("; ");
        })()
      : "";

  app.use(async (c, next) => {
    await next();
    const csp = cspFor(await deps.origins()); // Includes the home domain, which isn't in the environment.
    c.header("Access-Control-Allow-Origin", "*");
    if (csp) c.header("Content-Security-Policy", csp);
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
  });

  /** The token proves who; this proves they still may (04). Cached at most 5 seconds. */
  async function stillAllowed(token: string, payload: ContentPayload): Promise<boolean> {
    const now = clock.now().getTime();
    const cached = checks.get(token);
    if (cached && now - cached.at < RECHECK_MS) return cached.ok;

    const artifact = await findArtifact(deps, await orgIdOf(deps), payload.a);
    let ok = false;
    if (artifact) {
      const [version] = await db
        .select({ n: versions.n })
        .from(versions)
        .where(and(eq(versions.artifactId, payload.a), eq(versions.n, payload.v), isNull(versions.deletedAt)))
        .limit(1);
      const caller = await currentCaller(payload);
      ok = version !== undefined && caller !== null && can(caller, "artifact.read", artifact);
    }
    if (checks.size > 10_000) checks.clear();
    checks.set(token, { ok, at: now });
    return ok;
  }

  async function currentCaller(payload: ContentPayload): Promise<Caller | null> {
    if (payload.c.kind === "guest") return guestCaller(deps, payload.c.id);
    const [person] = await db
      .select()
      .from(people)
      .where(and(eq(people.id, payload.c.id), isNull(people.removedAt)))
      .limit(1);
    if (!person) return null;
    return {
      kind: "person",
      sessionId: "",
      recentAuth: false,
      person: { id: person.id, name: person.name, email: person.email, role: person.role },
    };
  }

  async function serveFile(c: Context, token: string, version: number, path: string) {
    const payload = verifyContentToken(env, token);
    if (!payload || payload.exp <= clock.now().getTime() || payload.v !== version) {
      throw new ApiError("forbidden", "This link expired.");
    }
    if (!(await stillAllowed(token, payload))) throw new ApiError("not_found", "Not found.");

    const [row] = await db
      .select({ files: versions.files })
      .from(versions)
      .where(and(eq(versions.artifactId, payload.a), eq(versions.n, version)))
      .limit(1);
    const files = row?.files as Record<string, { hash: string; type: string }> | undefined;
    const file = files && Object.hasOwn(files, path) ? files[path] : undefined;
    if (!file) throw new ApiError("not_found", "Not found.");

    let body = blobs.get(file.hash);
    if (!body) {
      const object = await bucket.get(blobKey(file.hash));
      if (!object) throw new ApiError("not_found", "Not found.");
      body = object.body;
      blobs.set(file.hash, body);
    }
    // Safari asks for byte ranges on audio and video, and won't play without them.
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
    if (range && (range[1] || range[2])) {
      const size = body.length;
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        return c.body(null, 416, { "Content-Range": `bytes */${size}` });
      }
      return c.body(body.slice(start, end + 1) as Uint8Array<ArrayBuffer>, 206, {
        "Content-Type": file.type,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      });
    }
    return c.body(body as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": file.type,
      "Accept-Ranges": "bytes",
      // No caching: a frame must not keep reading files after its access ends (04).
      "Cache-Control": "no-store",
    });
  }

  app.use("/t/*", async (c, next) => {
    if (c.req.header("host")?.toLowerCase() !== host) {
      throw new ApiError("misdirected", "This server doesn't answer on that host.");
    }
    // Fail closed: every browser the viewer supports sends this (03).
    const dest = c.req.header("sec-fetch-dest");
    if (!dest || !ALLOWED_DEST.has(dest)) {
      throw new ApiError("forbidden", "Live previews only open inside the viewer.");
    }
    await next();
  });

  app.get("/t/:token/:version/*", async (c) => {
    const match = /^v(\d+)$/.exec(c.req.param("version"));
    if (!match) throw new ApiError("not_found", "Not found.");
    const prefix = `/t/${c.req.param("token")}/${c.req.param("version")}/`;
    let path: string;
    try {
      path = decodeURIComponent(c.req.path.slice(prefix.length));
    } catch {
      throw new ApiError("not_found", "Not found.");
    }
    return serveFile(c, c.req.param("token"), Number(match[1]), path);
  });

  app.all("/t/*", () => {
    throw new ApiError("not_found", "Not found.");
  });

  return app;
}

async function orgIdOf(deps: Deps) {
  const org = await findOrg(deps.db);
  if (!org) throw new ApiError("not_found", "Not found.");
  return org.id;
}
