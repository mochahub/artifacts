import { yToBoard } from "@artifacts/doc/board";
import { boardBase } from "@artifacts/doc/board-hash";
import { mintBoardObjectId } from "@artifacts/doc/board-ids";
import type { BoardSuggestion, SuggestionStatus } from "@artifacts/schema";
import type { BoardObject, BoardSuggestionPreview } from "@artifacts/schema/boards";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { findArtifact, type LoadedArtifact } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { boardSuggestions, editDocs, people } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { type Actor, type DocLock, loadDoc, withDocLock } from "../editing/store.ts";
import { authorsFor, logDecision, visibleSources } from "../editing/suggestions.ts";
import { ApiError } from "../http/errors.ts";
import { isUuid } from "../http/params.ts";
import type { ApiContext } from "../http/routes.ts";
import { validatedImages } from "./checkpoint.ts";
import {
  applyBoardBatchLocked,
  batchAssets,
  latestSources,
  planBoardBatch,
  projectPrerequisites,
  runPrerequisites,
  sourceKey,
} from "./ops.ts";

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
      document: "board",
      page: row.pageKey,
    });
  }
  deps.docs?.notify(artifact.id, "c", { t: "suggestion", id: row.id, status });
  return { status, seq: await seqOf(deps, artifact.id) };
}

/** The author of a stored batch, as its acceptance stamps it: the proposing agent or person, never the decider. */
const authorActor = (row: BoardSuggestionRow): Actor => ({
  origin: row.agent ? "agent" : "person",
  personId: row.authorPersonId,
  agent: row.agent,
  tokenId: row.tokenId,
});

/**
 * Accepts one batch inside a lock the caller holds (14, "Suggestions, runs and acceptance"). The row is
 * claimed first, in this transaction, so the batch's own reserved ids and sources don't count as another
 * proposal's. A held target or a failed check throws and rolls the claim back; a gone target or, without
 * `force`, a moved base marks the batch stale, which is a decision too.
 */
export async function acceptBoardLocked(
  deps: Deps,
  caller: Extract<Caller, { kind: "person" }>,
  artifact: LoadedArtifact,
  id: string,
  force: boolean,
  lock: DocLock,
): Promise<{ status: SuggestionStatus; seq: number; objects: number }> {
  const now = deps.clock.now();
  const [row] = await lock.tx
    .select()
    .from(boardSuggestions)
    .where(and(eq(boardSuggestions.id, id), eq(boardSuggestions.artifactId, artifact.id)))
    .for("update")
    .limit(1);
  if (!row || row.status !== "open" || row.expiresAt <= now)
    throw new ApiError("conflict", "That suggestion isn't open any more.", { reason: "decided" });
  const settle = (status: SuggestionStatus) =>
    lock.tx
      .update(boardSuggestions)
      .set({ status, decidedAt: now, decidedBy: caller.person.id })
      .where(eq(boardSuggestions.id, row.id));
  const seq = lock.row?.seq ?? 0;
  if (!lock.row || lock.row.kind !== "board" || lock.row.epoch !== row.epoch) {
    // A reset board: the batch was checked against content that's gone.
    await settle("stale");
    return { status: "stale", seq, objects: 0 };
  }
  await settle("accepted");
  const result = await applyBoardBatchLocked(deps, caller, artifact, row.request, lock, {
    personId: caller.person.id,
    authorKey: row.authorKey,
    actor: authorActor(row),
    ids: row.ids,
    force,
  });
  if (result.outcome !== "applied") {
    // A gone target can never apply: stale is the decision. A moved base stays open for review (force).
    if (result.reason === "missing") {
      await settle("stale");
      return { status: "stale", seq: result.seq, objects: 0 };
    }
    throw new ApiError("conflict", result.message ?? "That suggestion can't be applied.", {
      reason: result.reason ?? "stale",
    });
  }
  return {
    status: "accepted",
    seq: result.seq,
    objects: new Set(result.results.flatMap((entry) => entry.objects)).size,
  };
}

/** `POST /api/board-suggestions/:id/accept`: one batch, under the page's lock, logged as the person's. */
export async function acceptBoardSuggestion(
  deps: Deps,
  caller: Extract<Caller, { kind: "person" }>,
  artifact: LoadedArtifact & { suggestion: BoardSuggestionRow },
  force: boolean,
) {
  const row = artifact.suggestion;
  // A refusal throws, rolling the claim back: the batch stays open for the person to review.
  const result = await withDocLock(deps, artifact.id, (lock) =>
    acceptBoardLocked(deps, caller, artifact, row.id, force, lock),
  );
  if (result.status === "accepted") {
    await logDecision(deps, artifact, caller.person.id, "suggestion_accepted", {
      suggestion: row.id,
      ...(row.runId ? { run: row.runId } : {}),
      count: row.request.ops.length,
      document: "board",
      page: row.pageKey,
    });
  }
  deps.docs?.notify(artifact.id, "c", { t: "suggestion", id: row.id, status: result.status });
  return { status: result.status, seq: result.seq };
}

const PREVIEW_BYTES = 32 * 1024;
const PREVIEW_MAX = 512 * 1024;
type PreviewCursor = { s: "objects" | "deleted"; i: number; k: string };

/**
 * `GET /api/board-suggestions/:id/preview`: the server's projection of a batch over the current draft,
 * the ghost objects and changed poses it would leave, a page at a time (14, "Agent operations"). The
 * cursor is bound to the suggestion, the draft's epoch and seq; a draft that moved on says `stale_read`.
 */
export async function previewBoardSuggestion(
  deps: Deps,
  caller: Caller,
  artifact: LoadedArtifact & { suggestion: BoardSuggestionRow },
  cursorText?: string,
): Promise<BoardSuggestionPreview> {
  if (!can(caller, "artifact.edit", artifact)) throw new ApiError("forbidden", "Previews are for editors.");
  const row = artifact.suggestion;
  const { ydoc, row: doc } = await loadDoc(deps, artifact.id);
  if (doc.kind !== "board") throw new ApiError("not_found", "Not found.");
  const binding = `${row.id}:${doc.epoch}:${doc.seq}`;
  let cursor: PreviewCursor = { s: "objects", i: 0, k: binding };
  if (cursorText) {
    try {
      cursor = JSON.parse(Buffer.from(cursorText, "base64url").toString()) as PreviewCursor;
    } catch {
      throw new ApiError("invalid", "That cursor isn't valid.");
    }
    if (!Number.isInteger(cursor.i) || cursor.i < 0 || (cursor.s !== "objects" && cursor.s !== "deleted"))
      throw new ApiError("invalid", "That cursor isn't valid.");
    if (cursor.k !== binding)
      throw new ApiError("conflict", "The board changed since that page. Preview it again.", {
        reason: "stale_read",
      });
  }
  const snapshot = yToBoard(ydoc);
  ydoc.destroy();
  const empty = { id: row.id, epoch: doc.epoch, seq: doc.seq, objects: [], deleted: [], nextCursor: null };
  if (doc.epoch !== row.epoch) return empty;
  const images = new Map(snapshot.assets.map((image) => [image.hash, image]));
  // A dependent batch of a run is previewed over that run's earlier open batches, so it can name their
  // reserved ids; its own changes are what differs from that projection.
  const prerequisites = row.runId
    ? await runPrerequisites(deps.db, artifact.id, row.runId, row.epoch, row)
    : [];
  const usable = await validatedImages(
    deps.db,
    artifact.id,
    batchAssets([...prerequisites.map((p) => p.request), row.request]),
  );
  const sources = await latestSourcesOf(deps, artifact, doc.pageKey);
  const asset = (hash: string) => usable.get(hash) ?? images.get(hash) ?? null;
  const source = (s: { page: string; frame: string }) => sources.get(sourceKey(s)) ?? null;
  const scene = prerequisites.length
    ? projectPrerequisites(snapshot, prerequisites, { asset, source })
    : snapshot;
  const plan = planBoardBatch(scene, row.request, {
    author: row.authorKey,
    time: row.createdAt.toISOString(),
    mint: mintBoardObjectId,
    held: () => false,
    asset,
    source,
    force: true,
    ids: row.ids,
  });
  if (plan.outcome !== "ok") return empty;
  const before = new Map(plan.before.objects.map((object) => [object.id, boardBase(object)]));
  const changed = plan.after.objects.filter((object) => before.get(object.id) !== boardBase(object));
  const kept = new Set(plan.after.objects.map((object) => object.id));
  const deleted = plan.before.objects.filter((object) => !kept.has(object.id)).map((object) => object.id);
  const objects: BoardSuggestionPreview["objects"] = [];
  let next: PreviewCursor | null = null;
  let out: string[] = [];
  if (cursor.s === "objects") {
    let bytes = 0;
    for (let i = cursor.i; i < changed.length; i++) {
      const object = changed[i] as BoardObject;
      const size = Buffer.byteLength(JSON.stringify(object));
      if (
        objects.length >= 50 ||
        (objects.length > 0 && (bytes + size > PREVIEW_BYTES || bytes + size > PREVIEW_MAX))
      ) {
        next = { s: "objects", i, k: binding };
        break;
      }
      bytes += size;
      objects.push({ object, base: boardBase(object) });
    }
    if (!next) out = deleted.slice(0, 500);
    if (!next && deleted.length > 500) next = { s: "deleted", i: 500, k: binding };
  } else {
    out = deleted.slice(cursor.i, cursor.i + 500);
    if (cursor.i + 500 < deleted.length) next = { s: "deleted", i: cursor.i + 500, k: binding };
  }
  return {
    id: row.id,
    epoch: doc.epoch,
    seq: doc.seq,
    objects,
    deleted: out,
    nextCursor: next ? Buffer.from(JSON.stringify(next)).toString("base64url") : null,
  };
}

/** Rendered sources of the latest version, outside a lock (a preview reads, it never writes). */
async function latestSourcesOf(deps: Deps, artifact: LoadedArtifact, pageKey: string) {
  return latestSources(
    { tx: deps.db as unknown as DocLock["tx"], row: null, after: () => {} },
    artifact,
    pageKey,
  );
}
