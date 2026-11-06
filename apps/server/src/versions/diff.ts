import { eq } from "drizzle-orm";
import type { Db, Tx } from "../db/index.ts";
import { blocks, frames } from "../db/schema.ts";

/** Content hashes by `page/key`: frame and block keys are per page. */
export type Keyed = Map<string, string>;
export type VersionHashes = { frames: Keyed; blocks: Keyed };

export const keyOf = (pageKey: string, key: string) => `${pageKey}/${key}`;

export const frameHashes = (rows: { pageKey: string; frameKey: string; contentHash: string }[]): Keyed =>
  new Map(rows.map((row) => [keyOf(row.pageKey, row.frameKey), row.contentHash]));

export const blockHashes = (rows: { pageKey: string; blockKey: string; contentHash: string }[]): Keyed =>
  new Map(rows.map((row) => [keyOf(row.pageKey, row.blockKey), row.contentHash]));

export const NOTHING: VersionHashes = { frames: new Map(), blocks: new Map() };

/** What a version holds, as hashes. Everything that compares two versions starts here. */
export async function hashesOf(db: Pick<Db | Tx, "select">, versionId: string): Promise<VersionHashes> {
  const [frameRows, blockRows] = await Promise.all([
    db
      .select({ pageKey: frames.pageKey, frameKey: frames.frameKey, contentHash: frames.contentHash })
      .from(frames)
      .where(eq(frames.versionId, versionId)),
    db
      .select({ pageKey: blocks.pageKey, blockKey: blocks.blockKey, contentHash: blocks.contentHash })
      .from(blocks)
      .where(eq(blocks.versionId, versionId)),
  ]);
  return { frames: frameHashes(frameRows), blocks: blockHashes(blockRows) };
}

export type Changes = { added: string[]; removed: string[]; changed: string[] };

/** Keys only in `after`, only in `before`, and in both with different content. */
export const changes = (before: Keyed, after: Keyed): Changes => ({
  added: [...after.keys()].filter((key) => !before.has(key)),
  removed: [...before.keys()].filter((key) => !after.has(key)),
  changed: [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key)),
});

/** Added or changed: what a reader sees as new in `after`. */
export const isNew = (before: Keyed, after: Keyed, key: string) => before.get(key) !== after.get(key);
