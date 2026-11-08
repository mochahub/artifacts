import {
  type Author,
  DAY_MS,
  type EditRequest,
  SUGGESTION_DAYS,
  SUGGESTIONS_OPEN_MAX,
  type Suggestion,
  type SuggestionStatus,
} from "@artifacts/schema";
import { buildArticle } from "@artifacts/schema/article";
import { sanitizeArticle } from "@artifacts/schema/sanitize";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { LoadedArtifact } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { activity, editAuthors, people, suggestions } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { visibleTo } from "../library/visible.ts";
import { contentHash, yToDoc } from "./model.ts";
import { applyOps } from "./ops.ts";
import { type Actor, type DocLock, loadDoc } from "./store.ts";

export type SuggestionRow = typeof suggestions.$inferSelect;
type PmNode = { type: string; attrs?: Record<string, unknown>; content?: PmNode[] };
const PAGE = 50;

/** Source slugs the caller can see in this page's wiki: anything else is left out of what they read (13). */
export async function visibleSources(deps: Deps, caller: Caller, artifact: LoadedArtifact) {
  const visible = await visibleTo(deps, artifact.row.orgId, caller, { projectId: artifact.projectId });
  return new Set(visible.map((entry) => entry.row.slug));
}

/** Author keys as people read them: names, the agent and whom it acted for, and only visible sources. */
export async function authorsFor(
  deps: Deps,
  artifactId: string,
  keys: string[],
  sources: Set<string>,
): Promise<Author[]> {
  if (keys.length === 0) return [];
  const rows = await deps.db
    .select({
      key: editAuthors.key,
      kind: editAuthors.kind,
      agent: editAuthors.agent,
      sources: editAuthors.sources,
      name: people.name,
    })
    .from(editAuthors)
    .leftJoin(people, eq(people.id, editAuthors.personId))
    .where(and(eq(editAuthors.artifactId, artifactId), inArray(editAuthors.key, [...new Set(keys)])))
    .limit(500);
  return rows.map((row) => ({
    key: row.key,
    kind: row.kind,
    name: row.kind === "agent" ? (row.agent ?? "agent") : (row.name ?? "Someone"),
    agent: row.kind === "agent" ? row.agent : null,
    for: row.kind === "agent" ? (row.name ?? null) : null,
    sources: row.sources.filter((slug) => sources.has(slug)),
  }));
}

/** The server's own rendering of a proposed block: the pipeline and the sanitizer, nothing else (13). */
function render(markdown: string | null, project: string) {
  if (!markdown) return null;
  const built = buildArticle({
    source: markdown,
    path: "suggestion.md",
    project,
    readFile: () => "",
    blobHash: () => undefined,
    frameHash: () => undefined,
    mermaid: new Map(),
  });
  return sanitizeArticle(built.html);
}

/**
 * Open suggestions whose block changed or went are stale, and old ones expired (13, "Life"). Checked
 * lazily, when they're listed or accepted, and by the jobs sweep.
 */
export async function refreshStatuses(deps: Deps, artifactId: string) {
  const now = deps.clock.now();
  await deps.db
    .update(suggestions)
    .set({ status: "expired", decidedAt: now })
    .where(
      and(
        eq(suggestions.artifactId, artifactId),
        eq(suggestions.status, "open"),
        lt(suggestions.expiresAt, now),
      ),
    );
  const open = await deps.db
    .select({
      id: suggestions.id,
      op: suggestions.op,
      blockId: suggestions.blockId,
      base: suggestions.base,
      newBlockId: suggestions.newBlockId,
    })
    .from(suggestions)
    .where(and(eq(suggestions.artifactId, artifactId), eq(suggestions.status, "open")))
    .limit(1000);
  if (open.length === 0) return;
  const { ydoc } = await loadDoc(deps, artifactId);
  const doc = yToDoc(ydoc) as PmNode;
  const bases = new Map(
    (doc.content ?? []).map((node) => [
      String(node.attrs?.id ?? ""),
      contentHash(node as never).slice(0, 12),
    ]),
  );
  // An insert in a run may go after a block an earlier suggestion of the run will make.
  const made = new Set(open.flatMap((row) => row.newBlockId ?? []));
  const stale = open.filter((row) => {
    if (row.op === "meta") return false;
    if (row.op === "insert") return row.blockId !== null && !bases.has(row.blockId) && !made.has(row.blockId);
    return !row.blockId || bases.get(row.blockId) !== row.base;
  });
  if (stale.length) {
    await deps.db
      .update(suggestions)
      .set({ status: "stale" })
      .where(
        and(
          inArray(
            suggestions.id,
            stale.map((row) => row.id),
          ),
          eq(suggestions.status, "open"),
        ),
      );
  }
}

/** `GET /api/artifacts/:id/suggestions`. Only callers who can edit reach this. */
export async function listSuggestions(
  deps: Deps,
  caller: Caller,
  artifact: LoadedArtifact,
  query: { status?: SuggestionStatus; run?: string; cursor?: string },
): Promise<{ suggestions: Suggestion[]; nextCursor: string | null }> {
  await refreshStatuses(deps, artifact.id).catch((error) => {
    if (!(error instanceof ApiError)) throw error;
  });
  const rows = await deps.db
    .select()
    .from(suggestions)
    .where(
      and(
        eq(suggestions.artifactId, artifact.id),
        query.status ? eq(suggestions.status, query.status) : undefined,
        query.run ? eq(suggestions.runId, query.run) : undefined,
        query.cursor ? lt(suggestions.id, query.cursor) : undefined,
      ),
    )
    .orderBy(desc(suggestions.id))
    .limit(PAGE + 1);
  const page = rows.slice(0, PAGE);
  return {
    suggestions: await toSuggestions(deps, caller, artifact, page),
    nextCursor: rows.length > PAGE ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Rows as callers read them: sources the caller can't see are left out and not counted. */
export async function toSuggestions(
  deps: Deps,
  caller: Caller,
  artifact: LoadedArtifact,
  rows: SuggestionRow[],
): Promise<Suggestion[]> {
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
    ).map((a) => [a.key, a]),
  );
  const deciders = [...new Set(rows.flatMap((row) => row.decidedBy ?? []))];
  const names = new Map(
    deciders.length
      ? (
          await deps.db
            .select({ id: people.id, name: people.name })
            .from(people)
            .where(inArray(people.id, deciders))
        ).map((row) => [row.id, row.name])
      : [],
  );
  return rows.map((row) => ({
    id: row.id,
    op: row.op,
    block: row.blockId,
    newBlock: row.newBlockId,
    base: row.base,
    markdown: row.markdown,
    meta: row.meta
      ? {
          ...row.meta,
          ...(row.meta.sources ? { sources: row.meta.sources.filter((s) => sources.has(s)) } : {}),
        }
      : null,
    html: render(row.markdown, artifact.project.slug),
    note: row.note,
    sources: row.sources.filter((slug) => sources.has(slug)),
    fixes: row.fixes,
    status: row.status,
    run: row.runId,
    author: authors.get(row.authorKey) ?? {
      key: row.authorKey,
      kind: row.agent ? "agent" : "person",
      name: row.agent ?? "Someone",
      agent: row.agent,
      for: null,
      sources: [],
    },
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy ? (names.get(row.decidedBy) ?? null) : null,
  }));
}

/** The op a suggestion would apply, as an `EditRequest` op. */
function opOf(row: SuggestionRow): EditRequest["ops"][number] {
  switch (row.op) {
    case "replace":
      return { op: "replace", block: row.blockId ?? "", base: row.base ?? "", markdown: row.markdown ?? "" };
    case "delete":
      return { op: "delete", block: row.blockId ?? "", base: row.base ?? "" };
    case "insert":
      return { op: "insert", after: row.blockId, markdown: row.markdown ?? "" };
    case "meta":
      return { op: "meta", ...(row.meta ?? {}) };
  }
}

const authorActor = (row: SuggestionRow): Actor => ({
  origin: row.agent ? "agent" : "person",
  personId: row.authorPersonId,
  agent: row.agent,
  tokenId: row.tokenId,
});

/**
 * Applies one open suggestion to the draft as a server transaction carrying its author's key (13,
 * "Accepting"). It's claimed first, so two people accepting at once apply it once. A replace or delete
 * whose base moved is `conflict`/`stale` unless `force`; a target that's gone makes it stale.
 */
export async function applySuggestion(
  deps: Deps,
  caller: Extract<Caller, { kind: "person" }>,
  artifact: LoadedArtifact,
  row: SuggestionRow,
  force: boolean,
): Promise<{ status: SuggestionStatus; seq: number }> {
  const now = deps.clock.now();
  const [claimed] = await deps.db
    .update(suggestions)
    .set({ status: "accepted", decidedAt: now, decidedBy: caller.person.id })
    .where(and(eq(suggestions.id, row.id), eq(suggestions.status, "open"), gt(suggestions.expiresAt, now)))
    .returning();
  if (!claimed) throw new ApiError("conflict", "That suggestion isn't open any more.", { reason: "stale" });
  const release = (status: SuggestionStatus) =>
    deps.db
      .update(suggestions)
      .set({
        status,
        decidedAt: status === "open" ? null : now,
        decidedBy: status === "open" ? null : caller.person.id,
      })
      .where(eq(suggestions.id, row.id));
  let result: Awaited<ReturnType<typeof applyOps>>;
  try {
    result = await applyOps(
      deps,
      caller,
      artifact,
      { ops: [opOf(row)], ...(row.runId ? { run: row.runId } : {}) },
      {
        personId: caller.person.id,
        authorKey: row.authorKey,
        actor: authorActor(row),
        force,
        // An insert keeps the id it promised, so a run's later ops that name it still find it.
        newBlockId: row.newBlockId,
      },
    );
  } catch (error) {
    await release("open");
    throw error;
  }
  const outcome = result.results[0];
  if (outcome?.outcome !== "applied") {
    const gone = outcome?.reason === "missing";
    await release(gone ? "stale" : "open");
    if (outcome?.reason === "stale" || gone) {
      throw new ApiError("conflict", outcome?.message ?? "The block changed since this was suggested.", {
        reason: "stale",
      });
    }
    throw new ApiError("conflict", outcome?.message ?? "That suggestion can't be applied.", {
      reason: outcome?.reason ?? "stale",
    });
  }
  return { status: "accepted", seq: result.seq };
}

/** Rejecting, or the author withdrawing: no change to the draft. */
export async function decide(
  deps: Deps,
  row: SuggestionRow,
  status: "rejected" | "withdrawn",
  by: string | null,
  note?: string,
) {
  const [done] = await deps.db
    .update(suggestions)
    .set({ status, decidedAt: deps.clock.now(), decidedBy: by, decisionNote: note ?? null })
    .where(and(eq(suggestions.id, row.id), eq(suggestions.status, "open")))
    .returning({ id: suggestions.id });
  if (!done) throw new ApiError("conflict", "That suggestion isn't open any more.", { reason: "stale" });
}

/** One log row for a person's decision on suggestions, one at a time or a run's at once. */
export async function logDecision(
  deps: Deps,
  artifact: LoadedArtifact,
  personId: string,
  kind: "suggestion_accepted" | "suggestion_rejected",
  payload: { suggestion?: string; run?: string; count: number; document?: "board"; page?: string },
) {
  await deps.db.insert(activity).values({
    id: Bun.randomUUIDv7(),
    orgId: artifact.row.orgId,
    artifactId: artifact.id,
    projectId: artifact.projectId,
    actorPersonId: personId,
    agent: null,
    kind,
    payload,
    createdAt: deps.clock.now(),
  });
}

/** Whether a caller wrote a suggestion: the same token, or the same person in a browser. */
export const authoredBy = (caller: Caller, row: SuggestionRow) =>
  caller.kind === "person"
    ? row.tokenId === null && row.authorPersonId === caller.person.id
    : caller.kind === "cliToken" || caller.kind === "orgToken"
      ? row.tokenId === caller.tokenId
      : false;

/** One op filed as a suggestion: what `createSuggestions` writes. */
export type SuggestionItem = {
  index: number;
  op: SuggestionRow["op"];
  blockId: string | null;
  newBlockId: string | null;
  base: string | null;
  markdown: string | null;
  meta: SuggestionRow["meta"];
  /** An earlier open suggestion of the same run on the same block, withdrawn by this one. */
  supersedes?: string | null;
};

/**
 * The one writer of suggestion rows (13, "Suggestions"), inside the page's lock: past
 * `SUGGESTIONS_OPEN_MAX` open ones an item gets `id: null` (refused with `limit`), and a superseded run
 * suggestion is withdrawn first. Expires `SUGGESTION_DAYS` from now.
 */
export async function createSuggestions(
  deps: Deps,
  lock: DocLock,
  artifact: LoadedArtifact,
  input: {
    pageKey: string;
    items: SuggestionItem[];
    authorKey: string;
    actor: Actor;
    note?: string | null;
    sources?: string[];
    fixes?: number[];
    runId?: string | null;
  },
): Promise<{ index: number; id: string | null }[]> {
  const [count] = await lock.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(suggestions)
    .where(and(eq(suggestions.artifactId, artifact.id), eq(suggestions.status, "open")));
  let open = count?.n ?? 0;
  const now = deps.clock.now();
  const out: { index: number; id: string | null }[] = [];
  for (const item of input.items) {
    if (item.supersedes) {
      const withdrawn = await lock.tx
        .update(suggestions)
        .set({ status: "withdrawn", decidedAt: now })
        .where(and(eq(suggestions.id, item.supersedes), eq(suggestions.status, "open")))
        .returning({ id: suggestions.id });
      open -= withdrawn.length;
    }
    if (open >= SUGGESTIONS_OPEN_MAX) {
      out.push({ index: item.index, id: null });
      continue;
    }
    const id = Bun.randomUUIDv7();
    await lock.tx.insert(suggestions).values({
      id,
      orgId: artifact.row.orgId,
      artifactId: artifact.id,
      pageKey: input.pageKey,
      op: item.op,
      blockId: item.blockId,
      newBlockId: item.newBlockId,
      base: item.base,
      markdown: item.markdown,
      meta: item.meta,
      note: input.note ?? null,
      sources: input.sources ?? [],
      fixes: input.fixes ?? [],
      runId: input.runId ?? null,
      authorKey: input.authorKey,
      authorPersonId: input.actor.personId,
      agent: input.actor.agent,
      tokenId: input.actor.tokenId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SUGGESTION_DAYS * DAY_MS),
    });
    open += 1;
    out.push({ index: item.index, id });
  }
  return out;
}
