import type { BackendLogs, DataFiles, DataList, DataValue, UrlResponse } from "@artifacts/schema";
import { DataClear, DataPut } from "@artifacts/schema";
import { and, asc, eq, gt } from "drizzle-orm";
import type { LoadedArtifact } from "../auth/access.ts";
import { type Caller, callerKey, limiterKey } from "../auth/caller.ts";
import type { OrgRow } from "../db/index.ts";
import { backendLogs, guestLinks, people, shareLinks } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { parseBody, readLimited } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";
import { artifactParam } from "../http/resources.ts";
import type { RouteRequest, Routes } from "../http/routes.ts";
import { dataPrefix, dataScopePrefix } from "../layout.ts";
import { PreconditionFailed } from "../s3.ts";
import {
  checkKey,
  deleteValue,
  fileUrl,
  listKeys,
  pseudonym,
  putFile,
  putValue,
  recountUsage,
  type Scope,
  scopePath,
  walk,
} from "./store.ts";

export function dataRoutes(routes: Routes, deps: Deps) {
  const { db, bucket, clock, limits: rate } = deps;
  const artifact = artifactParam(deps);

  type DataRequest = RouteRequest<Caller, LoadedArtifact>;
  const scopeOf = (c: DataRequest): Scope => {
    const scope = c.req.param("scope");
    if (scope !== "shared" && scope !== "me") throw new ApiError("not_found", "Not found.");
    return scope;
  };
  const myId = (c: DataRequest) => {
    const key = callerKey(c.var.caller);
    return key ? pseudonym(c.var.org, c.var.resource.id, key) : null;
  };
  const prefix = (c: DataRequest, files = false) =>
    scopePath(c.var.resource.id, scopeOf(c), scopeOf(c) === "me" ? myId(c) : null, files);
  /** Only `shared`: a `me` key is one person's, and its name says nothing anyone else should see. */
  const changed = (c: DataRequest, key: string, etag: string | null) => {
    if (scopeOf(c) === "shared") {
      void deps.events.emit(c.var.resource.id, "data", { scope: "shared", key, etag });
    }
  };
  const limited = (c: DataRequest) => {
    const key = limiterKey(c.var.caller) ?? "token";
    rate.hit(`data:${c.var.resource.id}:${key}`, c.var.org.settings.limits.writesPerSecond, 1000);
  };
  const precondition = async <T>(work: () => Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof PreconditionFailed)
        throw new ApiError("precondition_failed", "Someone wrote first.");
      throw error;
    }
  };
  /** `parseBody` for a data PUT, but never reading more than a value may be (plus the envelope). */
  const boundedPut = async (c: DataRequest) => {
    const bytes = await readLimited(c.req.raw, c.var.org.settings.limits.dataValueBytes + 1024);
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ApiError("invalid", "The body must be JSON.");
    }
    const parsed = DataPut.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError("invalid", "The request isn't valid.", { issues: parsed.error.issues });
    }
    return parsed.data;
  };

  routes.get("/api/artifacts/:id/data/:scope", { action: "data.read", resource: artifact }, async (c) => {
    const base = prefix(c);
    const wanted = c.req.query("prefix");
    if (wanted) checkKey(wanted);
    const page = await listKeys(deps, `${base}${wanted ?? ""}`, c.req.query("cursor"));
    return c.json({
      keys: page.keys.map((entry) => ({ ...entry, key: `${wanted ?? ""}${entry.key}` })),
      nextCursor: page.nextCursor,
    } satisfies DataList);
  });

  routes.get(
    "/api/artifacts/:id/data/:scope/:key{.+}",
    { action: "data.read", resource: artifact },
    async (c) => {
      const key = checkKey(c.req.param("key") as string);
      const object = await bucket.get(`${prefix(c)}${key}`);
      if (!object) throw new ApiError("not_found", "Not found.");
      return c.json({
        value: JSON.parse(new TextDecoder().decode(object.body)),
        etag: object.etag,
      } satisfies DataValue);
    },
  );

  routes.put(
    "/api/artifacts/:id/data/:scope/:key{.+}",
    { action: "data.write", resource: artifact },
    async (c) => {
      const key = checkKey(c.req.param("key") as string);
      limited(c);
      const { value } = await boundedPut(c);
      const ifMatch = c.req.header("if-match");
      const result = await precondition(() =>
        putValue(deps, {
          orgId: c.var.org.id,
          artifactId: c.var.resource.id,
          scope: scopeOf(c),
          objectKey: `${prefix(c)}${key}`,
          value,
          limits: c.var.org.settings.limits,
          ifMatch: ifMatch && ifMatch !== "*" ? ifMatch.replaceAll('"', "") : undefined,
          ifNoneMatch: c.req.header("if-none-match") === "*",
        }),
      );
      changed(c, key, result.etag);
      return c.json(result);
    },
  );

  routes.delete(
    "/api/artifacts/:id/data/:scope/:key{.+}",
    { action: "data.write", resource: artifact },
    async (c) => {
      const key = checkKey(c.req.param("key") as string);
      limited(c);
      await precondition(() =>
        deleteValue(deps, {
          orgId: c.var.org.id,
          artifactId: c.var.resource.id,
          scope: scopeOf(c),
          objectKey: `${prefix(c)}${key}`,
          ifMatch: c.req.header("if-match")?.replaceAll('"', ""),
        }),
      );
      changed(c, key, null);
      return c.json({ ok: true });
    },
  );

  routes.get("/api/artifacts/:id/files/:scope", { action: "data.read", resource: artifact }, async (c) => {
    const page = await listKeys(deps, prefix(c, true), c.req.query("cursor"));
    return c.json({
      files: page.keys.map(({ key, ...rest }) => ({ name: key, ...rest })),
      nextCursor: page.nextCursor,
    } satisfies DataFiles);
  });

  routes.put(
    "/api/artifacts/:id/files/:scope/:name{.+}",
    { action: "data.write", resource: artifact },
    async (c) => {
      const name = checkKey(c.req.param("name") as string);
      limited(c);
      const limits = c.var.org.settings.limits;
      const result = await putFile(deps, {
        orgId: c.var.org.id,
        artifactId: c.var.resource.id,
        objectKey: `${prefix(c, true)}${name}`,
        body: await readLimited(c.req.raw, limits.fileBytes),
        contentType: c.req.header("content-type") ?? "application/octet-stream",
        limits,
      });
      return c.json({ name, ...result });
    },
  );

  routes.get(
    "/api/artifacts/:id/files/:scope/:name{.+}",
    { action: "data.read", resource: artifact },
    async (c) => {
      const name = checkKey(c.req.param("name") as string);
      const url = await fileUrl(deps, `${prefix(c, true)}${name}`);
      // A frame can't follow a redirect it can't see, so the bridge asks for the URL.
      if (c.req.header("accept")?.includes("application/json")) return c.json({ url } satisfies UrlResponse);
      return c.redirect(url, 302);
    },
  );

  routes.delete(
    "/api/artifacts/:id/files/:scope/:name{.+}",
    { action: "data.write", resource: artifact },
    async (c) => {
      const name = checkKey(c.req.param("name") as string);
      limited(c);
      await deleteValue(deps, {
        orgId: c.var.org.id,
        artifactId: c.var.resource.id,
        scope: "files",
        objectKey: `${prefix(c, true)}${name}`,
      });
      return c.json({ ok: true });
    },
  );

  routes.get("/api/artifacts/:id/logs", { action: "data.export", resource: artifact }, async (c) => {
    const version = Number(c.req.query("version"));
    const after = c.req.query("after");
    const rows = await db
      .select()
      .from(backendLogs)
      .where(
        and(
          eq(backendLogs.artifactId, c.var.resource.id),
          Number.isInteger(version) && version > 0 ? eq(backendLogs.version, version) : undefined,
          after ? gt(backendLogs.id, after) : undefined,
        ),
      )
      .orderBy(asc(backendLogs.id))
      .limit(500);
    return c.json(
      rows.map((row) => ({
        id: row.id,
        version: row.version,
        level: row.level,
        message: row.message,
        requestId: row.requestId,
        createdAt: row.createdAt.toISOString(),
      })) satisfies BackendLogs,
    );
  });

  /** Pseudonym to display name, for the publisher's export (08). */
  async function names(org: OrgRow, id: string) {
    const map = new Map<string, string>();
    const everyone = await db
      .select({ id: people.id, name: people.name })
      .from(people)
      .where(eq(people.orgId, org.id));
    for (const person of everyone) map.set(pseudonym(org, id, person.id), person.name);
    const guests = await db
      .select({ id: guestLinks.guestId, name: guestLinks.name })
      .from(guestLinks)
      .innerJoin(shareLinks, eq(shareLinks.id, guestLinks.shareLinkId))
      .where(and(eq(shareLinks.artifactId, id), gt(guestLinks.expiresAt, new Date(0))));
    for (const guest of guests) map.set(pseudonym(org, id, guest.id), guest.name);
    return map;
  }

  routes.get("/api/artifacts/:id/data-export", { action: "data.export", resource: artifact }, async (c) => {
    const { id } = c.var.resource;
    const base = dataPrefix(id);
    const who = await names(c.var.org, id);
    const body = {
      shared: {} as Record<string, unknown>,
      me: {} as Record<string, { name: string; data: Record<string, unknown> }>,
      files: [] as { scope: string; owner: string | null; name: string; url: string }[],
    };
    for (const { key } of await walk(deps, base)) {
      const path = key.slice(base.length);
      const parts = path.split("/");
      if (parts[0] === "files") {
        const isMe = parts[1] === "me";
        body.files.push({
          scope: isMe ? "me" : "shared",
          owner: isMe ? (who.get(parts[2] as string) ?? parts[2] ?? null) : null,
          name: parts.slice(isMe ? 3 : 2).join("/"),
          url: await fileUrl(deps, key),
        });
        continue;
      }
      const object = await bucket.get(key);
      if (!object) continue;
      const value = JSON.parse(new TextDecoder().decode(object.body));
      if (parts[0] === "shared") body.shared[parts.slice(1).join("/")] = value;
      if (parts[0] === "me") {
        const owner = parts[1] as string;
        body.me[owner] ??= { name: who.get(owner) ?? "Someone", data: {} };
        (body.me[owner] as { data: Record<string, unknown> }).data[parts.slice(2).join("/")] = value;
      }
    }
    return c.json(body);
  });

  routes.post(
    "/api/artifacts/:id/data-clear",
    { action: "data.export", resource: artifact, writes: true },
    async (c) => {
      const { scope } = await parseBody(c, DataClear);
      const { id } = c.var.resource;
      const prefixes = scope
        ? [dataScopePrefix(id, scope), dataScopePrefix(id, scope, { files: true })]
        : [dataPrefix(id)];
      for (const entry of prefixes) await bucket.deletePrefix(entry);
      await recountUsage(deps, c.var.org.id, id);
      return c.json({ ok: true, at: clock.now().toISOString() });
    },
  );
}
