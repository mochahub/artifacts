import { describe, expect, test } from "bun:test";
import type { Anchor } from "@artifacts/schema";
import { reanchor } from "./reanchor.ts";

const frame: Anchor = { type: "frame", frameKey: "live", x: 0.5, y: 0.5 };
const blockAnchor: Anchor = { type: "block", blockKey: "a/p1" };
const quote = (blockKey: string, exact: string, prefix = "", suffix = ""): Anchor => ({
  type: "text",
  blockKey,
  quote: { exact, prefix, suffix },
});
const then = { frames: new Map([["live", "h1"]]), blocks: new Map([["a/p1", "b1"]]) };
const blocks = (...list: [string, string, string][]) =>
  list.map(([key, hash, text]) => ({ key, hash, text }));
const frames = (entries: [string, string][]) => ({ frames: new Map(entries), blocks: [] });

describe("frames", () => {
  test("same pixels stay ok", () => {
    expect(reanchor(frame, then, frames([["live", "h1"]])).state).toBe("ok");
  });
  test("different pixels are updated", () => {
    expect(reanchor(frame, then, frames([["live", "h2"]])).state).toBe("updated");
  });
  test("a missing frame is orphaned", () => {
    expect(reanchor(frame, then, frames([])).state).toBe("orphaned");
  });
});

describe("blocks", () => {
  const now = (hash: string) => ({ frames: new Map(), blocks: blocks(["a/p1", hash, "text"]) });
  test("unchanged, changed and gone", () => {
    expect(reanchor(blockAnchor, then, now("b1")).state).toBe("ok");
    expect(reanchor(blockAnchor, then, now("b2")).state).toBe("updated");
    expect(reanchor(blockAnchor, then, { frames: new Map(), blocks: [] }).state).toBe("orphaned");
  });
});

describe("quotes", () => {
  const anchor = quote("a/p1", "brown fox", "the quick ", " jumps");
  const at = (...list: [string, string, string][]) => ({ frames: new Map(), blocks: blocks(...list) });

  test("still there once in an unchanged block: ok", () => {
    expect(reanchor(anchor, then, at(["a/p1", "b1", "the quick brown fox jumps"])).state).toBe("ok");
  });
  test("still there in an edited block: updated, same place", () => {
    const result = reanchor(anchor, then, at(["a/p1", "b2", "now the quick brown fox jumps high"]));
    expect(result).toMatchObject({ state: "updated", anchor: { blockKey: "a/p1" } });
  });
  test("moved to another block: follows it", () => {
    const result = reanchor(
      anchor,
      then,
      at(["a/p1", "b2", "gone"], ["c/p4", "b3", "the quick brown fox jumps"]),
    );
    expect(result).toMatchObject({ state: "updated", anchor: { blockKey: "c/p4" } });
  });
  test("twice in its block: the surrounding text picks the right one", () => {
    const result = reanchor(
      anchor,
      then,
      at(["a/p1", "b2", "a brown fox sat"], ["z/p1", "b3", "the quick brown fox jumps"]),
    );
    expect(result.anchor).toMatchObject({ blockKey: "a/p1" });
    const twice = reanchor(
      anchor,
      then,
      at(["a/p1", "b2", "a brown fox sat, a brown fox stood"], ["z/p1", "b3", "the quick brown fox jumps"]),
    );
    expect(twice.anchor).toMatchObject({ blockKey: "z/p1" });
  });
  test("found only with different surroundings: under the threshold, orphaned", () => {
    const result = reanchor(anchor, then, at(["z/p1", "b3", "my slow brown fox sleeps"]));
    expect(result.state).toBe("orphaned");
  });
  test("gone: orphaned", () => {
    expect(reanchor(anchor, then, at(["a/p1", "b2", "nothing like it"])).state).toBe("orphaned");
  });
  test("a quote with no context moves on the exact text alone", () => {
    const bare = quote("a/p1", "needle");
    expect(reanchor(bare, then, at(["z/p1", "b3", "a needle here"]))).toMatchObject({
      state: "updated",
      anchor: { blockKey: "z/p1" },
    });
  });
});
