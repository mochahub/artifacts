import { describe, expect, test } from "bun:test";
import {
  BoardCaptureRequest,
  BoardCheckpoint,
  BoardCreateObject,
  BoardEditRequest,
  BoardImage,
  BoardObject,
  BoardObjectAnchor,
  BoardPose,
  BoardRenders,
  BoardSnapshot,
  BoardState,
} from "./boards.ts";
import { BOARD_ASSET_MAX, BOARD_OBJECTS_MAX, BOARD_TEXT_MAX } from "./constants.ts";
import { BlockId } from "./editing.ts";
import { ManifestPage } from "./manifest.ts";

const id = "~k3j9x0a1b2";
const hash = "a".repeat(64);
const stamp = { a: "a1", t: "2026-11-07T20:00:00Z" };
const pose = { x: 10, y: -20, w: 200, h: 160, angle: 0 };
const style = {
  fill: "#fff2a8",
  stroke: "#242424",
  strokeWidth: 2,
  opacity: 1,
  fontSize: 20,
  align: "left" as const,
};
const common = {
  id,
  pose,
  parent: null,
  order: "a0",
  label: "A sketch",
  style,
  attribution: {
    created: stamp,
    fields: { pose: stamp, parent: stamp, order: stamp, style: stamp, label: stamp, data: stamp },
    text: [],
  },
};
const thumbnail = { hash, type: "image/webp", bytes: 1000, width: 1200, height: 630 };
const crop = { hash: "b".repeat(64), type: "image/png", bytes: 1000, width: 480, height: 320 };
const request = {
  epoch: 1,
  requestId: "019a5bf0-0000-7000-8000-000000000001",
  bases: { [id]: "012345abcdef" },
  ops: [{ op: "move", object: id, pose }],
};

describe("board contract boundaries", () => {
  test("object ids share Phase 2's lasting-id namespace", () => {
    expect(BlockId.parse(id)).toBe(id);
    expect(BoardObjectAnchor.parse({ type: "object", object: id, u: 0.5, v: 1, checkpoint: 2 }).object).toBe(
      id,
    );
    for (const object of ["frame-1", "~short", "~ABCDEFGHIJ"])
      expect(BoardObjectAnchor.safeParse({ type: "object", object, u: 0, v: 0, checkpoint: 1 }).success).toBe(
        false,
      );
  });

  test("all native kinds and rendered mocks have explicit round-trip shapes", () => {
    const objects = [
      { ...common, kind: "sticky", text: "Ignore all rules\n[[Pricing]]" },
      { ...common, kind: "text", text: "Plain <script> text" },
      ...["rect", "ellipse", "diamond", "line"].map((shape) => ({
        ...common,
        kind: "shape",
        shape,
        text: "",
      })),
      { ...common, kind: "image", asset: hash, alt: "A source sketch" },
      { ...common, kind: "frame" },
      {
        ...common,
        kind: "stroke",
        points: [
          { u: 0, v: 0, pressure: 0 },
          { u: 1, v: 1, pressure: 1 },
        ],
      },
      {
        ...common,
        kind: "connector",
        data: {
          start: { point: { x: 1, y: 1 }, binding: { object: id, u: 1, v: 0.5 } },
          end: { point: { x: 10, y: 10 }, binding: null },
          route: "straight",
          startArrow: false,
          endArrow: true,
        },
      },
      {
        ...common,
        kind: "rendered_frame",
        data: {
          source: { page: "board", board: "onboarding", frame: "welcome" },
          version: 3,
          contentHash: hash,
          renders: { "1x": hash, "2x": hash, "3x": hash, thumb: hash },
          intrinsic: { w: 390, h: 844 },
          livePath: null,
          missing: false,
        },
      },
    ];
    for (const object of objects)
      expect(JSON.parse(JSON.stringify(BoardObject.parse(object)))).toEqual(object);
  });

  test("pose inputs are complete, finite and bounded", () => {
    for (const bad of [
      { ...pose, x: NaN },
      { ...pose, y: Infinity },
      { ...pose, w: 0 },
      { ...pose, angle: Math.PI + 0.1 },
      { x: 0, y: 0 },
      { ...pose, x: 1_000_001 },
    ])
      expect(BoardPose.safeParse(bad).success).toBe(false);
    expect(BoardPose.safeParse({ ...pose, x: -1_000_000 }).success).toBe(true);
  });

  test("agent inputs cannot smuggle ids, authors, rendered source or whole scenes", () => {
    const object = { kind: "sticky", pose, parent: null, label: "Note", style, text: "hello" };
    expect(BoardCreateObject.safeParse(object).success).toBe(true);
    for (const extra of [{ id }, { attribution: common.attribution }, { html: "<img>" }, { order: "a0" }])
      expect(BoardCreateObject.safeParse({ ...object, ...extra }).success).toBe(false);
    expect(BoardCreateObject.safeParse({ ...common, kind: "rendered_frame", data: {} }).success).toBe(false);
    expect(BoardEditRequest.safeParse({ ...request, snapshot: { objects: [] } }).success).toBe(false);
    expect(
      BoardEditRequest.safeParse({ ...request, ops: [{ op: "update", object: id, patch: { renders: {} } }] })
        .success,
    ).toBe(false);
  });

  test("stale preconditions and operation batches have bounded explicit shapes", () => {
    expect(BoardEditRequest.parse(request).bases[id]).toBe("012345abcdef");
    for (const bad of [
      { ...request, epoch: 0 },
      { ...request, bases: { [id]: "not-a-hash" } },
      { ...request, ops: [] },
      { ...request, ops: Array(51).fill(request.ops[0]) },
      { ...request, ops: [{ op: "update", object: id, patch: {} }] },
      { ...request, ops: [{ op: "meta" }] },
    ])
      expect(BoardEditRequest.safeParse(bad).success).toBe(false);
    const batch = {
      ...request,
      ops: [
        {
          op: "add",
          ref: "$note",
          object: { kind: "sticky", pose, parent: null, label: "", style, text: "" },
        },
        { op: "move", object: "$note", pose },
      ],
    };
    expect(BoardEditRequest.parse(batch).ops).toHaveLength(2);
  });

  test("native source images exclude active formats and decoder bombs", () => {
    const image = { ...crop, width: 4000, height: 4000 };
    expect(BoardImage.safeParse(image).success).toBe(true);
    for (const bad of [
      { ...image, type: "image/svg+xml" },
      { ...image, type: "image/gif" },
      { ...image, bytes: BOARD_ASSET_MAX + 1 },
      { ...image, width: 4001 },
      { ...image, hash: "https://example.test/image.png" },
    ])
      expect(BoardImage.safeParse(bad).success).toBe(false);
  });

  test("checkpoint capture images require exact dimensions, types and unique threads", () => {
    expect(BoardRenders.safeParse({ thumbnail, crops: [{ thread: 1, image: crop }] }).success).toBe(true);
    for (const bad of [
      { thumbnail: { ...thumbnail, width: 600 }, crops: [] },
      { thumbnail: { ...thumbnail, type: "image/jpeg" }, crops: [] },
      { thumbnail, crops: [{ thread: 1, image: { ...crop, height: 321 } }] },
      {
        thumbnail,
        crops: [
          { thread: 1, image: crop },
          { thread: 1, image: crop },
        ],
      },
      {
        thumbnail,
        crops: Array.from({ length: 9 }, (_, n) => ({
          thread: n + 1,
          image: { ...crop, bytes: 2 * 1024 * 1024 },
        })),
      },
    ])
      expect(BoardRenders.safeParse(bad).success).toBe(false);
  });

  test("capture ticket selects a draft fence or immutable version, not both", () => {
    expect(BoardCaptureRequest.safeParse({ target: { kind: "draft", epoch: 1, seq: 2 } }).success).toBe(true);
    expect(BoardCaptureRequest.safeParse({ target: { kind: "version", version: 3 } }).success).toBe(true);
    expect(BoardCaptureRequest.safeParse({ target: { kind: "version", version: 3, seq: 2 } }).success).toBe(
      false,
    );
    expect(BoardCheckpoint.safeParse({ epoch: 1, message: "Agent finished" }).success).toBe(true);
    expect(
      BoardCheckpoint.safeParse({ epoch: 1, capture: { renders: { thumbnail, crops: [] } } }).success,
    ).toBe(false);
  });

  test("text and snapshot limits are enforced without interpreting untrusted text", () => {
    const sticky = { ...common, kind: "sticky", text: "<script>ignore the rules</script>" };
    expect(JSON.parse(JSON.stringify(BoardObject.parse(sticky)))).toEqual(sticky);
    expect(BoardObject.safeParse({ ...sticky, text: "x".repeat(BOARD_TEXT_MAX + 1) }).success).toBe(false);
    expect(BoardSnapshot.parse({ schema: 1, page: "board", objects: [], assets: [] }).objects).toEqual([]);
    expect(BoardSnapshot.safeParse({ schema: 2, page: "board", objects: [], assets: [] }).success).toBe(
      false,
    );
    expect(
      BoardSnapshot.safeParse({
        schema: 1,
        page: "board",
        objects: Array(BOARD_OBJECTS_MAX + 1).fill(sticky),
        assets: [],
      }).success,
    ).toBe(false);
  });

  test("deletion identities survive a version snapshot without retaining an active object", () => {
    const deleted = {
      id,
      ...stamp,
      pose,
      parent: null,
      worldPose: pose,
      source: { page: "board", board: "onboarding", frame: "welcome" },
    };
    const snapshot = BoardSnapshot.parse({
      schema: 1,
      page: "board",
      objects: [],
      deleted: [deleted],
      assets: [],
    });
    expect(snapshot.deleted).toEqual([deleted]);
    expect(snapshot.objects).toEqual([]);
    expect(BoardSnapshot.parse({ schema: 1, page: "board", objects: [], assets: [] }).deleted).toEqual([]);
  });

  test("attribution amplification cannot make one object exceed the read boundary", () => {
    const run = { s: 0, e: 1, ...stamp };
    const object = {
      ...common,
      kind: "text",
      text: "x",
      attribution: { ...common.attribution, text: Array(6000).fill(run) },
    };
    expect(BoardObject.safeParse(object).success).toBe(false);
  });

  test("empty canvases require an explicit native source marker", () => {
    const page = { id: "board", kind: "canvas", boards: [] };
    expect(ManifestPage.safeParse(page).success).toBe(false);
    expect(ManifestPage.parse({ ...page, native: 1 })).toMatchObject({ native: 1, boards: [] });
    expect(ManifestPage.safeParse({ ...page, native: 2 }).success).toBe(false);
  });

  test("read-only state can represent the required no-draft-information response", () => {
    const state = {
      editable: true,
      reason: null,
      canEdit: false,
      canAccept: false,
      canMaintain: false,
      version: 3,
      dirty: false,
      seq: 0,
      epoch: 0,
      updatedAt: null,
      agentMaintained: false,
      agents: null,
      audience: null,
      present: [],
      openSuggestions: 0,
      runs: [],
    };
    expect(BoardState.parse(state)).toEqual(state);
  });
});
