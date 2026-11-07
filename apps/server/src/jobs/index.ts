import { DAY_MS } from "@artifacts/schema";
import { and, gt, inArray, lt, sql } from "drizzle-orm";
import { sweepBoardUploads } from "../boards/assets.ts";
import { sweepCaptures } from "../boards/checkpoint.ts";
import { expireBoardSuggestions } from "../boards/suggestions.ts";
import { expireLogs } from "../data/logs.ts";
import { recountUsage } from "../data/store.ts";
import { tryLockJobs } from "../db/locks.ts";
import {
  artifacts,
  artifactUsage,
  blobs,
  brandProposals,
  deviceCodes,
  frames,
  googleStates,
  invites,
  oauthClients,
  oauthCodes,
  oauthRefreshTokens,
  org,
  pages,
  resetLinks,
  sessions,
  threads,
  versions,
  webauthnChallenges,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { BLOBS, CROPS, DATA, hashOf, PLANS } from "../layout.ts";
import { sendDigest } from "../push/notify.ts";
import { startEditingSweep } from "./editing.ts";
import { purgeExpired } from "./purge.ts";

const GC_MIN_AGE_MS = DAY_MS;
const FIRST_RUN_MS = 60_000;

/** Every hash still in use: a version's files, renders and pages, and a brand's fonts (05, "Collect garbage"). */
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
    for (const file of Object.values(row.files)) add(file.hash);
  }
  for (const row of await deps.db.select({ renders: frames.renders }).from(frames)) {
    for (const hash of Object.values(row.renders)) add(hash);
  }
  // A brand's fonts outlive the sample that brought them: the brand, and any proposal of it, still use them.
  for (const row of await deps.db.select({ brand: org.brand }).from(org)) {
    for (const font of row.brand?.fonts ?? []) add(font.hash);
  }
  for (const row of await deps.db.select({ brand: brandProposals.brand }).from(brandProposals)) {
    for (const font of row.brand.fonts ?? []) add(font.hash);
  }
  for (const row of await deps.db.select({ meta: pages.meta }).from(pages)) {
    add(row.meta.htmlHash);
    for (const item of row.meta.items ?? []) add(item.hash);
  }
  // Native boards (14): a version's source images and pictures, and every image associated with a board,
  // which covers drafts, suggestions and pending uploads. Read as hashes, never whole snapshots.
  const boardRows = await deps.db.execute(sql`
    select a ->> 'hash' as hash from board_versions, jsonb_array_elements(snapshot -> 'assets') a
    union select renders -> 'thumbnail' ->> 'hash' from board_versions where renders is not null
    union select c -> 'image' ->> 'hash'
      from board_versions, jsonb_array_elements(coalesce(renders -> 'crops', '[]'::jsonb)) c
    union select hash from board_assets`);
  for (const row of boardRows as unknown as { hash: string | null }[]) add(row.hash);
  return referenced;
}

/** Deletes blobs nothing uses, once they're a day old, so an upload awaiting commit is safe. */
export async function collectGarbage(deps: Deps) {
  const cutoff = deps.clock.now().getTime() - GC_MIN_AGE_MS;
  let deleted = 0;
  let bytes = 0;
  for await (const objects of deps.bucket.listAll(BLOBS)) {
    const old = objects.filter((object) => object.updatedAt.getTime() < cutoff);
    if (old.length === 0) continue;
    // Fresh for every page. Rows go first, so a publish reusing one of these can't commit.
    const referenced = await referencedHashes(deps);
    const stale = old.filter((object) => !referenced.has(hashOf(object.key)));
    if (stale.length === 0) continue;
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
  await sweepOrphans(deps, cutoff);
  deps.log.info("garbage collected", { deleted, bytes });
  return { deleted, bytes };
}

const UUID_AT = /^(?:crops|data)\/([0-9a-f-]{36})/;

/** What a purge's bucket step left behind, if the bucket failed after the rows were gone. */
async function sweepOrphans(deps: Deps, cutoff: number) {
  // Upload plans are only read during one publish, and their signed links last a day at most.
  for await (const objects of deps.bucket.listAll(PLANS)) {
    for (const object of objects) {
      if (object.updatedAt.getTime() < cutoff) await deps.bucket.delete(object.key);
    }
  }
  for (const prefix of [CROPS, DATA]) {
    for await (const objects of deps.bucket.listAll(prefix)) {
      const ids = [...new Set(objects.flatMap((object) => UUID_AT.exec(object.key)?.[1] ?? []))];
      // A crop lives while a thread names it as its crop: a purged version clears that, and the thread stays.
      // Data lives while its artifact does.
      const alive = new Set<string>();
      if (ids.length && prefix === CROPS) {
        const keys = objects.map((object) => object.key);
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
      const dead = objects.filter((object) => {
        const id = UUID_AT.exec(object.key)?.[1];
        const name = prefix === CROPS ? object.key : id;
        return id && name && !alive.has(name) && object.updatedAt.getTime() < cutoff;
      });
      await Promise.all(dead.map((object) => deps.bucket.delete(object.key)));
    }
  }
}

/** Leftovers (05). */
export async function expireLeftovers(deps: Deps) {
  const now = deps.clock.now();
  const old = new Date(now.getTime() - 30 * DAY_MS);
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
  await deps.db.delete(googleStates).where(lt(googleStates.expiresAt, now));

  await deps.db.delete(invites).where(lt(invites.expiresAt, old));
  await deps.db.delete(resetLinks).where(lt(resetLinks.expiresAt, old));
  await expireLogs(deps);
  // Boards (14): capture tickets, unattached uploads, suggestions past expiry and receipts of retired epochs.
  await sweepCaptures(deps);
  await sweepBoardUploads(deps);
  await expireBoardSuggestions(deps);
  await deps.db.execute(sql`
    delete from board_requests r using edit_docs d
    where d.artifact_id = r.artifact_id and r.epoch < d.epoch`);
}

/** Recounts usage for artifacts written since yesterday (08). */
export async function recountRecent(deps: Deps) {
  const since = new Date(deps.clock.now().getTime() - 2 * DAY_MS);
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
      if (!(await tryLockJobs(tx))) return false;
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
  const timer = setInterval(tick, DAY_MS);
  const stopSweep = startEditingSweep(deps);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    stopSweep();
  };
}
