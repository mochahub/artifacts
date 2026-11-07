import type {
  ActivityKind,
  ActivityPage,
  Compare,
  DeletedList,
  DeleteResult,
  RestoreResult,
} from "@artifacts/schema";
import { AGENT_MAX, agentLabel, DAY_MS, NameVersion, PURGE_DAYS, VERSION_NAME_MAX } from "@artifacts/schema";
import { and, asc, desc, eq, gt, isNotNull, isNull, lt } from "drizzle-orm";
import { findArtifacts, type LoadedArtifact } from "../auth/access.ts";
import { actorOf, agentOf, type Caller, callerKey } from "../auth/caller.ts";
import { type CallerFor, seesArtifact } from "../auth/can.ts";
import { lockArtifact } from "../db/locks.ts";
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
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { etagJson } from "../http/etag.ts";
import { artifactParam } from "../http/resources.ts";
import type { RouteRequest, Routes } from "../http/routes.ts";
import { purgeArtifact, purgeVersion } from "../jobs/purge.ts";
import { reanchorThreads } from "../review/reanchor.ts";
import { createComparer } from "../versions/compare.ts";
import { writeContent } from "../versions/content.ts";
import { blockHashes, changes, frameHashes } from "../versions/diff.ts";

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
  const changedRegions = createComparer(deps);

  const record = async (
    c: RouteRequest<CallerFor<"artifact.publish">, LoadedArtifact>,
    kind: ActivityKind,
    payload: Record<string, unknown> = {},
  ) => {
    const { caller, resource: row } = c.var;
    await db.insert(activity).values({
      id: Bun.randomUUIDv7(),
      orgId: c.var.org.id,
      artifactId: row.id,
      projectId: row.projectId,
      actorPersonId: actorOf(caller),
      agent: agentOf(caller, c.req.header("artifacts-agent")?.slice(0, AGENT_MAX)),
      kind,
      payload,
      createdAt: clock.now(),
    });
    void deps.events.emit(row.id, "version");
  };

  const setArchived = async (
    c: RouteRequest<CallerFor<"artifact.archive">, LoadedArtifact>,
    archived: boolean,
  ) => {
    const { resource, caller } = c.var;
    await db.transaction(async (tx) => {
      await lockArtifact(tx, resource.id, "content");
      await tx
        .update(artifacts)
        .set(
          archived
            ? { archivedAt: clock.now(), archivedBy: caller.person.id }
            : { archivedAt: null, archivedBy: null },
        )
        .where(eq(artifacts.id, resource.id));
    });
    await record(c, archived ? "archived" : "unarchived");
  };
  routes.post("/api/artifacts/:id/archive", { action: "artifact.archive", resource: artifact }, async (c) => {
    await setArchived(c, true);
    return c.json({ ok: true });
  });
  routes.post(
    "/api/artifacts/:id/unarchive",
    { action: "artifact.archive", resource: artifact },
    async (c) => {
      await setArchived(c, false);
      return c.json({ ok: true });
    },
  );

  routes.post("/api/artifacts/:id/delete", { action: "artifact.delete", resource: artifact }, async (c) => {
    const resource = c.var.resource;
    if (resource.deletedAt) throw new ApiError("conflict", "It's already in Recently deleted.");
    const now = clock.now();
    const purgeAfter = new Date(now.getTime() + PURGE_DAYS * DAY_MS);
    await db.transaction(async (tx) => {
      await lockArtifact(tx, resource.id, "content");
      await tx
        .update(artifacts)
        .set({ deletedAt: now, deletedBy: c.var.caller.person.id, purgeAfter })
        .where(eq(artifacts.id, resource.id));
    });
    await record(c, "deleted", { title: resource.row.title });
    return c.json({ purgeAfter: purgeAfter.toISOString() } satisfies DeleteResult);
  });

  routes.post("/api/artifacts/:id/undelete", { action: "artifact.delete", resource: artifact }, async (c) => {
    const resource = c.var.resource;
    if (!resource.deletedAt) throw new ApiError("conflict", "It isn't in Recently deleted.");
    await db.transaction(async (tx) => {
      await lockArtifact(tx, resource.id, "content");
      await tx
        .update(artifacts)
        .set({ deletedAt: null, deletedBy: null, purgeAfter: null })
        .where(eq(artifacts.id, resource.id));
    });
    await record(c, "undeleted");
    return c.json({ ok: true });
  });

  routes.delete(
    "/api/artifacts/:id",
    { action: "artifact.purge", resource: artifact, recentAuth: true },
    async (c) => {
      const { resource, caller } = c.var;
      if (!resource.deletedAt)
        throw new ApiError("conflict", "Delete it first; only Recently deleted can be purged.");
      await purgeArtifact(deps, resource.row, caller.person.id);
      return c.json({ ok: true });
    },
  );

  routes.get("/api/deleted", { action: "deleted.read" }, async (c) => {
    const orgId = c.var.org.id;
    const mine = c.var.caller.person;
    const admin = mine.role === "owner" || mine.role === "admin";
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
            admin ? undefined : eq(artifacts.deletedBy, mine.id),
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
            admin ? undefined : eq(versions.deletedBy, mine.id),
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
    ] satisfies DeletedList);
  });

  /** Version :n, after the guard: who can't act on the artifact never learns which versions it has. */
  async function versionParam(c: RouteRequest<Caller, LoadedArtifact>) {
    const resource = c.var.resource;
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
      const { resource, version } = await versionParam(c);
      if (version.deletedAt) throw new ApiError("conflict", "That version is already removed.");
      if (version.n === resource.row.latestVersion) {
        throw new ApiError("conflict", "The latest version can't be removed. Publish a fix first.");
      }
      const now = clock.now();
      const purgeAfter = new Date(now.getTime() + PURGE_DAYS * DAY_MS);
      await db.transaction(async (tx) => {
        await lockArtifact(tx, resource.id, "content");
        await tx
          .update(versions)
          .set({ deletedAt: now, deletedBy: c.var.caller.person.id, purgeAfter })
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
      await record(c, "version_deleted", { version: version.n });
      return c.json({ purgeAfter: purgeAfter.toISOString() } satisfies DeleteResult);
    },
  );

  routes.post(
    "/api/artifacts/:id/versions/:n/undelete",
    { action: "artifact.delete", resource: artifact },
    async (c) => {
      const { resource, version } = await versionParam(c);
      if (!version.deletedAt) throw new ApiError("conflict", "That version isn't removed.");
      await db.transaction(async (tx) => {
        await lockArtifact(tx, resource.id, "content");
        await tx
          .update(versions)
          .set({ deletedAt: null, deletedBy: null, purgeAfter: null })
          .where(eq(versions.id, version.id));
      });
      await record(c, "version_undeleted", { version: version.n });
      return c.json({ ok: true });
    },
  );

  routes.delete(
    "/api/artifacts/:id/versions/:n",
    { action: "artifact.purge", resource: artifact, recentAuth: true },
    async (c) => {
      const { resource, version } = await versionParam(c);
      if (!version.deletedAt)
        throw new ApiError("conflict", "Remove it first; only removed versions can be purged.");
      await purgeVersion(deps, resource.row, version, c.var.caller.person.id);
      return c.json({ ok: true });
    },
  );

  routes.patch(
    "/api/artifacts/:id/versions/:n",
    { action: "artifact.publish", resource: artifact },
    async (c) => {
      const { version } = await versionParam(c);
      const body = NameVersion.safeParse(await c.req.json().catch(() => null));
      if (!body.success) {
        throw new ApiError("invalid", `A name is up to ${VERSION_NAME_MAX} characters, or null.`);
      }
      const { name } = body.data;
      await db.update(versions).set({ name }).where(eq(versions.id, version.id));
      await record(c, "version_named", { version: version.n, name });
      return c.json({ ok: true });
    },
  );

  /** A copy of version n as the next version: same files, frames and blocks; threads re-anchor as usual. */
  routes.post(
    "/api/artifacts/:id/versions/:n/restore",
    { action: "artifact.publish", resource: artifact },
    async (c) => {
      const { resource, version } = await versionParam(c);
      if (version.deletedAt) throw new ApiError("conflict", "That version is removed. Bring it back first.");
      const publisher = actorOf(c.var.caller);
      const n = await db.transaction(async (tx) => {
        await lockArtifact(tx, resource.id, "content");
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
          wiki: version.wiki,
          links: version.links,
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
        await writeContent(
          tx,
          version.orgId,
          id,
          pageRows.map(({ pageKey, kind, title, group, position, meta }) => ({
            key: pageKey,
            kind,
            title,
            group,
            position,
            meta,
          })),
          frameRows,
          blockRows,
        );
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
      await record(c, "restored", { version: n, from: version.n });
      return c.json({ n } satisfies RestoreResult);
    },
  );

  routes.get("/api/artifacts/:id/compare", { action: "artifact.read", resource: artifact }, async (c) => {
    const { id } = c.var.resource;
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
    const frameChanges = changes(frameHashes(from.frameRows), frameHashes(to.frameRows));
    return etagJson(c, {
      frames: {
        ...frameChanges,
        regions: await changedRegions(
          frameChanges.changed,
          from.frameRows,
          to.frameRows,
          callerKey(c.var.caller) ?? deps.clientIp(c),
        ),
      },
      blocks: changes(blockHashes(from.blockRows), blockHashes(to.blockRows)),
      notes: to.row.notes,
    } satisfies Compare);
  });

  routes.get("/api/activity", { action: "home.read" }, async (c) => {
    const { caller } = c.var;
    const orgId = c.var.org.id;
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
        artifact: title && slug && project ? { title, slug, project } : null,
        payload: row.payload,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length === 200 || visible.length === 50
          ? ((visible.at(-1) ?? rows.at(-1))?.row.createdAt.toISOString() ?? null)
          : null,
    } satisfies ActivityPage);
  });
}
