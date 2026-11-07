import type { BoardSuggestion, SuggestionStatus } from "@artifacts/schema";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { findArtifact, type LoadedArtifact } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { boardSuggestions, editDocs, people } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { authorsFor, logDecision, visibleSources } from "../editing/suggestions.ts";
import { ApiError } from "../http/errors.ts";
import { isUuid } from "../http/params.ts";
import type { ApiContext } from "../http/routes.ts";

export type BoardSuggestionRow = typeof boardSuggestions.$inferSelect;
const PAGE = 50;

/** `:id` of a board suggestion: the artifact it's on, loaded and checked like any artifact route. */
export function boardSuggestionParam(deps: Deps) {
  return async function load(c: ApiContext): Promise<LoadedArtifact & { suggestion: BoardSuggestionRow }> {
    const id = c.req.param("id");
    const [row] = isUuid(id)
      ? await deps.db
          .select()
          .from(boardSuggestions)
          .where(and(eq(boardSuggestions.orgId, c.get("org").id), eq(boardSuggestions.id, id)))
          .limit(1)
      : [];
    const artifact = row ? await findArtifact(deps, row.orgId, row.artifactId) : null;
    // Hidden and missing look alike: the visibility guard runs before anything about the batch is read.
    if (!row || !artifact) throw new ApiError("not_found", "Not found.");
    return { ...artifact, suggestion: row };
  };
}

/** Whether a caller proposed this batch: the same token, or the same person in a browser. */
export const boardAuthoredBy = (caller: Caller, row: BoardSuggestionRow) =>
  caller.kind === "person"
    ? row.tokenId === null && row.authorPersonId === caller.person.id
    : caller.kind === "cliToken" || caller.kind === "orgToken"
      ? row.tokenId === caller.tokenId
      : false;

/** Open batches past their expiry are expired; checked when listed, accepted and by the sweep. */
export async function expireBoardSuggestions(deps: Deps, artifactId?: string) {
  const now = deps.clock.now();
  await deps.db
    .update(boardSuggestions)
    .set({ status: "expired", decidedAt: now })
    .where(
      and(
        artifactId ? eq(boardSuggestions.artifactId, artifactId) : undefined,
        eq(boardSuggestions.status, "open"),
        lt(boardSuggestions.expiresAt, now),
      ),
    );
}

/** Rows as an editor reads them: hidden sources are left out, from the author and the request alike. */
export async function toBoardSuggestions(
  deps: Deps,
  caller: Caller,
  artifact: LoadedArtifact,
  rows: BoardSuggestionRow[],
): Promise<BoardSuggestion[]> {
  if (rows.length === 0) return [];
  const sources = await visibleSources(deps, caller, artifact);
  const authors = new Map(
    (
      await authorsFor(
        deps,
        artifact.id,
        rows.map((row) => row.authorKey),
        sources,
      )
    ).map((author) => [author.key, author]),
  );
  const deciders = [...new Set(rows.flatMap((row) => row.decidedBy ?? []))];
  const names = new Map(
    deciders.length
      ? (
          await deps.db
            .select({ id: people.id, name: people.name })
            .from(people)
            .where(inArray(people.id, deciders))
            .limit(deciders.length)
        ).map((row) => [row.id, row.name])
      : [],
  );
  return rows.map((row) => ({
    id: row.id,
    epoch: row.epoch,
    request: {
      ...row.request,
      ...(row.request.sources ? { sources: row.request.sources.filter((slug) => sources.has(slug)) } : {}),
    },
    ids: row.ids,
    status: row.status,
    author: authors.get(row.authorKey) ?? {
      key: row.authorKey,
      kind: "agent",
      name: row.agent ?? "agent",
      agent: row.agent,
      for: null,
      sources: [],
    },
    note: row.note,
    sources: row.sources.filter((slug) => sources.has(slug)),
    run: row.runId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy ? (names.get(row.decidedBy) ?? "Someone") : null,
  }));
}

/** `GET …/board/suggestions`: bounded batches, newest first, 50 a page. Only editors reach this. */
export async function listBoardSuggestions(
  deps: Deps,
  caller: Caller,
  artifact: LoadedArtifact,
  query: { status?: SuggestionStatus; run?: string; cursor?: string },
) {
  await expireBoardSuggestions(deps, artifact.id);
  const rows = await deps.db
    .select()
    .from(boardSuggestions)
    .where(
      and(
        eq(boardSuggestions.artifactId, artifact.id),
        query.status ? eq(boardSuggestions.status, query.status) : undefined,
        query.run ? eq(boardSuggestions.runId, query.run) : undefined,
        query.cursor ? lt(boardSuggestions.id, query.cursor) : undefined,
      ),
    )
    .orderBy(desc(boardSuggestions.id))
    .limit(PAGE + 1);
  const page = rows.slice(0, PAGE);
  return {
    suggestions: await toBoardSuggestions(deps, caller, artifact, page),
    nextCursor: rows.length > PAGE ? (page.at(-1)?.id ?? null) : null,
  };
}

async function seqOf(deps: Deps, artifactId: string) {
  const [row] = await deps.db
    .select({ seq: editDocs.seq })
    .from(editDocs)
    .where(eq(editDocs.artifactId, artifactId))
    .limit(1);
  return row?.seq ?? 0;
}

/**
 * Reject (a person with accept) or withdraw (its own author, person or token). Claims an open row once;
 * a batch already decided answers `conflict`. Tokens never accept or reject (14, "Suggestions").
 */
export async function decideBoardSuggestion(
  deps: Deps,
  caller: Caller,
  artifact: LoadedArtifact & { suggestion: BoardSuggestionRow },
  status: "rejected" | "withdrawn",
  note: string | null,
) {
  const row = artifact.suggestion;
  if (status === "withdrawn" && !boardAuthoredBy(caller, row))
    throw new ApiError("forbidden", "Only the suggestion's author withdraws it.");
  if (status === "rejected" && caller.kind !== "person")
    throw new ApiError("forbidden", "Only a person decides a suggestion.");
  const by = caller.kind === "person" ? caller.person.id : null;
  const claimed = await deps.db
    .update(boardSuggestions)
    .set({ status, decidedAt: deps.clock.now(), decidedBy: by, decisionNote: note })
    .where(and(eq(boardSuggestions.id, row.id), eq(boardSuggestions.status, "open")))
    .returning({ id: boardSuggestions.id });
  if (claimed.length === 0)
    throw new ApiError("conflict", "This suggestion was already decided.", { reason: "decided" });
  if (status === "rejected" && by) {
    await logDecision(deps, artifact, by, "suggestion_rejected", {
      suggestion: row.id,
      ...(row.runId ? { run: row.runId } : {}),
      count: row.request.ops.length,
    });
  }
  deps.docs?.notify(artifact.id, "c", { t: "suggestion", id: row.id, status });
  return { status, seq: await seqOf(deps, artifact.id) };
}
