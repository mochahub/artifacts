import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Deps } from "../api/deps.ts";
import { blobs } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";

export const blobKey = (hash: string) => `blobs/${hash}`;
export const IMMUTABLE = "public, max-age=31536000, immutable";

/** Runs at most `limit` at a time. */
export async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index] as T);
      }
    }),
  );
  return results;
}

export async function knownBlobs(deps: Deps, orgId: string, hashes: string[]): Promise<Map<string, number>> {
  const known = new Map<string, number>();
  for (let i = 0; i < hashes.length; i += 1000) {
    const rows = await deps.db
      .select({ hash: blobs.hash, size: blobs.size })
      .from(blobs)
      .where(and(eq(blobs.orgId, orgId), inArray(blobs.hash, hashes.slice(i, i + 1000))));
    for (const row of rows) known.set(row.hash, row.size);
  }
  return known;
}

/**
 * Proves every hash: known ones by their row, the rest by downloading and hashing them (05). The
 * bucket can't be taken at its word, because anyone with a presigned PUT chose what went there.
 * A size of null means the caller didn't declare one.
 */
export async function verifyBlobs(deps: Deps, orgId: string, wanted: Map<string, number | null>) {
  const hashes = [...wanted.keys()];
  const known = await knownBlobs(deps, orgId, hashes);
  const unverified = hashes.filter((hash) => !known.has(hash));

  for (const hash of hashes) {
    const size = known.get(hash);
    const declared = wanted.get(hash);
    if (size !== undefined && declared !== null && size !== declared) {
      throw new ApiError("invalid", `File ${hash} has size ${size}, not ${declared}.`);
    }
  }
  const proved = await mapLimit(unverified, 6, async (hash) => {
    const object = await deps.bucket.get(blobKey(hash));
    if (!object) throw new ApiError("invalid", `File ${hash} was never uploaded.`);
    const actual = createHash("sha256").update(object.body).digest("hex");
    const declared = wanted.get(hash);
    if (actual !== hash || (declared !== null && object.body.length !== declared)) {
      await deps.bucket.delete(blobKey(hash));
      throw new ApiError("invalid", `File ${hash} doesn't match what was uploaded.`);
    }
    return { orgId, hash, size: object.body.length, verifiedAt: deps.clock.now() };
  });
  for (let i = 0; i < proved.length; i += 1000) {
    await deps.db
      .insert(blobs)
      .values(proved.slice(i, i + 1000))
      .onConflictDoNothing();
  }
}

/** Stores bytes the server made itself, such as re-sanitized article HTML. */
export async function putBlob(deps: Deps, orgId: string, body: Uint8Array, contentType: string) {
  const hash = createHash("sha256").update(body).digest("hex");
  if ((await knownBlobs(deps, orgId, [hash])).has(hash)) return hash;
  await deps.bucket.put(blobKey(hash), body, { contentType, cacheControl: IMMUTABLE });
  await deps.db
    .insert(blobs)
    .values({ orgId, hash, size: body.length, verifiedAt: deps.clock.now() })
    .onConflictDoNothing();
  return hash;
}
