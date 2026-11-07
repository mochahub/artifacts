import { describe, expect, test } from "bun:test";
import { Anchor } from "@artifacts/schema";
import type { BoardObject } from "@artifacts/schema/boards";
import { hideObjectAnchors } from "../src/http/compat.ts";
import { objectContentHash, reanchor } from "../src/review/reanchor.ts";

/** 14, "Object comments": the shared union, content-only re-anchoring and the old-CLI fallback. */
const stamp = { a: "a1", t: "2026-11-07T10:00:00.000Z" };
const fields = { pose: stamp, parent: stamp, order: stamp, style: stamp, label: stamp, data: stamp };
const sticky = (text: string, x = 0): BoardObject =>
  ({
    id: "~stickyaaa1",
    kind: "sticky",
    pose: { x, y: 0, w: 200, h: 200, angle: 0 },
    parent: null,
    order: "a0",
    label: "",
    style: { fill: "#fff2a8", stroke: "#242424", strokeWidth: 2, opacity: 1, fontSize: 20, align: "left" },
    text,
    attribution: { created: stamp, fields, text: [] },
  }) as BoardObject;
const pin = { type: "object" as const, object: "~stickyaaa1", u: 0.5, v: 0.5, checkpoint: 2 };
const keyed = (object: BoardObject | null) => new Map(object ? [[object.id, objectContentHash(object)]] : []);
const none = { frames: new Map(), blocks: new Map() };

describe("object anchors", () => {
  test("are part of the shared Anchor union, strictly", () => {
    expect(Anchor.parse(pin)).toEqual(pin);
    expect(Anchor.safeParse({ ...pin, object: "nope" }).success).toBe(false);
    expect(Anchor.safeParse({ ...pin, extra: 1 }).success).toBe(false);
  });

  test("moving keeps a pin ok, changed text updates it, deletion orphans it", () => {
    const made = sticky("Ship it");
    const at = (now: BoardObject | null) =>
      reanchor(pin, { ...none, objects: keyed(made) }, { frames: new Map(), blocks: [], objects: keyed(now) })
        .state;
    expect(at(sticky("Ship it", 400))).toBe("ok");
    expect(at(sticky("Ship it later"))).toBe("updated");
    expect(at(null)).toBe("orphaned");
  });

  test("a CLI without the boards feature sees an object-pinned thread with no anchor", () => {
    const threads = [
      { n: 1, anchor: pin, crop: "https://example.test/c", anchorState: "ok" },
      { n: 2, anchor: { type: "frame", frameKey: "a", x: 0.1, y: 0.2 } },
    ];
    expect(hideObjectAnchors({ threads })).toEqual({
      threads: [
        { n: 1, anchor: null, crop: "https://example.test/c", anchorState: "ok" },
        { n: 2, anchor: { type: "frame", frameKey: "a", x: 0.1, y: 0.2 } },
      ],
    });
  });
});
