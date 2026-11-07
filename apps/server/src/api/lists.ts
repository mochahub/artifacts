import type { Artifact, Home, SearchResults } from "@artifacts/schema";
import { Seen } from "@artifacts/schema";
import { and, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { heldProjects, type LoadedArtifact, toProject } from "../auth/access.ts";
import { type Caller, viewerId } from "../auth/caller.ts";
import { can, canAfterReauth } from "../auth/can.ts";
import { containing } from "../db/index.ts";
import {
  artifacts,
  artifactTeamAccess,
  comments,
  decisions,
  guestViews,
  pages,
  people,
  projectAccess,
  projects,
  teams,
  threads,
  versions,
  views,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { parseBody } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";
import { etagJson } from "../http/etag.ts";
import { artifactBySlug, artifactParam } from "../http/resources.ts";
import type { RouteRequest, Routes } from "../http/routes.ts";
import { buildCards } from "../library/cards.ts";
import { rateLimitSearch, searchHits, snippet } from "../library/search.ts";
import { visibleTo } from "../library/visible.ts";
import { changedSince, hashesOf } from "../versions/diff.ts";

const RESULTS = 20;
const MAX_POSITION_CHARS = 2000;

const visible = (deps: Deps, c: RouteRequest, projectId?: string) =>
  visibleTo(deps, c.var.org.id, c.var.caller, { projectId });

const CONTENT_SOURCES = ["block", "frame", "summary", "tag", "note"] as const;
const matches = (text: string, q: string | undefined) => !q || text.toLowerCase().includes(q.toLowerCase());

export function listRoutes(routes: Routes, deps: Deps) {
  const { db, clock } = deps;
  const artifactById = artifactParam(deps);

  /** Projects a team has, or holds an artifact in. It only ever narrows what the caller already sees. */
  async function teamProjects(orgId: string, caller: Caller, slug: string) {
    if (!can(caller, "team.read", { type: "org" })) return new Set<string>();
    const [direct, through] = await Promise.all([
      db
        .select({ id: projectAccess.projectId })
        .from(projectAccess)
        .innerJoin(teams, eq(teams.id, projectAccess.teamId))
        .where(and(eq(teams.orgId, orgId), eq(teams.slug, slug))),
      db
        .select({ id: artifacts.projectId })
        .from(artifactTeamAccess)
        .innerJoin(teams, eq(teams.id, artifactTeamAccess.teamId))
        .innerJoin(artifacts, eq(artifacts.id, artifactTeamAccess.artifactId))
        .where(and(eq(teams.orgId, orgId), eq(teams.slug, slug))),
    ]);
    return new Set([...direct, ...through].map((row) => row.id));
  }

  routes.get("/api/search", { action: "home.read" }, async (c) => {
    const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 100);
    if (q.length < 2) return c.json({ artifacts: [], pages: [], comments: [], content: [] });
    rateLimitSearch(deps, c.get("caller"));
    // SPEC 5.5: archived artifacts leave people's search. Agents ask for them through the library.
    const list = (await visible(deps, c)).filter((entry) => !entry.row.archivedAt);
    const known = new Map(list.map((entry) => [entry.row.id, entry]));
    const ids = [...known.keys()];
    if (ids.length === 0) return c.json({ artifacts: [], pages: [], comments: [], content: [] });
    const where = (entry: LoadedArtifact) => ({
      id: entry.row.id,
      project: entry.project.slug,
      slug: entry.row.slug,
      title: entry.row.title,
    });
    const like = containing(q);
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
        ...where(known.get(row.artifactId) as LoadedArtifact),
        pageKey: row.key,
        pageTitle: row.title,
      })),
      comments: commentRows.map((row) => ({
        ...where(known.get(row.artifactId) as LoadedArtifact),
        thread: row.thread,
        pageKey: row.pageKey,
        body: row.body.slice(0, 200),
        author: row.author,
      })),
      content: content.map((hit) => ({
        ...where(known.get(hit.artifactId) as LoadedArtifact),
        source: hit.source,
        pageKey: hit.page,
        ref: hit.ref,
        snippet: snippet(hit.text, q),
      })),
    } satisfies SearchResults);
  });

  routes.get("/api/home", { action: "home.read" }, async (c) => {
    const list = await visible(deps, c);
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
    const list = await visible(deps, c);
    const cards = await buildCards(deps, c.get("caller"), list);
    const orgId = c.get("org").id;
    const held = await heldProjects(deps, orgId, c.get("caller"));
    const projectIds = [...new Set(list.map(({ row }) => row.projectId))];
    const seen = projectIds.length
      ? await db.select().from(projects).where(inArray(projects.id, projectIds))
      : [];
    // A grant shows a project before anything in it is visible, or a new grantee couldn't reach it.
    const merged = [...seen, ...held.filter((row) => !projectIds.includes(row.id))];
    const team = c.req.query("team");
    const onTeam = team ? await teamProjects(orgId, c.get("caller"), team) : null;
    const rows = onTeam ? merged.filter((row) => onTeam.has(row.id)) : merged;
    const q = c.req.query("q");
    const sort = c.req.query("sort") === "name" ? "name" : "recent";
    const body = rows
      .filter((row) => matches(row.name, q) || matches(row.slug, q))
      .map((row) => {
        const own = list.filter((entry) => entry.row.projectId === row.id);
        const live = own.filter((entry) => !entry.row.archivedAt);
        const updated = own.reduce(
          (latest, entry) => Math.max(latest, entry.row.updatedAt.getTime()),
          own.length === 0 ? row.updatedAt.getTime() : 0,
        );
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
          restricted: row.restricted,
          kind: row.kind,
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
    const list = project ? await visible(deps, c, project.id) : [];
    const place = project ? await toProject(deps, project) : null;
    const caller = c.get("caller");
    const holder = "person" in caller && place?.grants.some((row) => row.personId === caller.person.id);
    if (!project || !place || (list.length === 0 && !holder)) throw new ApiError("not_found", "Not found.");
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
      project: {
        slug: project.slug,
        name: project.name,
        repo: project.repo,
        restricted: project.restricted,
        kind: project.kind,
        canShare: can(caller, "project.access.read", place),
      },
      artifacts: cards,
    });
  });

  async function detail(caller: Caller, resource: LoadedArtifact): Promise<Artifact> {
    const { row, project } = resource;
    const [card] = await buildCards(deps, caller, [resource]);
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
    // A page has changed if anything on it is new or different since the version before.
    const changed = new Set<string>();
    if (latest && previous) {
      const [before, after] = await Promise.all([hashesOf(db, previous.id), hashesOf(db, latest.id)]);
      for (const kind of ["frames", "blocks"] as const) {
        for (const [key, hash] of after[kind]) {
          if (changedSince(before[kind], key, hash)) changed.add(key.slice(0, key.indexOf("/")));
        }
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
      projectName: project.name,
      projectKind: project.kind,
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
        purge: canAfterReauth(caller, "artifact.purge", resource),
      },
    };
    return body;
  }

  routes.get(
    "/api/artifacts/by-slug/:project/:slug",
    { action: "artifact.read", resource: artifactBySlug(deps), page: true },
    async (c) => etagJson(c, await detail(c.var.caller, c.var.resource)),
  );

  routes.get(
    "/api/artifacts/:id",
    { action: "artifact.read", resource: artifactById, page: true },
    async (c) => etagJson(c, await detail(c.var.caller, c.var.resource)),
  );

  routes.post("/api/artifacts/:id/seen", { action: "artifact.read", resource: artifactById }, async (c) => {
    const body = await parseBody(c, Seen);
    const { resource } = c.var;
    const artifactId = resource.id;
    const orgId = c.var.org.id;
    const who = viewerId(c.var.caller);
    const now = clock.now();
    // Nobody has seen a version that doesn't exist yet, so it can't be marked seen in advance.
    const version = Math.min(body.version, resource.row.latestVersion);
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
