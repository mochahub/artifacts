import { sql } from "drizzle-orm";
import type { Tx } from "./index.ts";

/** Advisory lock ids, so no two things that must happen one at a time share one by accident. */
const SETUP = 7_316_002;
const OWNERS = 7_316_003;
const JOBS = 7_316_004;

/**
 * An artifact's locks. `content` is publish, restore, archive, delete and purge, so nothing changes under
 * a publish in progress (03). `threads` hands out thread numbers, which are per artifact and never reused.
 */
const ARTIFACT = { content: 0, threads: 1 } as const;

export const lockArtifact = (tx: Tx, artifactId: string, purpose: keyof typeof ARTIFACT) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${artifactId}, ${sql.raw(String(ARTIFACT[purpose]))}))`,
  );

/** Two claims at once must not both create an organization. */
export const lockSetup = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock(${SETUP})`);

/** Changes to who is an owner, so the last one can't be removed by two requests at once. */
export const lockOwners = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock(${OWNERS})`);

/** The daily jobs: whichever replica gets this runs them, and the others skip the day. */
export async function tryLockJobs(tx: Tx): Promise<boolean> {
  const [row] = (await tx.execute(sql`select pg_try_advisory_xact_lock(${JOBS}) as locked`)) as unknown as {
    locked: boolean;
  }[];
  return row?.locked ?? false;
}
