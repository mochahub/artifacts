import { DataClear, DataPut } from "@artifacts/schema";
import { and, eq, gt, inArray } from "drizzle-orm";
import { artifactParam } from "../api/artifacts-db.ts";
import type { Deps } from "../api/deps.ts";
import { type ApiContext, parseBody, type Routes } from "../api/routes.ts";
import { artifactUsage, guestLinks, people, shareLinks } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { deletePrefix } from "../jobs/purge.ts";
import { PreconditionFailed } from "../s3.ts";
import {
  callerKey,
  checkKey,
  dataPrefix,
  deleteValue,
  fileUrl,
  listKeys,
  pseudonym,
  putFile,
  putValue,
  type Scope,
  scopePath,
  walk,
} from "./store.ts";

export function dataRoutes(routes: Routes, deps: Deps) {
  const { db, bucket, clock, limits: rate } = deps;
  const artifact = artifactParam(deps);

  const scopeOf = (c: ApiContext): Scope => {
    const scope = c.req.param("scope");
    if (scope !== "shared" && scope !== "me") throw new ApiError("not_found", "Not found.");
    return scope;
  };
  const myId = (c: ApiContext) => {
    const key = callerKey(c.get("caller"));
    return key ? pseudonym(c.get("org"), c.req.param("id") as string, key) : null;
  };
  const prefix = (c: ApiContext, files = false) =>
    scopePath(c.req.param("id") as string, scopeOf(c), scopeOf(c) === "me" ? myId(c) : null, files);
  const limited = (c: ApiContext) => {
    const key = callerKey(c.get("caller")) ?? "token";
    rate.hit(`data:${c.req.param("id")}:${key}`, c.get("org").settings.limits.writesPerSecond, 1000);
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
  const usageScope = (c: ApiContext) => scopeOf(c);

  routes.get("/api/artifacts/:id/data/:scope", { action: "data.read", resource: artifact }, async (c) => {
    const base = prefix(c as ApiContext);
    const wanted = c.req.query("prefix");
    if (wanted) checkKey(wanted);
    const page = await listKeys(deps, `${base}${wanted ?? ""}`, c.req.query("cursor"));
    return c.json({
      keys: page.keys.map((entry) => ({ ...entry, key: `${wanted ?? ""}${entry.key}` })),
      nextCursor: page.nextCursor,
    });
  });

  routes.get(
    "/api/artifacts/:id/data/:scope/:key{.+}",
    { action: "data.read", resource: artifact },
    async (c) => {
      const key = checkKey(c.req.param("key") as string);
      const object = await bucket.get(`${prefix(c as ApiContext)}${key}`);
      if (!object) throw new ApiError("not_found", "Not found.");
      return c.json({ value: JSON.parse(new TextDecoder().decode(object.body)), etag: object.etag });
    },
  );

  routes.put(
    "/api/artifacts/:id/data/:scope/:key{.+}",
    { action: "data.write", resource: artifact },
    async (c) => {
      const key = checkKey(c.req.param("key") as string);
      limited(c as ApiContext);
      const { value } = await parseBody(c, DataPut);
      const ifMatch = c.req.header("if-match");
      const result = await precondition(() =>
        putValue(deps, {
          orgId: c.get("org").id,
          artifactId: c.req.param("id") as string,
          scope: usageScope(c as ApiContext),
          objectKey: `${prefix(c as ApiContext)}${key}`,
          value,
          limits: c.get("org").settings.limits,
          ifMatch: ifMatch && ifMatch !== "*" ? ifMatch.replaceAll('"', "") : undefined,
          ifNoneMatch: c.req.header("if-none-match") === "*",
        }),
      );
      return c.json(result);
    },
  );

  routes.delete(
    "/api/artifacts/:id/data/:scope/:key{.+}",
    { action: "data.write", resource: artifact },
    async (c) => {
      const key = checkKey(c.req.param("key") as string);
      limited(c as ApiContext);
      await precondition(() =>
        deleteValue(deps, {
          orgId: c.get("org").id,
          artifactId: c.req.param("id") as string,
          scope: usageScope(c as ApiContext),
          objectKey: `${prefix(c as ApiContext)}${key}`,
          ifMatch: c.req.header("if-match")?.replaceAll('"', ""),
        }),
      );
      return c.json({ ok: true });
    },
  );

  routes.get("/api/artifacts/:id/files/:scope", { action: "data.read", resource: artifact }, async (c) => {
    const page = await listKeys(deps, prefix(c as ApiContext, true), c.req.query("cursor"));
    return c.json({
      files: page.keys.map(({ key, ...rest }) => ({ name: key, ...rest })),
      nextCursor: page.nextCursor,
    });
  });

  routes.put(
    "/api/artifacts/:id/files/:scope/:name{.+}",
    { action: "data.write", resource: artifact },
    async (c) => {
      const name = checkKey(c.req.param("name") as string);
      limited(c as ApiContext);
      const limits = c.get("org").settings.limits;
      if (Number(c.req.header("content-length") ?? 0) > limits.fileBytes) {
        throw new ApiError("too_large", "That file is too big.", { limit: limits.fileBytes });
      }
      const result = await putFile(deps, {
        orgId: c.get("org").id,
        artifactId: c.req.param("id") as string,
        objectKey: `${prefix(c as ApiContext, true)}${name}`,
        body: new Uint8Array(await c.req.arrayBuffer()),
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
      const url = await fileUrl(deps, `${prefix(c as ApiContext, true)}${name}`);
      // A frame can't follow a redirect it can't see, so the bridge asks for the URL.
      if (c.req.header("accept")?.includes("application/json")) return c.json({ url });
      return c.redirect(url, 302);
    },
  );

  routes.delete(
    "/api/artifacts/:id/files/:scope/:name{.+}",
    { action: "data.write", resource: artifact },
    async (c) => {
      const name = checkKey(c.req.param("name") as string);
      await deleteValue(deps, {
        orgId: c.get("org").id,
        artifactId: c.req.param("id") as string,
        scope: "files",
        objectKey: `${prefix(c as ApiContext, true)}${name}`,
      });
      return c.json({ ok: true });
    },
  );

  /** Pseudonym to display name, for the publisher's export (08). */
  async function names(c: ApiContext) {
    const org = c.get("org");
    const id = c.req.param("id") as string;
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
    const id = c.req.param("id") as string;
    const base = dataPrefix(id);
    const who = await names(c as ApiContext);
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

  routes.post("/api/artifacts/:id/data-clear", { action: "data.export", resource: artifact }, async (c) => {
    const resource = await artifact(c as ApiContext);
    if (resource.archivedAt) throw new ApiError("read_only", "This artifact is archived, so it's read-only.");
    const { scope } = await parseBody(c, DataClear);
    const id = resource.id;
    const base = dataPrefix(id);
    const prefixes = scope ? [`${base}${scope}/`, `${base}files/${scope}/`] : [base];
    for (const entry of prefixes) await deletePrefix(deps, entry);
    await db
      .delete(artifactUsage)
      .where(
        and(
          eq(artifactUsage.artifactId, id),
          scope ? inArray(artifactUsage.scope, [scope, "files"]) : undefined,
        ),
      );
    return c.json({ ok: true, at: clock.now().toISOString() });
  });
}
