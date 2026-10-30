import type { Anchor } from "@artifacts/schema";

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
  then: { frames: Keyed; blocks: Keyed },
  now: { frames: Keyed; blocks: Block[] },
): AnchorResult {
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
