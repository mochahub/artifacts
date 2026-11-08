import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../db/index.ts";
import { lockLibrarian } from "../db/locks.ts";
import {
  activity,
  editRuns,
  librarianAttempts,
  librarianConfig,
  librarianEvents,
  librarianInbox,
  librarianKeys,
  librarianMonths,
  librarianReceipts,
  librarianRuns,
  librarianWikis,
  projects,
  tokens,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { afterCommit, registerAfterCommit } from "../editing/transaction.ts";

export type RunFence = {
  orgId: string;
  runId: string;
  owner: string;
  fence: number;
  configGeneration: number;
};
export const LEASE_MS = 90_000;
export const HEARTBEAT_MS = 30_000;
export function blocked(): never {
  throw new Error("Librarian fenced or unavailable");
}
export async function locked<T>(deps: Deps, orgId: string, use: (tx: Tx) => Promise<T>): Promise<T> {
  const queued: (() => void)[] = [];
  const result = await deps.db.transaction(async (tx) => {
    registerAfterCommit(tx, queued);
    await lockLibrarian(tx, orgId);
    return use(tx);
  });
  for (const notify of queued) notify();
  return result;
}
export async function guard(deps: Deps, tx: Tx, fence: RunFence) {
  if (!deps.env.librarianAllowed) return blocked();
  const [run] = await tx
    .select()
    .from(librarianRuns)
    .where(and(eq(librarianRuns.id, fence.runId), eq(librarianRuns.orgId, fence.orgId)));
  const [config] = await tx.select().from(librarianConfig).where(eq(librarianConfig.orgId, fence.orgId));
  const now = deps.clock.now();
  if (
    !run ||
    !config?.enabled ||
    config.generation !== fence.configGeneration ||
    run.configGeneration !== config.generation ||
    run.state !== "running" ||
    run.owner !== fence.owner ||
    run.fence !== fence.fence ||
    run.leaseExpiresAt <= now ||
    run.deadline <= now
  )
    return blocked();
  if (run.inboxId) {
    const [inbox] = await tx
      .select()
      .from(librarianInbox)
      .where(and(eq(librarianInbox.id, run.inboxId), eq(librarianInbox.orgId, fence.orgId)));
    if (!inbox || inbox.runId !== run.id || inbox.wikiId !== run.wikiId || inbox.status === "cancelled")
      return blocked();
  }
  const [wiki] = await tx
    .select()
    .from(librarianWikis)
    .innerJoin(projects, eq(projects.id, librarianWikis.projectId))
    .where(
      and(
        eq(librarianWikis.orgId, fence.orgId),
        eq(librarianWikis.projectId, run.wikiId),
        eq(projects.orgId, fence.orgId),
        eq(projects.kind, "wiki"),
      ),
    );
  const [token] = config.tokenId ? await tx.select().from(tokens).where(eq(tokens.id, config.tokenId)) : [];
  const [key] = await tx.select().from(librarianKeys).where(eq(librarianKeys.orgId, fence.orgId));
  if (
    !wiki ||
    !key ||
    !token ||
    token.orgId !== fence.orgId ||
    token.kind !== "org" ||
    token.revokedAt ||
    (token.expiresAt && token.expiresAt <= now) ||
    !token.projectIds?.includes(run.wikiId) ||
    !(["read", "comment", "edit", "publish"] as const).every((scope) => token.scopes.includes(scope))
  )
    return blocked();
  const [month] = await tx
    .select()
    .from(librarianMonths)
    .where(and(eq(librarianMonths.orgId, fence.orgId), eq(librarianMonths.month, run.month)));
  if (
    !month ||
    month.settled + month.uncertain + month.reserved > config.monthlyLimit ||
    run.cap > config.runLimit
  )
    return blocked();
  return run;
}
/** Callback must be DB-only; acquire the content lock and can()/agentPolicy() inside it. */
export async function withRunFence<T>(deps: Deps, fence: RunFence, use: (tx: Tx) => Promise<T>): Promise<T> {
  return locked(deps, fence.orgId, async (tx) => {
    await guard(deps, tx, fence);
    return use(tx);
  });
}
export async function heartbeatRun(deps: Deps, fence: RunFence): Promise<void> {
  await withRunFence(deps, fence, async (tx) => {
    await tx
      .update(librarianRuns)
      .set({ leaseExpiresAt: new Date(deps.clock.now().getTime() + LEASE_MS) })
      .where(eq(librarianRuns.id, fence.runId));
  });
}
/** Pending attempts are charged in full on any terminal/crash path; only proven unspent funds release. */
export async function finishLocked(
  deps: Deps,
  tx: Tx,
  run: typeof librarianRuns.$inferSelect,
  state: string,
) {
  if (run.state !== "running") return;
  // Ownership records commit with Delegate start and survive until terminal accounting.
  const ownership = await tx
    .select()
    .from(librarianReceipts)
    .where(and(eq(librarianReceipts.orgId, run.orgId), eq(librarianReceipts.runId, run.id)));
  for (const receipt of ownership) {
    const value = receipt.result as { kind?: string; editRunId?: string } | null;
    if (value?.kind !== "delegate_ownership" || !value.editRunId) continue;
    const closed = await tx
      .update(editRuns)
      .set({ status: "cancelled", finishedAt: deps.clock.now() })
      .where(
        and(eq(editRuns.id, value.editRunId), eq(editRuns.orgId, run.orgId), eq(editRuns.status, "active")),
      )
      .returning();
    for (const edit of closed) {
      await tx.insert(activity).values({
        id: crypto.randomUUID(),
        orgId: run.orgId,
        artifactId: edit.artifactId,
        projectId: run.wikiId,
        actorPersonId: edit.startedBy,
        agent: edit.agent,
        kind: "run_finished",
        payload: { run: edit.id, status: "cancelled", librarianRun: run.id },
        createdAt: deps.clock.now(),
      });
      afterCommit(tx, () =>
        deps.docs?.notify(edit.artifactId, "c", { t: "run", id: edit.id, status: "cancelled" }),
      );
    }
  }
  await tx.insert(librarianEvents).values({
    id: crypto.randomUUID(),
    orgId: run.orgId,
    runId: run.id,
    code: state,
    createdAt: deps.clock.now(),
  });
  const pending = await tx
    .select()
    .from(librarianAttempts)
    .where(and(eq(librarianAttempts.runId, run.id), eq(librarianAttempts.state, "reserved")));
  const uncertain = pending.reduce((n, a) => n + a.ceiling, 0n);
  for (const a of pending)
    await tx
      .update(librarianAttempts)
      .set({ state: "uncertain", charged: a.ceiling })
      .where(eq(librarianAttempts.id, a.id));
  await tx
    .update(librarianMonths)
    .set({
      reserved: sql`${librarianMonths.reserved} - ${run.reserved}`,
      uncertain: sql`${librarianMonths.uncertain} + ${uncertain}`,
    })
    .where(and(eq(librarianMonths.orgId, run.orgId), eq(librarianMonths.month, run.month)));
  if (run.inboxId)
    await tx
      .update(librarianInbox)
      .set({
        status:
          state === "succeeded"
            ? "done"
            : state === "waiting_human"
              ? "waiting_human"
              : state === "cancelled"
                ? "cancelled"
                : "failed",
        updatedAt: deps.clock.now(),
      })
      .where(
        and(
          eq(librarianInbox.id, run.inboxId),
          eq(librarianInbox.orgId, run.orgId),
          sql`${librarianInbox.status} <> 'cancelled'`,
        ),
      );
  await tx
    .update(librarianRuns)
    .set({
      state,
      reserved: 0n,
      uncertain: run.uncertain + uncertain,
      fence: run.fence + 1,
      finishedAt: deps.clock.now(),
    })
    .where(eq(librarianRuns.id, run.id));
}
export async function cancelRun(deps: Deps, orgId: string, runId: string): Promise<void> {
  await locked(deps, orgId, async (tx) => {
    const [run] = await tx
      .select()
      .from(librarianRuns)
      .where(and(eq(librarianRuns.id, runId), eq(librarianRuns.orgId, orgId)));
    if (run) await finishLocked(deps, tx, run, "cancelled");
  });
}
export async function reapExpiredRuns(deps: Deps): Promise<void> {
  const rows = await deps.db.select().from(librarianRuns).where(eq(librarianRuns.state, "running"));
  for (const row of rows)
    await locked(deps, row.orgId, async (tx) => {
      const [run] = await tx.select().from(librarianRuns).where(eq(librarianRuns.id, row.id));
      if (run && (run.leaseExpiresAt <= deps.clock.now() || run.deadline <= deps.clock.now()))
        await finishLocked(deps, tx, run, "interrupted");
    });
}

export async function finishRun(
  deps: Deps,
  fence: RunFence,
  state: "waiting_human" | "succeeded" | "failed" | "budget_exhausted" | "interrupted",
): Promise<void> {
  await withRunFence(deps, fence, async (tx) => {
    const run = await guard(deps, tx, fence);
    await finishLocked(deps, tx, run, state);
  });
}
