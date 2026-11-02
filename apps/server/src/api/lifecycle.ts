import { agentLabel, UNNAMED_AGENT } from "@artifacts/schema";
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Caller } from "../auth/caller.ts";
import { seesArtifact } from "../auth/can.ts";
import { callerKey } from "../data/store.ts";
import {
  activity,
  artifacts,
  blocks,
  frames,
  guests,
  pages,
  people,
  projects,
  threads,
  versions,
} from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { etagJson } from "../http/etag.ts";
import { purgeArtifact, purgeVersion } from "../jobs/purge.ts";
import { blobKey } from "../publish/blobs.ts";
import { reanchorThreads } from "../publish/routes.ts";
import { diffRegions, type Region } from "../review/regions.ts";
import { artifactParam, findArtifacts } from "./artifacts-db.ts";
import type { Deps } from "./deps.ts";
import type { ApiContext, Routes } from "./routes.ts";

const PURGE_MS = 30 * 24 * 3600_000;

const actorId = (caller: Caller) => {
  if (caller.kind === "person" || caller.kind === "cliToken") return caller.person.id;
  if (caller.kind === "orgToken") return caller.createdBy;
  return null;
};

/** The same lock as publish commit, so nothing changes under a publish in progress (03). */
const LOCK = (id: string) => sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`;

/** One render pair never changes its answer, so it's worked out once. */
const regionCache = new Map<string, Region[]>();
const MAX_CACHED_REGIONS = 2000;
const MAX_FRAMES_DIFFED = 40;
const COMPARES_PER_MINUTE = 30;
/** Each diff holds two renders in memory, so only a couple run at once, whoever's asking. */
let diffing: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(work: () => Promise<T>) => {
  const run = diffing.then(work, work);
  diffing = run.catch(() => {});
  return run;
};

/** Per changed frame: the two @2x renders, and where they differ (03). */
async function changedRegions(
  deps: Deps,
  keys: string[],
  before: (typeof frames.$inferSelect)[],
  after: (typeof frames.$inferSelect)[],
  who: string,
) {
  const rendersOf = (rows: typeof before, key: string) =>
    rows.find((row) => `${row.pageKey}/${row.frameKey}` === key)?.renders as { "2x": string } | undefined;
  const result: Record<string, { before: string; after: string; regions: Region[] }> = {};
  let counted = false;
  for (const key of keys.slice(0, MAX_FRAMES_DIFFED)) {
    const a = rendersOf(before, key)?.["2x"];
    const b = rendersOf(after, key)?.["2x"];
    if (!a || !b) continue;
    let regions = regionCache.get(`${a}:${b}`);
    if (!regions) {
      if (!counted) deps.limits.hit(`compare:${who}`, COMPARES_PER_MINUTE, 60_000);
      counted = true;
      regions = await oneAtATime(async () => {
        const [first, second] = await Promise.all([deps.bucket.get(blobKey(a)), deps.bucket.get(blobKey(b))]);
        if (!first || !second) return null;
        // A render the image library can't read still counts as changed: it just has no boxes.
        return diffRegions(first.body, second.body).catch(() => [] as Region[]);
      }).then((value) => value ?? undefined);
      if (!regions) continue;
      if (regionCache.size >= MAX_CACHED_REGIONS) regionCache.clear();
      regionCache.set(`${a}:${b}`, regions);
    }
    result[key] = { before: a, after: b, regions };
  }
  return result;
}

/** Rows about no artifact, so nothing to check them against: they're for the people who run the place. */
const ADMIN_ACTIVITY = [
  "purged",
  "team_created",
  "team_deleted",
  "team_member_added",
  "team_member_removed",
  "project_access_changed",
  "identity_linked",
];

export function lifecycleRoutes(routes: Routes, deps: Deps) {
  const { db, clock } = deps;
  const artifact = artifactParam(deps);

  const record = async (
    c: ApiContext,
    row: { id: string; projectId: string },
    kind: typeof activity.$inferInsert.kind,
    payload: Record<string, unknown> = {},
  ) => {
    await db.insert(activity).values({
      id: Bun.randomUUIDv7(),
      orgId: c.get("org").id,
      artifactId: row.id,
      projectId: row.projectId,
      actorPersonId: actorId(c.get("caller")),
      agent:
        c.get("caller").kind === "person"
          ? null
          : c.req.header("artifacts-agent")?.slice(0, 60) || UNNAMED_AGENT,
      kind,
      payload,
      createdAt: clock.now(),
    });
    void deps.events.emit(row.id, "version");
  };

  const setArchived = (archived: boolean) => async (c: ApiContext) => {
    const resource = await artifact(c);
    await db.transaction(async (tx) => {
      await tx.execute(LOCK(resource.id));
      await tx
        .update(artifacts)
        .set(
          archived
            ? { archivedAt: clock.now(), archivedBy: actorId(c.get("caller")) }
            : { archivedAt: null, archivedBy: null },
        )
        .where(eq(artifacts.id, resource.id));
    });
    await record(c, resource, archived ? "archived" : "unarchived");
    return c.json({ ok: true });
  };
  routes.post("/api/artifacts/:id/archive", { action: "artifact.archive", resource: artifact }, (c) =>
    setArchived(true)(c as ApiContext),
  );
  routes.post("/api/artifacts/:id/unarchive", { action: "artifact.archive", resource: artifact }, (c) =>
    setArchived(false)(c as ApiContext),
  );

  routes.post("/api/artifacts/:id/delete", { action: "artifact.delete", resource: artifact }, async (c) => {
    const resource = await artifact(c as ApiContext);
    if (resource.deletedAt) throw new ApiError("conflict", "It's already in Recently deleted.");
    const now = clock.now();
    const purgeAfter = new Date(now.getTime() + PURGE_MS);
    await db.transaction(async (tx) => {
      await tx.execute(LOCK(resource.id));
      await tx
        .update(artifacts)
        .set({ deletedAt: now, deletedBy: actorId(c.get("caller")), purgeAfter })
        .where(eq(artifacts.id, resource.id));
    });
    await record(c as ApiContext, resource, "deleted", { title: resource.row.title });
    return c.json({ purgeAfter: purgeAfter.toISOString() });
  });

  routes.post("/api/artifacts/:id/undelete", { action: "artifact.delete", resource: artifact }, async (c) => {
    const resource = await artifact(c as ApiContext);
    if (!resource.deletedAt) throw new ApiError("conflict", "It isn't in Recently deleted.");
    await db.transaction(async (tx) => {
      await tx.execute(LOCK(resource.id));
      await tx
        .update(artifacts)
        .set({ deletedAt: null, deletedBy: null, purgeAfter: null })
        .where(eq(artifacts.id, resource.id));
    });
    await record(c as ApiContext, resource, "undeleted");
    return c.json({ ok: true });
  });

  routes.delete(
    "/api/artifacts/:id",
    { action: "artifact.purge", resource: artifact, recentAuth: true },
    async (c) => {
      const resource = await artifact(c as ApiContext);
      if (!resource.deletedAt)
        throw new ApiError("conflict", "Delete it first; only Recently deleted can be purged.");
      await purgeArtifact(deps, resource.row, actorId(c.get("caller")));
      return c.json({ ok: true });
    },
  );

  routes.get("/api/deleted", { action: "deleted.read" }, async (c) => {
    const caller = c.get("caller");
    const orgId = c.get("org").id;
    const mine = caller.kind === "person" || caller.kind === "cliToken" ? caller.person : null;
    const admin = mine?.role === "owner" || mine?.role === "admin";
    const [gone, removed] = await Promise.all([
      db
        .select({ row: artifacts, project: projects.slug, by: people.name })
        .from(artifacts)
        .innerJoin(projects, eq(projects.id, artifacts.projectId))
        .leftJoin(people, eq(people.id, artifacts.deletedBy))
        .where(
          and(
            eq(artifacts.orgId, orgId),
            isNotNull(artifacts.deletedAt),
            admin ? undefined : eq(artifacts.deletedBy, mine?.id ?? ""),
          ),
        )
        .orderBy(desc(artifacts.deletedAt)),
      db
        .select({ version: versions, row: artifacts, project: projects.slug, by: people.name })
        .from(versions)
        .innerJoin(artifacts, eq(artifacts.id, versions.artifactId))
        .innerJoin(projects, eq(projects.id, artifacts.projectId))
        .leftJoin(people, eq(people.id, versions.deletedBy))
        .where(
          and(
            eq(versions.orgId, orgId),
            isNotNull(versions.deletedAt),
            isNull(artifacts.deletedAt),
            admin ? undefined : eq(versions.deletedBy, mine?.id ?? ""),
          ),
        )
        .orderBy(desc(versions.deletedAt)),
    ]);
    const view = (row: typeof artifacts.$inferSelect, project: string) => ({
      id: row.id,
      project,
      slug: row.slug,
      title: row.title,
    });
    return c.json([
      ...gone.map(({ row, project, by }) => ({
        kind: "artifact" as const,
        artifact: view(row, project),
        deletedBy: by,
        deletedAt: row.deletedAt?.toISOString(),
        purgeAfter: row.purgeAfter?.toISOString(),
      })),
      ...removed.map(({ version, row, project, by }) => ({
        kind: "version" as const,
        artifact: view(row, project),
        version: version.n,
        deletedBy: by,
        deletedAt: version.deletedAt?.toISOString(),
        purgeAfter: version.purgeAfter?.toISOString(),
      })),
    ]);
  });

  async function versionParam(c: ApiContext) {
    const resource = await artifact(c);
    const n = Number(c.req.param("n"));
    const [row] = Number.isInteger(n)
      ? await db
          .select()
          .from(versions)
          .where(and(eq(versions.artifactId, resource.id), eq(versions.n, n)))
          .limit(1)
      : [];
    if (!row) throw new ApiError("not_found", "Not found.");
    return { resource, version: row };
  }

  routes.post(
    "/api/artifacts/:id/versions/:n/delete",
    { action: "artifact.delete", resource: artifact },
    async (c) => {
      const { resource, version } = await versionParam(c as ApiContext);
      if (version.deletedAt) throw new ApiError("conflict", "That version is already removed.");
      if (version.n === resource.row.latestVersion) {
        throw new ApiError("conflict", "The latest version can't be removed. Publish a fix first.");
      }
      const now = clock.now();
      const purgeAfter = new Date(now.getTime() + PURGE_MS);
      await db.transaction(async (tx) => {
        await tx.execute(LOCK(resource.id));
        await tx
          .update(versions)
          .set({ deletedAt: now, deletedBy: actorId(c.get("caller")), purgeAfter })
          .where(eq(versions.id, version.id));
        // Threads made on it move to the next live version, and re-anchor there (05).
        const [next] = await tx
          .select()
          .from(versions)
          .where(
            and(eq(versions.artifactId, resource.id), gt(versions.n, version.n), isNull(versions.deletedAt)),
          )
          .orderBy(asc(versions.n))
          .limit(1);
        if (!next)
          throw new ApiError("conflict", "The latest version can't be removed. Publish a fix first.");
        const [pageRows, frameRows, blockRows] = await Promise.all([
          tx.select().from(pages).where(eq(pages.versionId, next.id)),
          tx.select().from(frames).where(eq(frames.versionId, next.id)),
          tx.select().from(blocks).where(eq(blocks.versionId, next.id)),
        ]);
        await reanchorThreads(
          tx,
          resource.id,
          pageRows.map((row) => ({ key: row.pageKey })),
          frameRows,
          blockRows,
          version.n,
        );
        await tx
          .update(threads)
          .set({ createdVersion: next.n, movedFromVersion: version.n })
          .where(and(eq(threads.artifactId, resource.id), eq(threads.createdVersion, version.n)));
      });
      await record(c as ApiContext, resource, "version_deleted", { version: version.n });
      return c.json({ purgeAfter: purgeAfter.toISOString() });
    },
  );

  routes.post(
    "/api/artifacts/:id/versions/:n/undelete",
    { action: "artifact.delete", resource: artifact },
    async (c) => {
      const { resource, version } = await versionParam(c as ApiContext);
      if (!version.deletedAt) throw new ApiError("conflict", "That version isn't removed.");
      await db.transaction(async (tx) => {
        await tx.execute(LOCK(resource.id));
        await tx
          .update(versions)
          .set({ deletedAt: null, deletedBy: null, purgeAfter: null })
          .where(eq(versions.id, version.id));
      });
      await record(c as ApiContext, resource, "version_undeleted", { version: version.n });
      return c.json({ ok: true });
    },
  );

  routes.delete(
    "/api/artifacts/:id/versions/:n",
    { action: "artifact.purge", resource: artifact, recentAuth: true },
    async (c) => {
      const { resource, version } = await versionParam(c as ApiContext);
      if (!version.deletedAt)
        throw new ApiError("conflict", "Remove it first; only removed versions can be purged.");
      await purgeVersion(deps, resource.row, version, actorId(c.get("caller")));
      return c.json({ ok: true });
    },
  );

  routes.patch(
    "/api/artifacts/:id/versions/:n",
    { action: "artifact.publish", resource: artifact },
    async (c) => {
      const { resource, version } = await versionParam(c as ApiContext);
      const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
      if (
        body === null ||
        !(typeof body.name === "string" || body.name === null) ||
        (body.name?.length ?? 0) > 120
      ) {
        throw new ApiError("invalid", "A name is up to 120 characters, or null.");
      }
      await db
        .update(versions)
        .set({ name: body.name as string | null })
        .where(eq(versions.id, version.id));
      await record(c as ApiContext, resource, "version_named", { version: version.n, name: body.name });
      return c.json({ ok: true });
    },
  );

  /** A copy of version n as the next version: same files, frames and blocks; threads re-anchor as usual. */
  routes.post(
    "/api/artifacts/:id/versions/:n/restore",
    { action: "artifact.publish", resource: artifact },
    async (c) => {
      const { resource, version } = await versionParam(c as ApiContext);
      if (version.deletedAt) throw new ApiError("conflict", "That version is removed. Bring it back first.");
      const caller = c.get("caller");
      const publisher = actorId(caller);
      if (!publisher) throw new ApiError("forbidden", "You can't publish.");
      const n = await db.transaction(async (tx) => {
        await tx.execute(LOCK(resource.id));
        const [current] = await tx.select().from(artifacts).where(eq(artifacts.id, resource.id)).limit(1);
        if (!current || current.deletedAt) throw new ApiError("conflict", "That artifact was just deleted.");
        if (current.archivedAt)
          throw new ApiError("read_only", "This artifact is archived, so it's read-only.");
        const next = current.latestVersion + 1;
        const id = Bun.randomUUIDv7();
        const now = clock.now();
        await tx.insert(versions).values({
          id,
          orgId: version.orgId,
          artifactId: resource.id,
          n: next,
          files: version.files,
          backendHash: version.backendHash,
          message: `Restored v${version.n}`,
          notes: {},
          summary: version.summary,
          tags: version.tags,
          publishedBy: publisher,
          restoredFrom: version.n,
          publishedAt: now,
        });
        const [pageRows, frameRows, blockRows] = await Promise.all([
          tx.select().from(pages).where(eq(pages.versionId, version.id)),
          tx.select().from(frames).where(eq(frames.versionId, version.id)),
          // By id: that's the order they were written in, and `read` and search's fallback depend on it.
          tx.select().from(blocks).where(eq(blocks.versionId, version.id)).orderBy(blocks.id),
        ]);
        if (pageRows.length > 0) {
          await tx
            .insert(pages)
            .values(pageRows.map((row) => ({ ...row, id: Bun.randomUUIDv7(), versionId: id })));
        }
        for (let i = 0; i < frameRows.length; i += 500) {
          await tx
            .insert(frames)
            .values(
              frameRows.slice(i, i + 500).map((row) => ({ ...row, id: Bun.randomUUIDv7(), versionId: id })),
            );
        }
        for (let i = 0; i < blockRows.length; i += 500) {
          await tx
            .insert(blocks)
            .values(
              blockRows.slice(i, i + 500).map((row) => ({ ...row, id: Bun.randomUUIDv7(), versionId: id })),
            );
        }
        await reanchorThreads(
          tx,
          resource.id,
          pageRows.map((row) => ({ key: row.pageKey })),
          frameRows,
          blockRows,
        );
        await tx
          .update(artifacts)
          .set({ latestVersion: next, hasBackend: version.backendHash !== null, updatedAt: now })
          .where(eq(artifacts.id, resource.id));
        return next;
      });
      await record(c as ApiContext, resource, "restored", { version: n, from: version.n });
      return c.json({ n });
    },
  );

  routes.get("/api/artifacts/:id/compare", { action: "artifact.read", resource: artifact }, async (c) => {
    const id = c.req.param("id") as string;
    const load = async (n: number) => {
      const [row] = await db
        .select()
        .from(versions)
        .where(and(eq(versions.artifactId, id), eq(versions.n, n), isNull(versions.deletedAt)))
        .limit(1);
      if (!row) throw new ApiError("not_found", "Not found.");
      const [frameRows, blockRows] = await Promise.all([
        db.select().from(frames).where(eq(frames.versionId, row.id)),
        db.select().from(blocks).where(eq(blocks.versionId, row.id)),
      ]);
      return { row, frameRows, blockRows };
    };
    const [from, to] = await Promise.all([
      load(Number(c.req.query("from"))),
      load(Number(c.req.query("to"))),
    ]);
    const changes = (before: Map<string, string>, after: Map<string, string>) => ({
      added: [...after.keys()].filter((key) => !before.has(key)),
      removed: [...before.keys()].filter((key) => !after.has(key)),
      changed: [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key)),
    });
    const frameMap = (rows: typeof from.frameRows) =>
      new Map(rows.map((row) => [`${row.pageKey}/${row.frameKey}`, row.contentHash]));
    const blockMap = (rows: typeof from.blockRows) =>
      new Map(rows.map((row) => [`${row.pageKey}/${row.blockKey}`, row.contentHash]));
    const frameChanges = changes(frameMap(from.frameRows), frameMap(to.frameRows));
    return etagJson(c, {
      frames: {
        ...frameChanges,
        regions: await changedRegions(
          deps,
          frameChanges.changed,
          from.frameRows,
          to.frameRows,
          callerKey(c.get("caller")) ?? deps.clientIp(c),
        ),
      },
      blocks: changes(blockMap(from.blockRows), blockMap(to.blockRows)),
      notes: to.row.notes,
    });
  });

  routes.get("/api/activity", { action: "home.read" }, async (c) => {
    const caller = c.get("caller");
    const orgId = c.get("org").id;
    const filter = c.req.query("filter") ?? "all";
    const before = c.req.query("before");
    const beforeDate = before ? new Date(before) : null;
    const rows = await db
      .select({
        row: activity,
        actor: people.name,
        guest: guests.id,
        title: artifacts.title,
        slug: artifacts.slug,
        project: projects.slug,
      })
      .from(activity)
      .leftJoin(people, eq(people.id, activity.actorPersonId))
      .leftJoin(guests, eq(guests.id, activity.actorGuestId))
      .leftJoin(artifacts, eq(artifacts.id, activity.artifactId))
      .leftJoin(projects, eq(projects.id, artifacts.projectId))
      .where(
        and(
          eq(activity.orgId, orgId),
          beforeDate && !Number.isNaN(beforeDate.getTime()) ? lt(activity.createdAt, beforeDate) : undefined,
          filter === "agents"
            ? isNotNull(activity.agent)
            : filter === "people"
              ? isNull(activity.agent)
              : undefined,
        ),
      )
      .orderBy(desc(activity.createdAt))
      .limit(200);

    // Only what this caller can see: a private artifact's activity mustn't reach anyone else.
    const seen = await findArtifacts(deps, orgId, [
      ...new Set(rows.flatMap(({ row }) => (row.artifactId ? [row.artifactId] : []))),
    ]);
    const visible: typeof rows = [];
    for (const entry of rows) {
      const id = entry.row.artifactId;
      if (!id) {
        if (
          ADMIN_ACTIVITY.includes(entry.row.kind) &&
          caller.kind === "person" &&
          ["owner", "admin"].includes(caller.person.role)
        ) {
          visible.push(entry);
        }
        continue;
      }
      const resource = seen.get(id);
      // Deletion hides the artifact, not its history: SPEC §5.5 wants the line in Activity.
      if (resource && seesArtifact(caller, resource)) visible.push(entry);
      if (visible.length === 50) break;
    }
    return etagJson(c, {
      items: visible.map(({ row, actor, title, slug, project }) => ({
        id: row.id,
        kind: row.kind,
        actor: (row.agent && actor ? agentLabel(actor, row.agent) : (row.agent ?? actor)) ?? "A guest",
        agent: row.agent && actor ? agentLabel(actor, row.agent) : row.agent,
        artifact: title ? { title, slug, project } : null,
        payload: row.payload,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length === 200 || visible.length === 50
          ? (visible.at(-1) ?? rows.at(-1))?.row.createdAt.toISOString()
          : null,
    });
  });
}
