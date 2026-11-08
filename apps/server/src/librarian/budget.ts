import { and, eq, inArray, sql } from "drizzle-orm";
import {
  librarianAttempts,
  librarianConfig,
  librarianEvents,
  librarianInbox,
  librarianMonths,
  librarianRuns,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { blocked, guard, LEASE_MS, locked, type RunFence, withRunFence } from "./leases.ts";

/** Internal trusted scheduler only. No route can select a provider or request dispatch. */
export async function claimRun(
  deps: Deps,
  input: { orgId: string; wikiId: string; owner: string; inboxId?: string; daily?: boolean },
): Promise<RunFence | null> {
  if (!deps.env.librarianAllowed) return null;
  return locked(deps, input.orgId, async (tx) => {
    const [c] = await tx.select().from(librarianConfig).where(eq(librarianConfig.orgId, input.orgId));
    if (!c?.enabled || !c.rateCard || c.runLimit <= 0n) return null;
    const active = await tx
      .select()
      .from(librarianRuns)
      .where(and(eq(librarianRuns.orgId, input.orgId), eq(librarianRuns.state, "running")));
    if (active.length) return null;
    const now = deps.clock.now(),
      month = now.toISOString().slice(0, 7);
    await tx.insert(librarianMonths).values({ orgId: input.orgId, month }).onConflictDoNothing();
    const [m] = await tx
      .select()
      .from(librarianMonths)
      .where(and(eq(librarianMonths.orgId, input.orgId), eq(librarianMonths.month, month)))
      .for("update");
    if (!m || m.settled + m.uncertain + m.reserved + c.runLimit > c.monthlyLimit) return null;
    let inboxId: string | undefined;
    if (input.inboxId) {
      const [item] = await tx
        .select()
        .from(librarianInbox)
        .where(
          and(
            eq(librarianInbox.id, input.inboxId),
            eq(librarianInbox.orgId, input.orgId),
            eq(librarianInbox.wikiId, input.wikiId),
            inArray(librarianInbox.status, ["queued", "ready"]),
          ),
        )
        .for("update");
      if (!item || item.runId) return null;
      inboxId = item.id;
    }
    const dailyKey = input.daily ? now.toISOString().slice(0, 10) : null;
    if (dailyKey) {
      const [prior] = await tx
        .select({ id: librarianRuns.id })
        .from(librarianRuns)
        .where(
          and(
            eq(librarianRuns.orgId, input.orgId),
            eq(librarianRuns.wikiId, input.wikiId),
            eq(librarianRuns.dailyKey, dailyKey),
          ),
        );
      if (prior) return null;
    }
    const runId = crypto.randomUUID();
    const fence = {
      orgId: input.orgId,
      runId,
      owner: input.owner,
      fence: c.generation,
      configGeneration: c.generation,
    };
    await tx.insert(librarianRuns).values({
      id: runId,
      inboxId,
      dailyKey,
      orgId: input.orgId,
      wikiId: input.wikiId,
      state: "running",
      model: c.model,
      configGeneration: c.generation,
      rateCard: c.rateCard,
      owner: input.owner,
      fence: fence.fence,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      deadline: new Date(now.getTime() + 600_000),
      month,
      cap: c.runLimit,
      reserved: c.runLimit,
      startedAt: now,
    });
    await tx
      .update(librarianMonths)
      .set({ reserved: m.reserved + c.runLimit })
      .where(and(eq(librarianMonths.orgId, input.orgId), eq(librarianMonths.month, month)));
    await tx
      .insert(librarianEvents)
      .values({ id: crypto.randomUUID(), orgId: input.orgId, runId, code: "claimed", createdAt: now });
    if (inboxId)
      await tx
        .update(librarianInbox)
        .set({ runId, status: "running", updatedAt: now })
        .where(eq(librarianInbox.id, inboxId));
    await guard(deps, tx, fence);
    return fence;
  });
}
export async function reserveAttempt(
  deps: Deps,
  fence: RunFence,
  input: { attemptId: string; ceilingMicrousd: bigint },
): Promise<void> {
  if (input.ceilingMicrousd <= 0n) return blocked();
  await withRunFence(deps, fence, async (tx) => {
    const [run] = await tx.select().from(librarianRuns).where(eq(librarianRuns.id, fence.runId));
    if (!run) return blocked();
    const attempts = await tx.select().from(librarianAttempts).where(eq(librarianAttempts.runId, run.id));
    const same = attempts.find((a) => a.id === input.attemptId);
    if (same) {
      if (same.ceiling !== input.ceilingMicrousd || same.state !== "reserved") return blocked();
      return;
    }
    const held = attempts.filter((a) => a.state === "reserved").reduce((n, a) => n + a.ceiling, 0n);
    if (held + input.ceilingMicrousd > run.reserved) return blocked();
    await tx.insert(librarianAttempts).values({
      orgId: fence.orgId,
      id: input.attemptId,
      runId: run.id,
      state: "reserved",
      ceiling: input.ceilingMicrousd,
    });
  });
}
/** Settlement works after kill/expiry too. A late response never refunds previously uncertain spend. */
export async function settleAttempt(
  deps: Deps,
  input: {
    orgId: string;
    runId: string;
    attemptId: string;
    outcome: "settled" | "uncertain";
    actualMicrousd?: bigint;
    requestId?: string;
  },
): Promise<void> {
  await locked(deps, input.orgId, async (tx) => {
    const [run] = await tx
      .select()
      .from(librarianRuns)
      .where(and(eq(librarianRuns.id, input.runId), eq(librarianRuns.orgId, input.orgId)));
    const [a] = await tx
      .select()
      .from(librarianAttempts)
      .where(and(eq(librarianAttempts.id, input.attemptId), eq(librarianAttempts.runId, input.runId)));
    if (!run || !a) return blocked();
    const charge = input.outcome === "uncertain" ? a.ceiling : input.actualMicrousd;
    if (
      charge === undefined ||
      charge < 0n ||
      charge > a.ceiling ||
      (input.outcome === "settled" && !input.requestId)
    )
      return blocked();
    if (a.state !== "reserved") {
      if (a.state === input.outcome && a.charged === charge && a.requestId === (input.requestId ?? null))
        return;
      return blocked();
    }
    await tx
      .update(librarianAttempts)
      .set({ state: input.outcome, charged: charge, requestId: input.requestId ?? null })
      .where(eq(librarianAttempts.id, a.id));
    const field = input.outcome === "settled" ? "settled" : "uncertain";
    await tx
      .update(librarianRuns)
      .set({ [field]: run[field] + charge, reserved: run.reserved - charge })
      .where(eq(librarianRuns.id, run.id));
    await tx
      .update(librarianMonths)
      .set({
        [field]: sql`${librarianMonths[field]} + ${charge}`,
        reserved: sql`${librarianMonths.reserved} - ${charge}`,
      })
      .where(and(eq(librarianMonths.orgId, run.orgId), eq(librarianMonths.month, run.month)));
  });
}
