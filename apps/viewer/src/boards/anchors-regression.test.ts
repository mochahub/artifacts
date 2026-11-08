import { expect, test } from "bun:test";
import type { Thread } from "@artifacts/schema";
import type { BoardObject } from "@artifacts/schema/boards";
import { commentAnchor, threadPoint } from "./anchors.ts";
import { sceneOf } from "./geometry.ts";

const rendered = (page: string, id: string) =>
  ({
    id,
    kind: "rendered_frame",
    pose: { x: 200, y: 300, w: 400, h: 200, angle: Math.PI / 2 },
    parent: null,
    order: id,
    data: { source: { page, board: "mocks", frame: "checkout" } },
  }) as BoardObject;

test("legacy frame pins use the source page and frame identity and current rotated pose", () => {
  const object = rendered("board", "~0000000001");
  const scene = sceneOf({ objects: [rendered("other", "~0000000000"), object] });
  const thread = {
    pageKey: "board",
    anchor: { type: "frame", frameKey: "checkout", x: 1, y: 0.5 },
    anchorState: "anchored",
  } as unknown as Thread;
  const point = threadPoint(scene, thread);
  expect(point?.object.id).toBe(object.id);
  expect(point?.at.x).toBeCloseTo(400);
  expect(point?.at.y).toBeCloseTo(600);
  expect(threadPoint(scene, { ...thread, anchorState: "orphaned" })).toBeNull();
  expect(threadPoint(scene, { ...thread, pageKey: "missing" })).toBeNull();
});

test("comments on rendered mocks retain pixel-reanchor frame anchors; native comments retain checkpoints", () => {
  expect(commentAnchor(rendered("board", "~0000000001"), 0.3, 0.7, 4)).toEqual({
    type: "frame",
    frameKey: "checkout",
    x: 0.3,
    y: 0.7,
  });
  expect(commentAnchor({ id: "~0000000002", kind: "sticky" } as BoardObject, 0.3, 0.7, 4)).toEqual({
    type: "object",
    object: "~0000000002",
    u: 0.3,
    v: 0.7,
    checkpoint: 4,
  });
});
