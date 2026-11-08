import { RUN_MAX_MS, type Run, SUGGESTIONS_OPEN_MAX } from "@artifacts/schema";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { LoadedArtifact } from "../auth/access.ts";
import { actorOf, agentOf, type Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { acceptBoardLocked } from "../boards/suggestions.ts";
import {
  activity,
  boardSuggestions,
  boardVersions,
  editDocs,
  editRuns,
  people,
  suggestions,
  versions,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { checkpoint, checkpointLocked } from "./checkpoint.ts";
import { basePolicy, ownsRun } from "./policy.ts";
import { withDocLock } from "./store.ts";
import { applySuggestion, logDecision } from "./suggestions.ts";

export type RunRow = typeof editRuns.$inferSelect;
type Member = Extract<Caller, { kind: "person" | "cliToken" | "orgToken" }>;

/** Rows as `Run`s, with who started them and how many suggestions each holds, in two queries. */
export async function toRuns(deps: Deps, rows: RunRow[]): Promise<Run[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [articleCounts, boardCounts, names] = await Promise.all([
    deps.db
      .select({ run: suggestions.runId, n: sql<number>`count(*)::int` })
      .from(suggestions)
      .where(inArray(suggestions.runId, ids))
      .groupBy(suggestions.runId),
    // A board run's batches count as its suggestions too (14).
    deps.db
      .select({ run: boardSuggestions.runId, n: sql<number>`count(*)::int` })
      .from(boardSuggestions)
      .where(inArray(boardSuggestions.runId, ids))
      .groupBy(boardSuggestions.runId),
    deps.db
      .select({ id: people.id, name: people.name })
      .from(people)
      .where(inArray(people.id, [...new Set(rows.map((row) => row.startedBy))])),
  ]);
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    edits: row.edits,
    goal: row.goal,
    agent: row.agent,
    startedBy: names.find((person) => person.id === row.startedBy)?.name ?? "Someone",
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    version: row.version,
    suggestions:
      (articleCounts.find((count) => count.run === row.id)?.n ?? 0) +
      (boardCounts.find((count) => count.run === row.id)?.n ?? 0),
  }));
}

const one = async (deps: Deps, row: RunRow) => (await toRuns(deps, [row]))[0] as Run;

/**
 * `{ document: "board", page }` for a board page's activity (14, "Search, links, metadata and activity"),
 * from its draft's kind, or from its latest version's native board before any draft exists; else empty.
 */
export async function documentContext(
  deps: Deps,
  artifact: Pick<LoadedArtifact, "id"> & { row: { latestVersion: number } },
): Promise<{ document: "board"; page: string } | Record<string, never>> {
  const [doc] = await deps.db
    .select({ kind: editDocs.kind, page: editDocs.pageKey })
    .from(editDocs)
    .where(eq(editDocs.artifactId, artifact.id))
    .limit(1);
  if (doc) return doc.kind === "board" ? { document: "board", page: doc.page } : {};
  const [board] = await deps.db
    .select({ page: boardVersions.pageKey })
    .from(boardVersions)
    .innerJoin(versions, eq(versions.id, boardVersions.versionId))
    .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, artifact.row.latestVersion)))
    .limit(1);
  return board ? { document: "board", page: board.page } : {};
}

async function log(deps: Deps, artifact: LoadedArtifact, row: RunRow, kind: "run_started" | "run_finished") {
  await deps.db.insert(activity).values({
    id: Bun.randomUUIDv7(),
    orgId: artifact.row.orgId,
    artifactId: artifact.id,
    projectId: artifact.projectId,
    actorPersonId: row.decidedBy ?? row.startedBy,
    agent: row.agent,
    kind,
    payload: {
      run: row.id,
      goal: row.goal,
      status: row.status,
      version: row.version,
      ...(await documentContext(deps, artifact)),
    },
    createdAt: deps.clock.now(),
  });
  deps.docs?.notify(artifact.id, "c", { t: "run", id: row.id, status: row.status });
}

/** Active runs past their time end as expired (13). The jobs sweep and every start call this. */
export async function expireRuns(deps: Deps, artifactId?: string) {
  const now = deps.clock.now();
  return deps.db
    .update(editRuns)
    .set({ status: "expired", finishedAt: now })
    .where(
      and(
        eq(editRuns.status, "active"),
        lt(editRuns.expiresAt, now),
        artifactId ? eq(editRuns.artifactId, artifactId) : undefined,
      ),
    )
    .returning({ id: editRuns.id, artifactId: editRuns.artifactId });
}

/**
 * Starts a Delegate run (13, "Delegate"). Its `edits` are fixed now from the audience, so an agent can't
 * promote itself to direct edits by starting one. At most one active run per page; the partial check and
 * insert happen under the row lock of the artifact's runs, so two starts can't both win.
 */
export async function startRun(
  deps: Deps,
  caller: Member,
  artifact: LoadedArtifact,
  body: { goal: string; agent?: string | null },
): Promise<Run> {
  await expireRuns(deps, artifact.id);
  const base = await basePolicy(deps, caller, artifact);
  const now = deps.clock.now();
  const agent = agentOf(caller, body.agent) ?? (body.agent?.trim() || "Claude Code");
  const row = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${artifact.id}, 7))`);
    const [active] = await tx
      .select({ id: editRuns.id })
      .from(editRuns)
      .where(and(eq(editRuns.artifactId, artifact.id), eq(editRuns.status, "active")))
      .limit(1);
    if (active)
      throw new ApiError("conflict", "An agent is already working on this page.", { reason: "run_active" });
    const [made] = await tx
      .insert(editRuns)
      .values({
        id: Bun.randomUUIDv7(),
        orgId: artifact.row.orgId,
        artifactId: artifact.id,
        status: "active",
        edits: base.edits === "direct" ? "direct" : "suggestion",
        goal: body.goal,
        agent,
        startedBy: actorOf(caller),
        tokenId: caller.kind === "person" ? null : caller.tokenId,
        startedAt: now,
        expiresAt: new Date(now.getTime() + RUN_MAX_MS),
      })
      .returning();
    return made as RunRow;
  });
  await log(deps, artifact, row, "run_started");
  return one(deps, row);
}

export async function findRun(deps: Deps, orgId: string, id: string) {
  const [row] = await deps.db
    .select()
    .from(editRuns)
    .where(and(eq(editRuns.orgId, orgId), eq(editRuns.id, id)))
    .limit(1);
  return row ?? null;
}

const notActive = () => new ApiError("conflict", "That run isn't active.", { reason: "run_active" });

/** The agent finishes: a direct run checkpoints as `delegate`; a suggestion run waits for a person. */
export async function finishRun(
  deps: Deps,
  caller: Member,
  artifact: LoadedArtifact,
  row: RunRow,
  message?: string,
): Promise<Run> {
  if (!ownsRun(caller, row)) throw new ApiError("forbidden", "Only the run's own agent finishes it.");
  if (row.status !== "active") throw notActive();
  let version: number | null = null;
  if (row.edits === "direct") {
    const made = await checkpoint(deps, artifact.id, {
      kind: "delegate",
      personId: row.startedBy,
      agent: row.agent,
      message: message ? `${row.goal}\n\n${message}` : row.goal,
    });
    version = made.version;
  }
  const [done] = await deps.db
    .update(editRuns)
    .set({ status: "finished", finishedAt: deps.clock.now(), version })
    .where(and(eq(editRuns.id, row.id), eq(editRuns.status, "active")))
    .returning();
  if (!done) throw notActive();
  await log(deps, artifact, done, "run_finished");
  return one(deps, done);
}

/** Its owner, or anyone who can accept, stops a run. A direct run keeps what it already applied. */
export async function cancelRun(deps: Deps, caller: Caller, artifact: LoadedArtifact, row: RunRow) {
  if (!ownsRun(caller, row) && !can(caller, "artifact.accept", artifact)) {
    throw new ApiError("forbidden", "Only the run's person, or someone who can accept changes, stops it.");
  }
  if (row.status !== "active") throw notActive();
  const [done] = await deps.db
    .update(editRuns)
    .set({
      status: "cancelled",
      finishedAt: deps.clock.now(),
      decidedBy: caller.kind === "person" ? caller.person.id : null,
    })
    .where(and(eq(editRuns.id, row.id), eq(editRuns.status, "active")))
    .returning();
  if (!done) throw notActive();
  await log(deps, artifact, done, "run_finished");
  return one(deps, done);
}

const openOf = (deps: Deps, runId: string) =>
  deps.db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.runId, runId), eq(suggestions.status, "open")))
    .orderBy(asc(suggestions.createdAt), asc(suggestions.id))
    .limit(SUGGESTIONS_OPEN_MAX);

/**
 * A person accepts a suggestion run's change set: its open suggestions apply in creation order (stale
 * ones skipped unless `force`), then one `delegate` checkpoint by the person who accepted.
 */
export async function acceptRun(
  deps: Deps,
  caller: Extract<Caller, { kind: "person" }>,
  artifact: LoadedArtifact,
  row: RunRow,
  force: boolean,
): Promise<Run> {
  if (row.edits !== "suggestion") throw notActive();

  const [doc] = await deps.db
    .select({ kind: editDocs.kind })
    .from(editDocs)
    .where(eq(editDocs.artifactId, artifact.id))
    .limit(1);
  if (doc?.kind === "board") return acceptBoardRun(deps, caller, artifact, row, force);
  await claim(deps, row, "accepted", caller.person.id);
  // Each applies through the page's lock as its own author, so this stays one call per suggestion; a run
  // holds at most SUGGESTIONS_OPEN_MAX open ones.
  let count = 0;
  for (const suggestion of await openOf(deps, row.id)) {
    try {
      await applySuggestion(deps, caller, artifact, suggestion, force);
      count += 1;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "conflict") throw error;
    }
  }
  const made = await checkpoint(deps, artifact.id, {
    kind: "delegate",
    personId: caller.person.id,
    agent: row.agent,
    message: row.goal,
  });
  const [done] = await deps.db
    .update(editRuns)
    .set({
      status: "accepted",
      finishedAt: row.finishedAt ?? deps.clock.now(),
      decidedBy: caller.person.id,
      version: made.version,
    })
    .where(and(eq(editRuns.id, row.id), eq(editRuns.status, "accepted")))
    .returning();
  await logDecision(deps, artifact, caller.person.id, "suggestion_accepted", { run: row.id, count });
  await log(deps, artifact, done as RunRow, "run_finished");
  return one(deps, done as RunRow);
}

/**
 * A board run's change set (14, "Suggestions, runs and acceptance"): every open batch in creation order
 * under one lock, each in its own savepoint so a held or stale one is skipped (and stays open) without
 * undoing the others, then one `delegate` checkpoint by the person, all in one transaction.
 */
async function acceptBoardRun(
  deps: Deps,
  caller: Extract<Caller, { kind: "person" }>,
  artifact: LoadedArtifact,
  row: RunRow,
  force: boolean,
): Promise<Run> {
  let count = 0;
  const done = await withDocLock(deps, artifact.id, async (lock) => {
    await claim({ ...deps, db: lock.tx } as unknown as Deps, row, "accepted", caller.person.id);
    const open = await lock.tx
      .select({ id: boardSuggestions.id })
      .from(boardSuggestions)
      .where(and(eq(boardSuggestions.runId, row.id), eq(boardSuggestions.status, "open")))
      .orderBy(asc(boardSuggestions.createdAt), asc(boardSuggestions.id))
      .limit(SUGGESTIONS_OPEN_MAX);
    for (const { id } of open) {
      const kept = lock.row;
      try {
        const done = await lock.tx.transaction((sp) =>
          acceptBoardLocked(deps, caller, artifact, id, force, { ...lock, tx: sp }),
        );
        if (done.status === "accepted") {
          count += 1;
          const [current] = await lock.tx.select().from(editDocs).where(eq(editDocs.artifactId, artifact.id));
          lock.row = current ?? null;
        }
      } catch (error) {
        lock.row = kept;
        if (!(error instanceof ApiError) || error.code !== "conflict") throw error;
      }
    }
    const made = await checkpointLocked(
      deps,
      lock,
      { row: artifact.row, project: artifact.project },
      { kind: "delegate", personId: caller.person.id, agent: row.agent, message: row.goal },
    );
    const [done] = await lock.tx
      .update(editRuns)
      .set({
        status: "accepted",
        finishedAt: row.finishedAt ?? deps.clock.now(),
        decidedBy: caller.person.id,
        version: made.version,
      })
      .where(and(eq(editRuns.id, row.id), eq(editRuns.status, "accepted")))
      .returning();
    return done as RunRow;
  });
  await logDecision(deps, artifact, caller.person.id, "suggestion_accepted", {
    run: row.id,
    count,
    ...(await documentContext(deps, artifact)),
  });
  await log(deps, artifact, done as RunRow, "run_finished");
  return one(deps, done as RunRow);
}

export async function rejectRun(
  deps: Deps,
  caller: Extract<Caller, { kind: "person" }>,
  artifact: LoadedArtifact,
  row: RunRow,
  note?: string,
): Promise<Run> {
  if (row.edits !== "suggestion") throw notActive();
  const claimed = await claim(deps, row, "rejected", caller.person.id);
  // One statement for the whole change set: nothing is applied, so nothing needs doing per suggestion.
  const rejected = await deps.db
    .update(suggestions)
    .set({
      status: "rejected",
      decidedAt: deps.clock.now(),
      decidedBy: caller.person.id,
      decisionNote: note ?? null,
    })
    .where(and(eq(suggestions.runId, row.id), eq(suggestions.status, "open")))
    .returning({ id: suggestions.id });
  // A board run's batches are rejected with it, in one statement too.
  const boards = await deps.db
    .update(boardSuggestions)
    .set({
      status: "rejected",
      decidedAt: deps.clock.now(),
      decidedBy: caller.person.id,
      decisionNote: note ?? null,
    })
    .where(and(eq(boardSuggestions.runId, row.id), eq(boardSuggestions.status, "open")))
    .returning({ id: boardSuggestions.id });
  const count = rejected.length + boards.length;
  const done = claimed;
  await logDecision(deps, artifact, caller.person.id, "suggestion_rejected", { run: row.id, count });
  await log(deps, artifact, done as RunRow, "run_finished");
  return one(deps, done as RunRow);
}

/** Moves a run from active or finished to a decision, or answers `conflict` if someone decided first. */
async function claim(deps: Deps, row: RunRow, status: "accepted" | "rejected", by: string) {
  const [done] = await deps.db
    .update(editRuns)
    .set({ status, finishedAt: row.finishedAt ?? deps.clock.now(), decidedBy: by })
    .where(and(eq(editRuns.id, row.id), inArray(editRuns.status, ["active", "finished"])))
    .returning();
  if (!done) throw notActive();
  return done;
}

/** Active runs on a page, for `DocState`. */
export async function activeRuns(deps: Deps, artifactId: string) {
  const rows = await deps.db
    .select()
    .from(editRuns)
    .where(and(eq(editRuns.artifactId, artifactId), eq(editRuns.status, "active")))
    .limit(5);
  return toRuns(deps, rows);
}

/** Runs an authorized board editor can review; goals remain hidden from readers. */
export async function boardRuns(deps: Deps, caller: Caller, artifact: LoadedArtifact) {
  const rows = await deps.db
    .select()
    .from(editRuns)
    .where(and(eq(editRuns.artifactId, artifact.id), inArray(editRuns.status, ["active", "finished"])))
    .orderBy(desc(editRuns.startedAt))
    .limit(100);
  return toRuns(
    deps,
    rows.filter(
      (row) => row.status === "active" || ownsRun(caller, row) || can(caller, "artifact.accept", artifact),
    ),
  );
}

/** Draft event kinds and frequency are private, just like their content. */
export async function visibleActivity(
  deps: Deps,
  caller: Caller,
  artifact: LoadedArtifact,
  event: { kind: string; payload: Record<string, unknown> },
) {
  if (can(caller, "artifact.edit", artifact)) return true;
  if (
    ["edited", "suggested", "suggestion_accepted", "suggestion_rejected", "suggestion_withdrawn"].includes(
      event.kind,
    )
  )
    return false;
  if (event.kind !== "run_started" && event.kind !== "run_finished") return true;
  const id = event.payload.run;
  if (typeof id !== "string") return false;
  const run = await findRun(deps, artifact.row.orgId, id);
  return Boolean(
    run &&
      run.artifactId === artifact.id &&
      (ownsRun(caller, run) || (event.kind === "run_finished" && run.status === "accepted")),
  );
}
