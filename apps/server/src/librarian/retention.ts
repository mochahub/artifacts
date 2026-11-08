import { and, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import {
  librarianAttempts,
  librarianConfig,
  librarianEvents,
  librarianInbox,
  librarianMonths,
  librarianReceipts,
  librarianRuns,
  tokens,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { cleanupQuarantine, deleteSourceQuarantine } from "./ingestion/index.ts";
import { cancelRun, locked } from "./leases.ts";

/** Delete bucket data before clearing its reference, so a failed delete is retried. */
export async function retainLibrarian(deps: Deps): Promise<void> {
  const now = deps.clock.now();
  const raw = await deps.db
    .select()
    .from(librarianInbox)
    .where(or(lt(librarianInbox.rawExpiresAt, now), isNotNull(librarianInbox.sourceArtifactId)));
  const orgIds = new Set(
    (await deps.db.select({ orgId: librarianConfig.orgId }).from(librarianConfig)).map((r) => r.orgId),
  );
  for (const orgId of orgIds) await cleanupQuarantine(deps, orgId);
  for (const item of raw) {
    await deleteSourceQuarantine(deps, item.orgId, item.id);
    await locked(deps, item.orgId, async (tx) => {
      const [current] = await tx.select().from(librarianInbox).where(eq(librarianInbox.id, item.id));
      if (!current || !(current.rawExpiresAt < now || current.sourceArtifactId)) return;
      await tx
        .update(librarianInbox)
        .set({ input: null, note: null, quarantineKey: null })
        .where(eq(librarianInbox.id, item.id));
    });
  }
  const cutoff = new Date(now.getTime() - 90 * 86_400_000);
  const old = await deps.db
    .select()
    .from(librarianRuns)
    .where(and(isNotNull(librarianRuns.finishedAt), lt(librarianRuns.finishedAt, cutoff)));
  for (const run of old)
    await locked(deps, run.orgId, async (tx) => {
      // Terminal run tombstones keep inbox/daily dedup and proposals referentially intact.
      if (run.state === "running") return;
      await tx.delete(librarianReceipts).where(eq(librarianReceipts.runId, run.id));
      await tx.delete(librarianEvents).where(eq(librarianEvents.runId, run.id));
      await tx.delete(librarianAttempts).where(eq(librarianAttempts.runId, run.id));
    });
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1)).toISOString().slice(0, 7);
  await deps.db
    .delete(librarianMonths)
    .where(
      and(
        lt(librarianMonths.month, month),
        eq(librarianMonths.reserved, 0n),
        sql`not exists (select 1 from librarian_runs r where r.org_id = ${librarianMonths.orgId} and r.month = ${librarianMonths.month} and r.state = 'running')`,
      ),
    );
}

/** After account revocation commits: clear private submissions and cancel their executable runs.
 * Failed bucket deletion leaves rawExpiresAt due so the retention job retries. */
export async function purgeSubmittedSources(deps: Deps, orgId: string, personId: string): Promise<void> {
  const owned = await deps.db
    .select({ id: tokens.id })
    .from(tokens)
    .where(and(eq(tokens.orgId, orgId), eq(tokens.createdBy, personId)));
  const ids = [personId, ...owned.map((t) => t.id)];
  const rows = await deps.db
    .select()
    .from(librarianInbox)
    .where(and(eq(librarianInbox.orgId, orgId), inArray(librarianInbox.submittedBy, ids)));
  for (const row of rows) {
    await deps.db
      .update(librarianInbox)
      .set({ rawExpiresAt: deps.clock.now() })
      .where(eq(librarianInbox.id, row.id));
    if (row.runId) await cancelRun(deps, orgId, row.runId);
    await deleteSourceQuarantine(deps, orgId, row.id);
    await locked(deps, orgId, async (tx) => {
      await tx
        .update(librarianInbox)
        .set({ input: null, note: null, quarantineKey: null })
        .where(eq(librarianInbox.id, row.id));
    });
  }
}
