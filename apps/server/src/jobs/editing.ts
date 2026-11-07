import { EDIT_DRAFT_MAX_MS, EDIT_LEAVE_MS, EDIT_QUIET_MS, HOUR_MS, PRESENCE_TTL_MS } from "@artifacts/schema";
import { and, asc, eq, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { artifacts, editDocs, editPresence, projects, suggestions } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { checkpointLocked } from "../editing/checkpoint.ts";
import { expireRuns } from "../editing/runs.ts";
import type { DocLock } from "../editing/store.ts";

const SWEEP_MS = 30_000;
const BATCH = 50;
// A draft that fails to checkpoint waits 30 s, then twice as long each time, up to an hour (below).

/**
 * The editing sweep (13, "Checkpoints"), every 30 seconds on every replica: a dirty draft checkpoints as
 * `quiet` after a quiet spell, when it's been dirty too long, or soon after its last editor left. Each page
 * is taken with a try-lock on the artifact's lock, so one replica does it and nobody waits.
 */
export async function sweepDrafts(deps: Deps) {
  const now = deps.clock.now().getTime();
  const at = (ms: number) => new Date(now - ms);
  const fresh = sql`exists (select 1 from ${editPresence} where ${editPresence.artifactId} = ${editDocs.artifactId} and ${editPresence.seenAt} > ${at(EDIT_LEAVE_MS).toISOString()}::timestamptz)`;
  const due = await deps.db
    .select({ id: editDocs.artifactId })
    .from(editDocs)
    .where(
      and(
        sql`length(${editDocs.snapshot}) > 0`,
        or(ne(editDocs.seq, editDocs.checkpointSeq), isNotNull(editDocs.meta)),
        or(
          lt(editDocs.updatedAt, at(EDIT_QUIET_MS)),
          lt(editDocs.dirtySince, at(EDIT_DRAFT_MAX_MS)),
          and(lt(editDocs.updatedAt, at(EDIT_LEAVE_MS)), sql`not ${fresh}`),
        ),
        // A draft that failed waits out its back-off, so it can't hold the batch or re-send the error.
        sql`coalesce((${editDocs.meta} -> 'sweep' ->> 'next')::timestamptz, '-infinity') <= ${new Date(now).toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(editDocs.updatedAt))
    .limit(BATCH);
  let made = 0;
  for (const { id } of due) {
    const queued: (() => void)[] = [];
    try {
      const created = await deps.db.transaction(async (tx) => {
        const [got] = (await tx.execute(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${id}, 0)) as locked`,
        )) as unknown as { locked: boolean }[];
        if (!got?.locked) return false;
        const [row] = await tx.select().from(editDocs).where(eq(editDocs.artifactId, id)).for("update");
        const [place] = await tx
          .select({ row: artifacts, project: projects })
          .from(artifacts)
          .innerJoin(projects, eq(projects.id, artifacts.projectId))
          .where(eq(artifacts.id, id))
          .limit(1);
        if (!row || !place || place.row.archivedAt || place.row.deletedAt) return false;
        const lock: DocLock = { tx, row, after: (fn) => queued.push(fn) };
        const result = await checkpointLocked(deps, lock, place, {
          kind: "quiet",
          personId: row.lastActorPersonId,
          agent: row.lastAgent,
        });
        // Nothing to save, but a back-off left in the meta would keep it a candidate: clear it.
        if (!result.created && row.meta?.sweep) {
          const { sweep: _done, ...rest } = row.meta;
          await tx
            .update(editDocs)
            .set({ meta: Object.keys(rest).length ? rest : null })
            .where(eq(editDocs.artifactId, id));
        }
        return result.created;
      });
      for (const fn of queued) fn();
      if (created) made += 1;
    } catch (error) {
      // A draft that can't checkpoint stays as it is; the editors were told, and it backs off.
      for (const fn of queued) fn();
      deps.log.warn("quiet checkpoint failed", { artifact: id, error: String(error) });
      await deps.db
        .update(editDocs)
        .set({
          meta: sql`jsonb_set(coalesce(${editDocs.meta}, '{}'::jsonb), '{sweep}', jsonb_build_object(
            'attempts', coalesce((${editDocs.meta} -> 'sweep' ->> 'attempts')::int, 0) + 1,
            'next', to_char((${new Date(now).toISOString()}::timestamptz + make_interval(secs => least(${HOUR_MS / 1000}, ${SWEEP_MS / 1000} * power(2, coalesce((${editDocs.meta} -> 'sweep' ->> 'attempts')::int, 0))))) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))`,
        })
        .where(eq(editDocs.artifactId, id));
    }
  }
  await deps.db.delete(editPresence).where(lt(editPresence.seenAt, at(5 * PRESENCE_TTL_MS)));
  await expireRuns(deps);
  await deps.db
    .update(suggestions)
    .set({ status: "expired", decidedAt: new Date(now) })
    .where(and(eq(suggestions.status, "open"), lt(suggestions.expiresAt, new Date(now))));
  return { checkpoints: made, checked: due.length };
}

export function startEditingSweep(deps: Deps) {
  const tick = () =>
    sweepDrafts(deps).catch((error) => deps.log.error("editing sweep failed", { error: String(error) }));
  const timer = setInterval(tick, SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
