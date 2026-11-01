import { and, gt, inArray, lt, sql } from "drizzle-orm";
import type { Deps } from "../api/deps.ts";
import { expireLogs } from "../content/proxy.ts";
import { recountUsage } from "../data/store.ts";
import {
  artifacts,
  artifactUsage,
  blobs,
  deviceCodes,
  frames,
  invites,
  oauthClients,
  oauthCodes,
  oauthRefreshTokens,
  pages,
  resetLinks,
  sessions,
  threads,
  versions,
  webauthnChallenges,
} from "../db/schema.ts";
import { sendDigest } from "../push/notify.ts";
import { purgeExpired } from "./purge.ts";

const DAY = 24 * 3600_000;
const JOB_LOCK = 7_316_004;
const GC_MIN_AGE_MS = DAY;
const FIRST_RUN_MS = 60_000;

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
  const cutoff = deps.clock.now().getTime() - GC_MIN_AGE_MS;
  const hashOf = (key: string) => key.slice("blobs/".length);
  let cursor: string | undefined;
  let deleted = 0;
  let bytes = 0;
  do {
    const page = await deps.bucket.list("blobs/", { cursor });
    const old = page.objects.filter((object) => object.updatedAt.getTime() < cutoff);
    if (old.length > 0) {
      // Fresh for every page. Rows go first, so a publish reusing one of these can't commit.
      const referenced = await referencedHashes(deps);
      const stale = old.filter((object) => !referenced.has(hashOf(object.key)));
      if (stale.length > 0) {
        await deps.db.delete(blobs).where(
          inArray(
            blobs.hash,
            stale.map((object) => hashOf(object.key)),
          ),
        );
        const still = await referencedHashes(deps);
        const gone = stale.filter((object) => !still.has(hashOf(object.key)));
        await Promise.all(gone.map((object) => deps.bucket.delete(object.key)));
        deleted += gone.length;
        bytes += gone.reduce((sum, object) => sum + object.size, 0);
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  await sweepOrphans(deps, cutoff);
  deps.log.info("garbage collected", { deleted, bytes });
  return { deleted, bytes };
}

const UUID_AT = /^(?:crops|data)\/([0-9a-f-]{36})/;

/** What a purge's bucket step left behind, if the bucket failed after the rows were gone. */
async function sweepOrphans(deps: Deps, cutoff: number) {
  // Upload plans are only read during one publish, and their signed links last a day at most.
  for (let cursor: string | undefined, more = true; more; ) {
    const page = await deps.bucket.list("plans/", { cursor });
    for (const object of page.objects) {
      if (object.updatedAt.getTime() < cutoff) await deps.bucket.delete(object.key);
    }
    cursor = page.nextCursor ?? undefined;
    more = cursor !== undefined;
  }
  for (const prefix of ["crops/", "data/"]) {
    let cursor: string | undefined;
    do {
      const page = await deps.bucket.list(prefix, { cursor });
      const ids = [...new Set(page.objects.flatMap((object) => UUID_AT.exec(object.key)?.[1] ?? []))];
      // A crop lives while a thread names it as its crop: a purged version clears that, and the thread stays.
      // Data lives while its artifact does.
      const alive = new Set<string>();
      if (ids.length && prefix === "crops/") {
        const keys = page.objects.map((object) => object.key);
        const rows = await deps.db
          .select({ key: threads.cropKey })
          .from(threads)
          .where(inArray(threads.cropKey, keys));
        for (const row of rows) if (row.key) alive.add(row.key);
      } else if (ids.length) {
        const rows = await deps.db
          .select({ id: artifacts.id })
          .from(artifacts)
          .where(inArray(artifacts.id, ids));
        for (const row of rows) alive.add(row.id);
      }
      const dead = page.objects.filter((object) => {
        const id = UUID_AT.exec(object.key)?.[1];
        const name = prefix === "crops/" ? object.key : id;
        return id && name && !alive.has(name) && object.updatedAt.getTime() < cutoff;
      });
      await Promise.all(dead.map((object) => deps.bucket.delete(object.key)));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
}

/** Leftovers (05). */
export async function expireLeftovers(deps: Deps) {
  const now = deps.clock.now();
  const old = new Date(now.getTime() - 30 * DAY);
  await deps.db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, now));
  await deps.db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, now));
  await deps.db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, now));
  await deps.db.delete(oauthRefreshTokens).where(lt(oauthRefreshTokens.expiresAt, now));
  // A client registered and never used, which anyone can make: nothing refers to one.
  await deps.db
    .delete(oauthClients)
    .where(
      and(
        lt(oauthClients.createdAt, old),
        sql`not exists (select 1 from oauth_grants g where g.client_id = ${oauthClients.clientId})`,
      ),
    );
  // Their push subscriptions go with them (cascade): a dead device would otherwise count toward a person's ten.
  await deps.db.delete(sessions).where(lt(sessions.expiresAt, now));
  await deps.db.delete(invites).where(lt(invites.expiresAt, old));
  await deps.db.delete(resetLinks).where(lt(resetLinks.expiresAt, old));
  await expireLogs(deps);
}

/** Recounts usage for artifacts written since yesterday (08). */
export async function recountRecent(deps: Deps) {
  const since = new Date(deps.clock.now().getTime() - 2 * DAY);
  const rows = await deps.db
    .selectDistinct({ artifactId: artifactUsage.artifactId, orgId: artifactUsage.orgId })
    .from(artifactUsage)
    .where(gt(artifactUsage.updatedAt, since));
  for (const row of rows) await recountUsage(deps, row.orgId, row.artifactId);
  return { artifacts: rows.length };
}

export const jobsFor = (deps: Deps): Record<string, () => Promise<unknown>> => ({
  purge: () => purgeExpired(deps),
  gc: () => collectGarbage(deps),
  expire: () => expireLeftovers(deps),
  usage: () => recountRecent(deps),
  digest: () => sendDigest(deps),
});

/** Once a day, on one replica at a time (05). */
export function startJobs(deps: Deps) {
  // Sent after the lock's transaction: it waits on push services, and holds nothing shared.
  const { digest, ...jobs } = jobsFor(deps);
  const run = async () => {
    const reserved = await deps.db.transaction(async (tx) => {
      const [{ locked } = { locked: false }] = (await tx.execute(
        sql`select pg_try_advisory_xact_lock(${JOB_LOCK}) as locked`,
      )) as unknown as { locked: boolean }[];
      if (!locked) return false;
      for (const [name, job] of Object.entries(jobs)) {
        try {
          await job();
        } catch (error) {
          deps.log.error("job failed", { name, error: String(error) });
        }
      }
      return true;
    });
    if (reserved) await digest?.();
    return reserved;
  };
  const tick = () => run().catch((error) => deps.log.error("jobs failed", { error: String(error) }));
  // Soon after boot too: a server redeployed daily would otherwise never reach its first run.
  const first = setTimeout(tick, FIRST_RUN_MS);
  const timer = setInterval(tick, DAY);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
