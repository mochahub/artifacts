import { createHash } from "node:crypto";
import { canonicalJSON } from "@artifacts/doc/board";
import type { Anchor } from "@artifacts/schema";
import type { BoardObject, BoardSnapshot } from "@artifacts/schema/boards";
import { and, desc, eq, ne } from "drizzle-orm";
import type { Tx } from "../db/index.ts";
import { blockAliases, boardVersions, threads, versions } from "../db/schema.ts";
import { hashesOf, NOTHING, type VersionHashes } from "../versions/diff.ts";

export type AnchorResult = { anchor: Anchor | null; state: "ok" | "updated" | "orphaned" };
type Keyed = Map<string, string>;
type Block = { key: string; hash: string; text: string };

const THRESHOLD = 0.6;

/** How much of `wanted` matches `actual`, reading outward from the quote. */
function overlap(wanted: string, actual: string, fromEnd: boolean): number {
  if (!wanted) return 1;
  let same = 0;
  const count = Math.min(wanted.length, actual.length);
  for (let i = 1; i <= count; i++) {
    const a = fromEnd ? wanted.at(-i) : wanted[i - 1];
    const b = fromEnd ? actual.at(-i) : actual[i - 1];
    if (a !== b) break;
    same += 1;
  }
  return same / wanted.length;
}

function occurrences(text: string, exact: string): number[] {
  const found: number[] = [];
  if (!exact) return found;
  for (let at = text.indexOf(exact); at !== -1; at = text.indexOf(exact, at + 1)) found.push(at);
  return found;
}

/** 05, "Re-anchoring". `then` is the content at the version the thread was made on. */
export function reanchor(
  anchor: Anchor,
  then: { frames: Keyed; blocks: Keyed; objects?: Keyed },
  now: { frames: Keyed; blocks: Block[]; objects?: Keyed },
): AnchorResult {
  if (anchor.type === "object") {
    // Geometry and order never move a pin's state; content, style or picture does; deletion orphans it.
    const hash = now.objects?.get(anchor.object);
    if (hash === undefined) return { anchor, state: "orphaned" };
    return { anchor, state: hash === then.objects?.get(anchor.object) ? "ok" : "updated" };
  }
  if (anchor.type === "frame") {
    const hash = now.frames.get(anchor.frameKey);
    if (hash === undefined) return { anchor, state: "orphaned" };
    return { anchor, state: hash === then.frames.get(anchor.frameKey) ? "ok" : "updated" };
  }

  const block = now.blocks.find((entry) => entry.key === anchor.blockKey);
  const unchanged = block !== undefined && block.hash === then.blocks.get(anchor.blockKey);
  if (anchor.type === "block") {
    if (!block) return { anchor, state: "orphaned" };
    return { anchor, state: unchanged ? "ok" : "updated" };
  }

  const { exact, prefix, suffix } = anchor.quote;
  if (block && occurrences(block.text, exact).length === 1) {
    return { anchor, state: unchanged ? "ok" : "updated" };
  }
  let best: { key: string; score: number } | null = null;
  for (const entry of now.blocks) {
    for (const at of occurrences(entry.text, exact)) {
      const before = entry.text.slice(Math.max(0, at - prefix.length), at);
      const after = entry.text.slice(at + exact.length, at + exact.length + suffix.length);
      const score = (overlap(prefix, before, true) + overlap(suffix, after, false)) / 2;
      if (!best || score > best.score) best = { key: entry.key, score };
    }
  }
  if (best && best.score >= THRESHOLD) {
    return { anchor: { ...anchor, blockKey: best.key }, state: "updated" };
  }
  return { anchor, state: "orphaned" };
}

/**
 * A native object's content-only anchor hash (14, "Object comments"): kind, label, style and kind fields,
 * without pose, parent, order or attribution, so moving, grouping or reordering keeps a pin `ok`.
 */
export function objectContentHash(object: BoardObject): string {
  const { pose: _p, parent: _parent, order: _o, attribution: _a, id: _id, ...content } = object;
  return createHash("sha256").update(canonicalJSON(content)).digest("hex").slice(0, 16);
}
const objectHashes = (snapshot: BoardSnapshot | null | undefined): Keyed =>
  new Map((snapshot?.objects ?? []).map((object) => [object.id, objectContentHash(object)]));

/** 05, "Re-anchoring". Runs inside the commit, and again when a version is restored or removed. */
export async function reanchorThreads(
  tx: Tx,
  artifactId: string,
  pageRows: { key: string }[],
  frameRows: { pageKey: string; frameKey: string; contentHash: string }[],
  blockRows: { pageKey: string; blockKey: string; contentHash: string; text: string }[],
  onlyCreatedOn?: number,
  /** The new version's native boards, when the caller has them before their `board_versions` rows. */
  boards?: { pageKey: string; snapshot: BoardSnapshot }[],
) {
  const open = await tx
    .select()
    .from(threads)
    .where(and(eq(threads.artifactId, artifactId), ne(threads.status, "resolved")))
    .orderBy(threads.n);
  const pageKeys = new Set(pageRows.map((page) => page.key));
  // An edited page's first checkpoint renumbers its blocks: the legacy keys map to lasting ids (13).
  const aliases = new Map(
    (
      await tx
        .select({ legacyKey: blockAliases.legacyKey, blockId: blockAliases.blockId })
        .from(blockAliases)
        .where(eq(blockAliases.artifactId, artifactId))
        .limit(20_000)
    ).map((row) => [row.legacyKey, row.blockId]),
  );
  const threadsOnChanged: number[] = [];
  const orphaned: number[] = [];
  const cache = new Map<number, VersionHashes>();
  // Native boards, loaded only when a thread pins an object: then by its checkpoint, now as given or latest.
  const thenBoards = new Map<string, Keyed>();
  const nowBoards = new Map<string, Keyed>(
    (boards ?? []).map((board) => [board.pageKey, objectHashes(board.snapshot)]),
  );
  const boardAt = async (pageKey: string, n: number | null) => {
    const [row] = await tx
      .select({ snapshot: boardVersions.snapshot })
      .from(boardVersions)
      .innerJoin(versions, eq(versions.id, boardVersions.versionId))
      .where(
        and(
          eq(versions.artifactId, artifactId),
          eq(boardVersions.pageKey, pageKey),
          n === null ? undefined : eq(versions.n, n),
        ),
      )
      .orderBy(desc(versions.n))
      .limit(1);
    return objectHashes(row?.snapshot);
  };

  for (const thread of open) {
    if (!thread.anchor || !pageKeys.has(thread.pageKey)) continue;
    if (onlyCreatedOn !== undefined && thread.createdVersion !== onlyCreatedOn) continue;
    let then = cache.get(thread.createdVersion);
    if (!then) {
      const [version] = await tx
        .select({ id: versions.id })
        .from(versions)
        .where(and(eq(versions.artifactId, artifactId), eq(versions.n, thread.createdVersion)))
        .limit(1);
      then = version ? await hashesOf(tx, version.id) : NOTHING;
      cache.set(thread.createdVersion, then);
    }
    const prefix = `${thread.pageKey}/`;
    const unprefix = (map: Map<string, string>) =>
      new Map(
        [...map]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, hash]) => [key.slice(prefix.length), hash]),
      );
    const thenBlocks = unprefix(then.blocks);
    let anchor = thread.anchor;
    let objects: { made: Keyed; now: Keyed } | undefined;
    if (anchor.type === "object") {
      const thenKey = `${thread.pageKey}\u0000${anchor.checkpoint}`;
      if (!thenBoards.has(thenKey)) thenBoards.set(thenKey, await boardAt(thread.pageKey, anchor.checkpoint));
      if (!nowBoards.has(thread.pageKey)) nowBoards.set(thread.pageKey, await boardAt(thread.pageKey, null));
      objects = { made: thenBoards.get(thenKey) as Keyed, now: nowBoards.get(thread.pageKey) as Keyed };
    }
    const alias =
      anchor.type === "text" || anchor.type === "block" ? aliases.get(anchor.blockKey) : undefined;
    if ((anchor.type === "text" || anchor.type === "block") && alias) {
      // Compared by the hash the legacy block had, so the renumbering alone never orphans it.
      const hash = thenBlocks.get(anchor.blockKey);
      if (hash !== undefined) thenBlocks.set(alias, hash);
      anchor = { ...anchor, blockKey: alias };
    }
    const result = reanchor(
      anchor,
      { frames: unprefix(then.frames), blocks: thenBlocks, objects: objects?.made },
      {
        objects: objects?.now,
        frames: new Map(
          frameRows.filter((f) => f.pageKey === thread.pageKey).map((f) => [f.frameKey, f.contentHash]),
        ),
        blocks: blockRows
          .filter((b) => b.pageKey === thread.pageKey)
          .map((b) => ({ key: b.blockKey, hash: b.contentHash, text: b.text })),
      },
    );
    await tx
      .update(threads)
      .set({ anchor: result.anchor, anchorState: result.state })
      .where(eq(threads.id, thread.id));
    if (result.state === "orphaned") orphaned.push(thread.n);
    if (result.state === "updated" && thread.status === "open") threadsOnChanged.push(thread.n);
  }
  return { threadsOnChanged, orphaned };
}
