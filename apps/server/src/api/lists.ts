import type { Artifact, ArtifactCard, Home } from "@artifacts/schema";
import { Seen } from "@artifacts/schema";
import { and, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import type { Caller } from "../auth/caller.ts";
import { type ArtifactResource, can } from "../auth/can.ts";
import { callerKey } from "../data/store.ts";
import {
  artifacts,
  blocks,
  comments,
  decisions,
  frames,
  guestViews,
  pages,
  people,
  projects,
  threads,
  versions,
  views,
} from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { etagJson } from "../http/etag.ts";
import { rateLimitSearch, searchHits, snippet } from "../library/search.ts";
import { type Loaded, visibleTo } from "../library/visible.ts";
import { type ArtifactRow, artifactParam, toResource } from "./artifacts-db.ts";
import type { Deps } from "./deps.ts";
import { type ApiContext, parseBody, type Routes } from "./routes.ts";

const viewerId = (caller: Caller) =>
  caller.kind === "person" || caller.kind === "cliToken"
    ? { person: caller.person.id }
    : caller.kind === "guest"
      ? { guest: caller.guestId }
      : {};

const RESULTS = 20;
const MAX_POSITION_CHARS = 2000;

const visible = (deps: Deps, c: ApiContext, projectId?: string) =>
  visibleTo(deps, c.get("org").id, c.get("caller"), { projectId });

/** Status, counts and cover for a set of artifacts, in as few queries as possible (02, "Derived state"). */
export async function buildCards(deps: Deps, caller: Caller, list: Loaded[]): Promise<ArtifactCard[]> {
  if (list.length === 0) return [];
  const { db } = deps;
  const ids = list.map(({ row }) => row.id);
  const who = viewerId(caller);

  const [versionRows, decisionRows, threadRows, viewRows, pageCounts] = await Promise.all([
    db
      .select({
        id: versions.id,
        artifactId: versions.artifactId,
        n: versions.n,
        agent: versions.agent,
        publishedAt: versions.publishedAt,
        publisher: people.name,
      })
      .from(versions)
      .innerJoin(people, eq(people.id, versions.publishedBy))
      .where(and(inArray(versions.artifactId, ids), isNull(versions.deletedAt)))
      .orderBy(desc(versions.n)),
    db.select().from(decisions).where(inArray(decisions.artifactId, ids)).orderBy(desc(decisions.createdAt)),
    db
      .select({
        id: threads.id,
        artifactId: threads.artifactId,
        status: threads.status,
        person: threads.authorPersonId,
        guest: threads.authorGuestId,
      })
      .from(threads)
      .where(inArray(threads.artifactId, ids)),
    who.person
      ? db
          .select({
            artifactId: views.artifactId,
            lastSeenVersion: views.lastSeenVersion,
            lastSeenAt: views.lastSeenAt,
          })
          .from(views)
          .where(and(eq(views.personId, who.person), inArray(views.artifactId, ids)))
      : who.guest
        ? db
            .select({
              artifactId: guestViews.artifactId,
              lastSeenVersion: guestViews.lastSeenVersion,
              lastSeenAt: guestViews.lastSeenAt,
            })
            .from(guestViews)
            .where(and(eq(guestViews.guestId, who.guest), inArray(guestViews.artifactId, ids)))
        : Promise.resolve([]),
    db
      .select({ versionId: pages.versionId, count: sql<number>`count(*)::int` })
      .from(pages)
      .innerJoin(versions, eq(versions.id, pages.versionId))
      .where(inArray(versions.artifactId, ids))
      .groupBy(pages.versionId),
  ]);

  const latestByArtifact = new Map<string, (typeof versionRows)[number][]>();
  for (const version of versionRows) {
    latestByArtifact.set(version.artifactId, [...(latestByArtifact.get(version.artifactId) ?? []), version]);
  }
  const heads = list.flatMap(({ row }) => latestByArtifact.get(row.id)?.slice(0, 2) ?? []);
  const frameRows = heads.length
    ? await db
        .select({
          versionId: frames.versionId,
          key: frames.frameKey,
          hash: frames.contentHash,
          renders: frames.renders,
          y: frames.y,
          x: frames.x,
        })
        .from(frames)
        .where(
          inArray(
            frames.versionId,
            heads.map((version) => version.id),
          ),
        )
    : [];

  const replies = new Map<string, number>();
  const mine = threadRows.filter(
    (t) => (who.person && t.person === who.person) || (who.guest && t.guest === who.guest),
  );
  if (mine.length > 0) {
    const replyRows = await db
      .select({
        threadId: comments.threadId,
        createdAt: comments.createdAt,
        person: comments.authorPersonId,
        agent: comments.agent,
        guest: comments.authorGuestId,
      })
      .from(comments)
      .where(
        inArray(
          comments.threadId,
          mine.map((t) => t.id),
        ),
      );
    for (const thread of mine) {
      const seenAt = viewRows.find((row) => row.artifactId === thread.artifactId)?.lastSeenAt ?? new Date(0);
      const count = replyRows.filter(
        (reply) =>
          reply.threadId === thread.id &&
          reply.createdAt > seenAt &&
          (reply.agent !== null || (who.person ? reply.person !== who.person : reply.guest !== who.guest)),
      ).length;
      replies.set(thread.artifactId, (replies.get(thread.artifactId) ?? 0) + count);
    }
  }

  return list.flatMap(({ row, projectSlug }) => {
    const [latest, previous] = latestByArtifact.get(row.id) ?? [];
    if (!latest) return [];
    const decision = decisionRows.find((entry) => entry.artifactId === row.id);
    const view = viewRows.find((entry) => entry.artifactId === row.id);
    const unseen = latest.n > (view?.lastSeenVersion ?? 0) || (replies.get(row.id) ?? 0) > 0;

    let status: ArtifactCard["status"];
    if (decision?.kind === "approved" && decision.version === latest.n) {
      status = { kind: "approved", version: latest.n };
    } else if (decision?.kind === "changes_requested" && decision.createdAt > latest.publishedAt) {
      status = { kind: "with_agent", agent: latest.agent ?? latest.publisher };
    } else if (unseen) status = { kind: "waiting" };
    else status = { kind: "not_reviewed" };

    const own = frameRows.filter((frame) => frame.versionId === latest.id);
    const old = previous ? frameRows.filter((frame) => frame.versionId === previous.id) : [];
    const before = new Map(old.map((frame) => [frame.key, frame.hash]));
    const changedFrames = previous
      ? own.filter((frame) => before.get(frame.key) !== undefined && before.get(frame.key) !== frame.hash)
          .length
      : 0;
    const first = [...own].sort((a, b) => a.y - b.y || a.x - b.x)[0];
    return [
      {
        id: row.id,
        project: projectSlug,
        slug: row.slug,
        title: row.title,
        cover: first ? { renderHash: (first.renders as { thumb: string }).thumb } : { title: row.title },
        pageCount: pageCounts.find((entry) => entry.versionId === latest.id)?.count ?? 0,
        latestVersion: latest.n,
        status,
        counts: {
          open: threadRows.filter((t) => t.artifactId === row.id && t.status === "open").length,
          repliesToYou: replies.get(row.id) ?? 0,
          changedFrames,
        },
        publishedBy: latest.publisher,
        agent: latest.agent,
        publishedAt: latest.publishedAt.toISOString(),
        archivedAt: row.archivedAt?.toISOString() ?? null,
      },
    ];
  });
}

const CONTENT_SOURCES = ["block", "frame", "summary", "tag", "note"] as const;
const matches = (text: string, q: string | undefined) => !q || text.toLowerCase().includes(q.toLowerCase());

export function listRoutes(routes: Routes, deps: Deps) {
  const { db, clock } = deps;
  const artifactById = artifactParam(deps);

  routes.get("/api/search", { action: "home.read" }, async (c) => {
    const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 100);
    if (q.length < 2) return c.json({ artifacts: [], pages: [], comments: [], content: [] });
    rateLimitSearch(deps, c.get("caller"));
    // SPEC 5.5: archived artifacts leave people's search. Agents ask for them through the library.
    const list = (await visible(deps, c as ApiContext)).filter((entry) => !entry.row.archivedAt);
    const known = new Map(list.map((entry) => [entry.row.id, entry]));
    const ids = [...known.keys()];
    if (ids.length === 0) return c.json({ artifacts: [], pages: [], comments: [], content: [] });
    const where = (entry: Loaded) => ({
      id: entry.row.id,
      project: entry.projectSlug,
      slug: entry.row.slug,
      title: entry.row.title,
    });
    const like = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const [pageRows, commentRows, content] = await Promise.all([
      deps.db
        .select({ artifactId: versions.artifactId, n: versions.n, key: pages.pageKey, title: pages.title })
        .from(pages)
        .innerJoin(versions, eq(versions.id, pages.versionId))
        .innerJoin(artifacts, eq(artifacts.id, versions.artifactId))
        .where(
          and(
            inArray(versions.artifactId, ids),
            eq(versions.n, artifacts.latestVersion),
            ilike(pages.title, like),
          ),
        )
        .limit(RESULTS),
      deps.db
        .select({
          thread: threads.n,
          pageKey: threads.pageKey,
          artifactId: threads.artifactId,
          body: comments.body,
          author: comments.authorName,
        })
        .from(comments)
        .innerJoin(threads, eq(threads.id, comments.threadId))
        .where(and(inArray(threads.artifactId, ids), ilike(comments.body, like)))
        .orderBy(desc(comments.createdAt))
        .limit(RESULTS),
      // Words in the work itself, which the title and comment searches above can't see.
      searchHits(deps, { ids, q, limit: RESULTS, offset: 0, sources: CONTENT_SOURCES }),
    ]);
    return c.json({
      artifacts: list
        .filter((entry) => entry.row.title.toLowerCase().includes(q) || entry.row.slug.includes(q))
        .slice(0, RESULTS)
        .map(where),
      pages: pageRows.map((row) => ({
        ...where(known.get(row.artifactId) as Loaded),
        pageKey: row.key,
        pageTitle: row.title,
      })),
      comments: commentRows.map((row) => ({
        ...where(known.get(row.artifactId) as Loaded),
        thread: row.thread,
        pageKey: row.pageKey,
        body: row.body.slice(0, 200),
        author: row.author,
      })),
      content: content.map((hit) => ({
        ...where(known.get(hit.artifactId) as Loaded),
        source: hit.source,
        pageKey: hit.page,
        ref: hit.ref,
        snippet: snippet(hit.text, q),
      })),
    });
  });

  routes.get("/api/home", { action: "home.read" }, async (c) => {
    const list = await visible(deps, c as ApiContext);
    const caller = c.get("caller");
    const cards = (await buildCards(deps, caller, list)).filter((card) => !card.archivedAt);
    const who = viewerId(caller);
    const seen = who.person
      ? await db
          .select({ artifactId: views.artifactId })
          .from(views)
          .where(eq(views.personId, who.person))
          .orderBy(desc(views.lastSeenAt))
          .limit(20)
      : [];
    const body: Home = {
      waiting: cards.filter((card) => card.status.kind === "waiting"),
      recent: seen.flatMap(({ artifactId }) => cards.filter((card) => card.id === artifactId)),
    };
    return etagJson(c, body);
  });

  routes.get("/api/projects", { action: "project.list" }, async (c) => {
    const list = await visible(deps, c as ApiContext);
    const cards = await buildCards(deps, c.get("caller"), list);
    const projectIds = [...new Set(list.map(({ row }) => row.projectId))];
    const rows = projectIds.length
      ? await db.select().from(projects).where(inArray(projects.id, projectIds))
      : [];
    const q = c.req.query("q");
    const sort = c.req.query("sort") === "name" ? "name" : "recent";
    const body = rows
      .filter((row) => matches(row.name, q) || matches(row.slug, q))
      .map((row) => {
        const own = list.filter((entry) => entry.row.projectId === row.id);
        const live = own.filter((entry) => !entry.row.archivedAt);
        const updated = own.reduce((latest, entry) => Math.max(latest, entry.row.updatedAt.getTime()), 0);
        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          repo: row.repo,
          artifactCount: live.length,
          openCount: cards
            .filter((card) => live.some((entry) => entry.row.id === card.id))
            .reduce((sum, card) => sum + card.counts.open, 0),
          updatedAt: new Date(updated).toISOString(),
        };
      })
      .sort((a, b) =>
        sort === "name" ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt),
      );
    return etagJson(c, body);
  });

  routes.get("/api/projects/:slug/artifacts", { action: "project.read" }, async (c) => {
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.orgId, c.get("org").id), eq(projects.slug, c.req.param("slug") as string)))
      .limit(1);
    const list = project ? await visible(deps, c as ApiContext, project.id) : [];
    if (!project || list.length === 0) throw new ApiError("not_found", "Not found.");
    const status = c.req.query("status") ?? "all";
    const q = c.req.query("q");
    const cards = (await buildCards(deps, c.get("caller"), list))
      .filter((card) => matches(card.title, q))
      .filter((card) => {
        if (status === "archived") return card.archivedAt !== null;
        if (card.archivedAt) return false;
        if (status === "your_turn") return card.status.kind === "waiting";
        if (status === "approved") return card.status.kind === "approved";
        return true;
      })
      .sort((a, b) =>
        c.req.query("sort") === "name"
          ? a.title.localeCompare(b.title)
          : b.publishedAt.localeCompare(a.publishedAt),
      );
    return etagJson(c, {
      project: { slug: project.slug, name: project.name, repo: project.repo },
      artifacts: cards,
    });
  });

  async function detail(c: ApiContext, row: ArtifactRow, resource: ArtifactResource) {
    const caller = c.get("caller");
    const [project] = await db.select().from(projects).where(eq(projects.id, row.projectId)).limit(1);
    const [card] = await buildCards(deps, caller, [{ row, resource, projectSlug: project?.slug ?? "" }]);
    if (!card) throw new ApiError("not_found", "Not found.");

    const versionList = await db
      .select({ id: versions.id, n: versions.n })
      .from(versions)
      .where(and(eq(versions.artifactId, row.id), isNull(versions.deletedAt)))
      .orderBy(desc(versions.n))
      .limit(2);
    const [latest, previous] = versionList;
    const pageRows = latest
      ? await db.select().from(pages).where(eq(pages.versionId, latest.id)).orderBy(pages.position)
      : [];
    const openThreads = await db
      .select({ pageKey: threads.pageKey })
      .from(threads)
      .where(and(eq(threads.artifactId, row.id), eq(threads.status, "open")));
    const changed = new Set<string>();
    if (latest && previous) {
      const hashes = async (versionId: string) => {
        const [frameRows, blockRows] = await Promise.all([
          db
            .select({ page: frames.pageKey, key: frames.frameKey, hash: frames.contentHash })
            .from(frames)
            .where(eq(frames.versionId, versionId)),
          db
            .select({ page: blocks.pageKey, key: blocks.blockKey, hash: blocks.contentHash })
            .from(blocks)
            .where(eq(blocks.versionId, versionId)),
        ]);
        return [...frameRows, ...blockRows];
      };
      const before = new Map(
        (await hashes(previous.id)).map((entry) => [`${entry.page}/${entry.key}`, entry.hash]),
      );
      for (const entry of await hashes(latest.id)) {
        if (before.get(`${entry.page}/${entry.key}`) !== entry.hash) changed.add(entry.page);
      }
    }
    const [decision] = await db
      .select({ row: decisions, by: people.name })
      .from(decisions)
      .innerJoin(people, eq(people.id, decisions.personId))
      .where(eq(decisions.artifactId, row.id))
      .orderBy(desc(decisions.createdAt))
      .limit(1);

    const body: Artifact = {
      ...card,
      visibility: row.visibility,
      publisherId: row.publisherId,
      hasBackend: row.hasBackend,
      pages: pageRows.map((page) => ({
        key: page.pageKey,
        kind: page.kind,
        title: page.title,
        group: page.group,
        changed: changed.has(page.pageKey),
        open: openThreads.filter((thread) => thread.pageKey === page.pageKey).length,
      })),
      decision: decision
        ? {
            kind: decision.row.kind,
            note: decision.row.note,
            version: decision.row.version,
            by: decision.by,
            at: decision.row.createdAt.toISOString(),
          }
        : null,
      permissions: {
        comment: can(caller, "artifact.comment", resource),
        decide: can(caller, "artifact.decide", resource),
        manage: can(caller, "artifact.manage", resource),
        share: can(caller, "artifact.share", resource),
        delete: can(caller, "artifact.delete", resource),
        purge: can(
          { ...caller, ...(caller.kind === "person" ? { recentAuth: true } : {}) },
          "artifact.purge",
          resource,
        ),
      },
    };
    return etagJson(c, body);
  }

  /** 410 only for someone who could see it; everyone else gets the same 404 as for nothing (04). */
  function goneIfDeleted(c: ApiContext, resource: ArtifactResource) {
    if (!resource.deletedAt) return;
    if (can(c.get("caller"), "artifact.read", { ...resource, deletedAt: null, deletedBy: null })) {
      throw new ApiError("gone", "This artifact was deleted.", {
        deletedAt: resource.deletedAt.toISOString(),
      });
    }
    throw new ApiError("not_found", "Not found.");
  }

  routes.get(
    "/api/artifacts/by-slug/:project/:slug",
    { action: "artifact.read", inHandler: true },
    async (c) => {
      if (c.get("caller").kind === "anonymous") throw new ApiError("unauthenticated", "Sign in first.");
      const orgId = c.get("org").id;
      const [row] = await db
        .select({ row: artifacts })
        .from(artifacts)
        .innerJoin(projects, eq(projects.id, artifacts.projectId))
        .where(
          and(
            eq(artifacts.orgId, orgId),
            eq(projects.slug, c.req.param("project") as string),
            eq(artifacts.slug, c.req.param("slug") as string),
          ),
        )
        .limit(1);
      if (!row) throw new ApiError("not_found", "Not found.");
      const resource = await toResource(deps, row.row);
      goneIfDeleted(c as ApiContext, resource);
      if (!can(c.get("caller"), "artifact.read", resource)) throw new ApiError("not_found", "Not found.");
      return detail(c as ApiContext, row.row, resource);
    },
  );

  routes.get("/api/artifacts/:id", { action: "artifact.read", inHandler: true }, async (c) => {
    if (c.get("caller").kind === "anonymous") throw new ApiError("unauthenticated", "Sign in first.");
    const resource = await artifactById(c as ApiContext);
    goneIfDeleted(c as ApiContext, resource);
    if (!can(c.get("caller"), "artifact.read", resource)) throw new ApiError("not_found", "Not found.");
    return detail(c as ApiContext, resource.row, resource);
  });

  routes.post("/api/artifacts/:id/seen", { action: "artifact.read", resource: artifactById }, async (c) => {
    const body = await parseBody(c, Seen);
    const artifactId = c.req.param("id") as string;
    const orgId = c.get("org").id;
    const who = viewerId(c.get("caller"));
    const now = clock.now();
    // Nobody has seen a version that doesn't exist yet, so it can't be marked seen in advance.
    const version = Math.min(body.version, (await artifactById(c as ApiContext)).row.latestVersion);
    // A position is kept only for a page the artifact has, and small, so the row can't be filled with junk.
    const [page] = body.pageKey
      ? await db
          .select({ key: pages.pageKey })
          .from(pages)
          .innerJoin(versions, eq(versions.id, pages.versionId))
          .where(and(eq(versions.artifactId, artifactId), eq(pages.pageKey, body.pageKey)))
          .limit(1)
      : [];
    const position =
      page && JSON.stringify(body.position ?? null).length <= MAX_POSITION_CHARS
        ? { [page.key]: body.position ?? null }
        : {};
    const merge = (column: unknown) => sql`${column} || ${JSON.stringify(position)}::jsonb`;
    if (who.person) {
      await db
        .insert(views)
        .values({
          personId: who.person,
          orgId,
          artifactId,
          lastSeenVersion: version,
          lastSeenAt: now,
          positions: position,
        })
        .onConflictDoUpdate({
          target: [views.personId, views.artifactId],
          set: {
            lastSeenVersion: sql`greatest(${views.lastSeenVersion}, ${version})`,
            lastSeenAt: now,
            positions: merge(views.positions),
          },
        });
    } else if (who.guest) {
      await db
        .insert(guestViews)
        .values({
          guestId: who.guest,
          orgId,
          artifactId,
          lastSeenVersion: version,
          lastSeenAt: now,
          positions: position,
        })
        .onConflictDoUpdate({
          target: [guestViews.guestId, guestViews.artifactId],
          set: {
            lastSeenVersion: sql`greatest(${guestViews.lastSeenVersion}, ${version})`,
            lastSeenAt: now,
            positions: merge(guestViews.positions),
          },
        });
    }
    return c.json({ ok: true });
  });
}
