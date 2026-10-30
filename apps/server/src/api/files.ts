import { ContentTokenRequest } from "@artifacts/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { can } from "../auth/can.ts";
import { signContentToken } from "../content/token.ts";
import { frames, pages, versions } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { blobKey } from "../publish/blobs.ts";
import { artifactParam } from "./artifacts-db.ts";
import type { Deps } from "./deps.ts";
import { parseBody, type Routes } from "./routes.ts";

const CONTENT_TOKEN_MS = 2 * 3600_000;

export function fileRoutes(routes: Routes, deps: Deps) {
  const { db, env, clock, bucket } = deps;
  const artifact = artifactParam(deps);

  routes.get("/api/artifacts/:id/r/:hash", { action: "artifact.read", resource: artifact }, async (c) => {
    const id = c.req.param("id") as string;
    const hash = c.req.param("hash") as string;
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new ApiError("not_found", "Not found.");
    // Only hashes a live version of this artifact uses, or any artifact's file could be read by hash.
    const hashJson = JSON.stringify({ h: hash });
    const [found] = await db
      .select({ n: versions.n })
      .from(versions)
      .where(
        and(
          eq(versions.artifactId, id),
          isNull(versions.deletedAt),
          sql`(
            jsonb_path_exists(${versions.files}, '$.*.hash ? (@ == $h)', ${hashJson}::jsonb)
            or exists (
              select 1 from ${frames}
              where ${frames.versionId} = ${versions.id}
                and jsonb_path_exists(${frames.renders}, '$.* ? (@ == $h)', ${hashJson}::jsonb)
            )
          )`,
        ),
      )
      .limit(1);
    if (!found) throw new ApiError("not_found", "Not found.");
    // The service worker can't read a bucket's answer without CORS, so it asks for the bytes (06).
    if (c.req.query("via") === "app") {
      const object = await bucket.get(blobKey(hash));
      if (!object) throw new ApiError("not_found", "Not found.");
      return new Response(object.body, {
        headers: {
          "Content-Type": object.contentType ?? "application/octet-stream",
          "Cache-Control": "private, max-age=86400",
        },
      });
    }
    return c.redirect(await bucket.presignGet(blobKey(hash)), 302);
  });

  routes.get(
    "/api/artifacts/:id/v/:n/article/:pageKey",
    { action: "artifact.read", resource: artifact },
    async (c) => {
      const n = Number(c.req.param("n"));
      const [row] = Number.isInteger(n)
        ? await db
            .select({ meta: pages.meta })
            .from(pages)
            .innerJoin(versions, eq(versions.id, pages.versionId))
            .where(
              and(
                eq(versions.artifactId, c.req.param("id") as string),
                eq(versions.n, n),
                isNull(versions.deletedAt),
                eq(pages.pageKey, c.req.param("pageKey") as string),
                eq(pages.kind, "article"),
              ),
            )
            .limit(1)
        : [];
      const hash = (row?.meta as { htmlHash?: string } | undefined)?.htmlHash;
      const object = hash ? await bucket.get(blobKey(hash)) : null;
      if (!object) throw new ApiError("not_found", "Not found.");
      // Never rendered on the viewer's origin, even if someone opens this URL directly (03).
      return new Response(object.body, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": "attachment",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  );

  routes.post(
    "/api/artifacts/:id/content-token",
    { action: "artifact.read", resource: artifact },
    async (c) => {
      if (!env.contentUrl) throw new ApiError("conflict", "Live previews aren't set up on this deployment.");
      const { version } = await parseBody(c, ContentTokenRequest);
      const id = c.req.param("id") as string;
      const caller = c.get("caller");
      const resource = await artifact(c);
      const [row] = await db
        .select({ n: versions.n })
        .from(versions)
        .where(and(eq(versions.artifactId, id), eq(versions.n, version), isNull(versions.deletedAt)))
        .limit(1);
      if (!row) throw new ApiError("not_found", "Not found.");

      let who: { kind: "person" | "guest"; id: string; name: string };
      if (caller.kind === "person") who = { kind: "person", id: caller.person.id, name: caller.person.name };
      else if (caller.kind === "guest") {
        const link = caller.links.find((entry) => entry.artifactId === id && entry.active);
        if (!link) throw new ApiError("not_found", "Not found.");
        who = { kind: "guest", id: caller.guestId, name: link.name };
      } else throw new ApiError("forbidden", "Live previews are for people in a browser.");

      const exp = clock.now().getTime() + CONTENT_TOKEN_MS;
      const token = signContentToken(env, {
        a: id,
        v: version,
        c: {
          ...who,
          canComment: can(caller, "artifact.comment", resource),
          isPublisher: who.kind === "person" && resource.publisherId === who.id,
        },
        exp,
      });
      return c.json({
        base: `${env.contentUrl}/t/${token}/v${version}/`,
        expiresAt: new Date(exp).toISOString(),
      });
    },
  );
}
