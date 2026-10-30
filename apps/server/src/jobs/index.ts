import { inArray, lt, sql } from "drizzle-orm";
import type { Deps } from "../api/deps.ts";
import {
  blobs,
  deviceCodes,
  frames,
  invites,
  pages,
  resetLinks,
  versions,
  webauthnChallenges,
} from "../db/schema.ts";
import { purgeExpired } from "./purge.ts";

const DAY = 24 * 3600_000;
const JOB_LOCK = 7_316_004;
const GC_MIN_AGE_MS = DAY;

/** Every hash a version still needs (05, "Collect garbage"). */
async function referencedHashes(deps: Deps) {
  const referenced = new Set<string>();
  const add = (hash: unknown) => {
    if (typeof hash === "string") referenced.add(hash);
  };
  const versionRows = await deps.db
    .select({ files: versions.files, backend: versions.backendHash })
    .from(versions);
  for (const row of versionRows) {
    add(row.backend);
    for (const file of Object.values(row.files as Record<string, { hash: string }>)) add(file.hash);
  }
  for (const row of await deps.db.select({ renders: frames.renders }).from(frames)) {
    for (const hash of Object.values(row.renders as Record<string, string>)) add(hash);
  }
  for (const row of await deps.db.select({ meta: pages.meta }).from(pages)) {
    const meta = row.meta as { htmlHash?: string; items?: { hash: string }[] };
    add(meta.htmlHash);
    for (const item of meta.items ?? []) add(item.hash);
  }
  return referenced;
}

/** Deletes blobs nothing uses, once they're a day old, so an upload awaiting commit is safe. */
export async function collectGarbage(deps: Deps) {
  const referenced = await referencedHashes(deps);
  const cutoff = deps.clock.now().getTime() - GC_MIN_AGE_MS;
  let cursor: string | undefined;
  let deleted = 0;
  let bytes = 0;
  do {
    const page = await deps.bucket.list("blobs/", { cursor });
    const stale = page.objects.filter(
      (object) => !referenced.has(object.key.slice("blobs/".length)) && object.updatedAt.getTime() < cutoff,
    );
    await Promise.all(stale.map((object) => deps.bucket.delete(object.key)));
    if (stale.length > 0) {
      await deps.db.delete(blobs).where(
        inArray(
          blobs.hash,
          stale.map((object) => object.key.slice("blobs/".length)),
        ),
      );
    }
    deleted += stale.length;
    bytes += stale.reduce((sum, object) => sum + object.size, 0);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  deps.log.info("garbage collected", { deleted, bytes });
  return { deleted, bytes };
}

/** Leftovers (05). */
export async function expireLeftovers(deps: Deps) {
  const now = deps.clock.now();
  const old = new Date(now.getTime() - 30 * DAY);
  await deps.db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, now));
  await deps.db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, now));
  await deps.db.delete(invites).where(lt(invites.expiresAt, old));
  await deps.db.delete(resetLinks).where(lt(resetLinks.expiresAt, old));
}

export const jobsFor = (deps: Deps): Record<string, () => Promise<unknown>> => ({
  purge: () => purgeExpired(deps),
  gc: () => collectGarbage(deps),
  expire: () => expireLeftovers(deps),
});

/** Once a day, on one replica at a time (05). */
export function startJobs(deps: Deps) {
  const jobs = jobsFor(deps);
  const run = async () => {
    const reserved = await deps.db.transaction(async (tx) => {
      const [{ locked } = { locked: false }] = (await tx.execute(
        sql`select pg_try_advisory_xact_lock(${JOB_LOCK}) as locked`,
      )) as unknown as { locked: boolean }[];
      if (!locked) return;
      for (const [name, job] of Object.entries(jobs)) {
        try {
          await job();
        } catch (error) {
          deps.log.error("job failed", { name, error: String(error) });
        }
      }
    });
    return reserved;
  };
  const timer = setInterval(
    () => run().catch((error) => deps.log.error("jobs failed", { error: String(error) })),
    DAY,
  );
  return () => clearInterval(timer);
}
