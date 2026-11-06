import {
  LIBRARY_PAGE,
  LIBRARY_PAGE_MAX,
  type LibraryFrames,
  type LibraryPage,
  type LibraryPages,
  type LibraryProjects,
  normalizeRepo,
} from "@artifacts/schema";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { findArtifactBySlug, heldProjects, type LoadedArtifact } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { blocks, frames, pages, projects } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { libraryCards } from "./cards.ts";
import { liveVersion } from "./read.ts";
import { rateLimitSearch, searchHits, snippet } from "./search.ts";
import { visibleTo } from "./visible.ts";

const MAX_OFFSET = 100_000;

/** A window of a list. The cursor is opaque to callers, and nothing about who can see what is in it. */
function paging(limit: string | undefined, cursor: string | undefined) {
  const size = limit === undefined ? LIBRARY_PAGE : Number(limit);
  if (!Number.isInteger(size) || size < 1) throw new ApiError("invalid", "limit must be a whole number.");
  let offset = 0;
  if (cursor) {
    const decoded = Buffer.from(cursor, "base64url").toString();
    offset = /^\d{1,6}$/.test(decoded) ? Number(decoded) : -1;
    if (offset < 0 || offset > MAX_OFFSET) throw new ApiError("invalid", "That cursor isn't valid.");
  }
  return { limit: Math.min(size, LIBRARY_PAGE_MAX), offset };
}
const nextCursor = (offset: number, limit: number, more: boolean) =>
  more ? Buffer.from(String(offset + limit)).toString("base64url") : null;

export type LibraryScope = { project?: string; repo?: string };

/** The projects a `project` or `repo` narrows a search to, or undefined for all of them. */
async function scopedProjects(deps: Deps, orgId: string, scope: LibraryScope) {
  if (!scope.project && !scope.repo) return undefined;
  const repo = normalizeRepo(scope.repo);
  if (scope.repo && !repo) throw new ApiError("invalid", "That isn't a git remote.");
  const rows = await deps.db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.orgId, orgId),
        scope.project ? eq(projects.slug, scope.project) : undefined,
        repo ? sql`lower(${projects.repo}) = ${repo}` : undefined,
      ),
    );
  return rows.map((row) => row.id);
}

export type SearchInput = LibraryScope & {
  q: string;
  tag?: string;
  archived?: boolean;
  limit?: string;
  cursor?: string;
};

/** The functions below are what both the routes here and the hosted MCP call, so they can't drift. */
export async function librarySearch(deps: Deps, orgId: string, caller: Caller, input: SearchInput) {
  const q = input.q.trim().slice(0, 200);
  const { limit, offset } = paging(input.limit, input.cursor);
  if (q.length < 2) throw new ApiError("invalid", "Search for at least 2 characters.");
  rateLimitSearch(deps, caller);
  const projectIds = await scopedProjects(deps, orgId, input);
  const list = (await visibleTo(deps, orgId, caller, { projectIds })).filter(
    (entry) => input.archived !== false || !entry.row.archivedAt,
  );
  const known = new Map(list.map((entry) => [entry.row.id, entry]));
  const hits = await searchHits(deps, { ids: [...known.keys()], q, limit: limit + 1, offset });
  const page = hits.slice(0, limit);
  const matches = new Map(
    page.map((hit) => [
      hit.artifactId,
      { source: hit.source, page: hit.page, ref: hit.ref, snippet: snippet(hit.text, q) },
    ]),
  );
  const cards = await libraryCards(
    deps,
    caller,
    page.map((hit) => known.get(hit.artifactId) as LoadedArtifact),
    matches,
  );
  return { cards, nextCursor: nextCursor(offset, limit, hits.length > limit) } satisfies LibraryPage;
}

export async function libraryProjects(
  deps: Deps,
  orgId: string,
  caller: Caller,
  input: { repo?: string; limit?: string; cursor?: string },
) {
  const { limit, offset } = paging(input.limit, input.cursor);
  const projectIds = await scopedProjects(deps, orgId, { repo: input.repo });
  const list = await visibleTo(deps, orgId, caller, { projectIds });
  const held = await heldProjects(deps, orgId, caller);
  const ids = [
    ...new Set([
      ...list.map(({ row }) => row.projectId),
      ...held.map((row) => row.id).filter((id) => !projectIds || projectIds.includes(id)),
    ]),
  ];
  const rows = ids.length
    ? await deps.db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.orgId, orgId),
            sql`${projects.id} = any(string_to_array(${ids.join(",")}, ',')::uuid[])`,
          ),
        )
        .orderBy(desc(projects.updatedAt), asc(projects.slug))
    : [];
  return {
    projects: rows.slice(offset, offset + limit).map((row) => ({
      slug: row.slug,
      name: row.name,
      repo: row.repo,
      artifacts: list.filter((entry) => entry.row.projectId === row.id).length,
      updatedAt: row.updatedAt.toISOString(),
    })),
    nextCursor: nextCursor(offset, limit, rows.length > offset + limit),
  } satisfies LibraryProjects;
}

export async function libraryArtifacts(
  deps: Deps,
  orgId: string,
  caller: Caller,
  input: { project: string; limit?: string; cursor?: string },
) {
  const { limit, offset } = paging(input.limit, input.cursor);
  const projectIds = (await scopedProjects(deps, orgId, { project: input.project })) ?? [];
  const list = await visibleTo(deps, orgId, caller, { projectIds });
  // The same answer for nothing there and nothing visible (03).
  if (list.length === 0) throw new ApiError("not_found", "Not found.");
  const page = list.slice(offset, offset + limit);
  return {
    cards: await libraryCards(deps, caller, page),
    nextCursor: nextCursor(offset, limit, list.length > offset + limit),
  } satisfies LibraryPage;
}

/** One artifact by its names, for callers that can read it; anyone else gets the same 404 as for nothing. */
export async function loadArtifact(
  deps: Deps,
  orgId: string,
  caller: Caller,
  project: string,
  slug: string,
): Promise<LoadedArtifact> {
  const found = await findArtifactBySlug(deps, orgId, project, slug);
  if (!found || !can(caller, "artifact.read", found)) throw new ApiError("not_found", "Not found.");
  return found;
}

export async function libraryPages(
  deps: Deps,
  caller: Caller,
  loaded: LoadedArtifact,
  input: { limit?: string; cursor?: string },
) {
  const { limit, offset } = paging(input.limit, input.cursor);
  const version = await liveVersion(deps, loaded);
  const [pageRows, frameCounts, blockCounts, cards] = await Promise.all([
    deps.db.select().from(pages).where(eq(pages.versionId, version.id)).orderBy(pages.position),
    deps.db
      .select({ page: frames.pageKey, count: sql<number>`count(*)::int` })
      .from(frames)
      .where(eq(frames.versionId, version.id))
      .groupBy(frames.pageKey),
    deps.db
      .select({ page: blocks.pageKey, count: sql<number>`count(*)::int` })
      .from(blocks)
      .where(eq(blocks.versionId, version.id))
      .groupBy(blocks.pageKey),
    libraryCards(deps, caller, [loaded]),
  ]);
  const card = cards[0];
  if (!card) throw new ApiError("not_found", "Not found.");
  return {
    card,
    pages: pageRows.slice(offset, offset + limit).map((page) => ({
      key: page.pageKey,
      kind: page.kind,
      title: page.title,
      group: page.group,
      frames: frameCounts.find((entry) => entry.page === page.pageKey)?.count ?? 0,
      blocks: blockCounts.find((entry) => entry.page === page.pageKey)?.count ?? 0,
    })),
    nextCursor: nextCursor(offset, limit, pageRows.length > offset + limit),
  } satisfies LibraryPages;
}

export async function libraryFrames(
  deps: Deps,
  loaded: LoadedArtifact,
  input: { page: string; limit?: string; cursor?: string },
) {
  const { limit, offset } = paging(input.limit, input.cursor);
  const version = await liveVersion(deps, loaded);
  const rows = await deps.db
    .select()
    .from(frames)
    .where(and(eq(frames.versionId, version.id), eq(frames.pageKey, input.page)))
    .orderBy(frames.y, frames.x);
  return {
    page: input.page,
    frames: rows.slice(offset, offset + limit).map((frame) => ({
      key: frame.frameKey,
      board: frame.boardKey,
      title: frame.title,
      device: frame.device,
      note: version.notes[frame.frameKey] ?? null,
    })),
    nextCursor: nextCursor(offset, limit, rows.length > offset + limit),
  } satisfies LibraryFrames;
}
