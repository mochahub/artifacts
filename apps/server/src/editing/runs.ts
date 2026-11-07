import { RUN_MAX_MS, type Run, SUGGESTIONS_OPEN_MAX } from "@artifacts/schema";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { LoadedArtifact } from "../auth/access.ts";
import { actorOf, agentOf, type Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { activity, editRuns, people, suggestions } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { checkpoint } from "./checkpoint.ts";
import { basePolicy, ownsRun } from "./policy.ts";
import { applySuggestion, logDecision } from "./suggestions.ts";

export type RunRow = typeof editRuns.$inferSelect;
type Member = Extract<Caller, { kind: "person" | "cliToken" | "orgToken" }>;

/** Rows as `Run`s, with who started them and how many suggestions each holds, in two queries. */
export async function toRuns(deps: Deps, rows: RunRow[]): Promise<Run[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [counts, names] = await Promise.all([
    deps.db
      .select({ run: suggestions.runId, n: sql<number>`count(*)::int` })
      .from(suggestions)
      .where(inArray(suggestions.runId, ids))
      .groupBy(suggestions.runId),
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
    suggestions: counts.find((count) => count.run === row.id)?.n ?? 0,
  }));
}

const one = async (deps: Deps, row: RunRow) => (await toRuns(deps, [row]))[0] as Run;

async function log(deps: Deps, artifact: LoadedArtifact, row: RunRow, kind: "run_started" | "run_finished") {
  await deps.db.insert(activity).values({
    id: Bun.randomUUIDv7(),
    orgId: artifact.row.orgId,
    artifactId: artifact.id,
    projectId: artifact.projectId,
    actorPersonId: row.decidedBy ?? row.startedBy,
    agent: row.agent,
    kind,
    payload: { run: row.id, goal: row.goal, status: row.status, version: row.version },
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
  // Claimed first, so an accept and a reject at once can't both decide it.
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
  const count = rejected.length;
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
