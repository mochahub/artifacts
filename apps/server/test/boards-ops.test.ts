import { describe, expect, test } from "bun:test";
import { boardToY, yToBoard } from "@artifacts/doc/board";
import { keyBetween } from "@artifacts/doc/board-order";
import { BOARD_PLACEMENT_TRIES } from "@artifacts/schema";
import { BoardEditRequest, type BoardObject, BoardSnapshot } from "@artifacts/schema/boards";
import * as Y from "yjs";
import {
  type BatchPlan,
  objectBase,
  type PlanContext,
  placeBeside,
  planBoardBatch,
  poseBox,
  textDiff,
  writePlan,
} from "../src/boards/ops.ts";

/** Agents' board operations as a pure plan (14, "Agent operations and placement"), and its Y writing. */

const T0 = "2026-11-07T10:00:00.000Z";
const T1 = "2026-11-07T11:00:00.000Z";
const style = {
  fill: "transparent" as const,
  stroke: "#242424",
  strokeWidth: 2,
  opacity: 1,
  fontSize: 20,
  align: "left" as const,
};
const stamp = { a: "a1", t: T0 };
const fields = { pose: stamp, parent: stamp, order: stamp, style: stamp, label: stamp, data: stamp };
let n = 0;
const id = () => `~${(n++).toString(36).padStart(10, "0")}`;
const pose = (x: number, y: number, w = 100, h = 100, angle = 0) => ({ x, y, w, h, angle });

function sticky(at: { x: number; y: number }, text = "hello", parent: string | null = null, order = "a0") {
  return {
    id: id(),
    kind: "sticky",
    pose: pose(at.x, at.y),
    parent,
    order,
    label: "",
    style: { ...style, fill: "#fff2a8" },
    text,
    attribution: { created: stamp, fields, text: text ? [{ s: 0, e: text.length, a: "a1", t: T0 }] : [] },
  } as BoardObject;
}
function frame(
  at: { x: number; y: number; w: number; h: number },
  parent: string | null = null,
  order = "a0",
) {
  return {
    id: id(),
    kind: "frame",
    pose: pose(at.x, at.y, at.w, at.h),
    parent,
    order,
    label: "Group",
    style,
    attribution: { created: stamp, fields, text: [] },
  } as BoardObject;
}
const HASH = "a".repeat(64);
const rendered = { page: "board", board: "mocks", frame: "login" };
const renderedData = (board = "mocks") => ({
  source: { ...rendered, board },
  version: 2,
  contentHash: HASH,
  renders: { "1x": HASH, "2x": HASH, "3x": HASH, thumb: HASH },
  intrinsic: { w: 390, h: 844 },
  livePath: null,
  missing: false,
});
const board = (objects: BoardObject[], deleted: BoardSnapshot["deleted"] = []) =>
  BoardSnapshot.parse({ schema: 1, page: "board", objects, deleted, assets: [] });
const baseOf = (snapshot: BoardSnapshot, ...ids: string[]) =>
  Object.fromEntries(
    ids.map((i) => [i, objectBase(snapshot.objects.find((o) => o.id === i) as BoardObject)]),
  );
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  author: "a2",
  time: T1,
  mint: id,
  held: () => false,
  asset: () => null,
  source: () => null,
  ...over,
});
const plan = (
  snapshot: BoardSnapshot,
  ops: unknown[],
  bases: Record<string, string> = {},
  over?: Partial<PlanContext>,
) => {
  const request = BoardEditRequest.parse({ epoch: 1, requestId: crypto.randomUUID(), bases, ops });
  return planBoardBatch(snapshot, request, ctx(over));
};
const ok = (result: BatchPlan) => {
  if (result.outcome !== "ok") throw new Error(`refused ${result.reason}: ${result.message}`);
  return result;
};
const find = (snapshot: BoardSnapshot, objectId: string) => snapshot.objects.find((o) => o.id === objectId);
const newSticky = (x: number, y: number, text = "new", parent: string | null = null) => ({
  kind: "sticky",
  pose: pose(x, y),
  parent,
  label: "",
  style: { ...style, fill: "#fff2a8" },
  text,
});

describe("order keys", () => {
  test("keys sort between their neighbours, in code-point order", () => {
    expect(keyBetween(null, null)).toBe("a0");
    expect(keyBetween("a0", null)).toBe("a1");
    expect(keyBetween(null, "a0")).toBe("Zz");
    const mid = keyBetween("a0", "a1");
    expect(mid > "a0" && mid < "a1").toBe(true);
    let key = "a0";
    for (let i = 0; i < 200; i++) {
      const next = keyBetween(key, null);
      expect(next > key).toBe(true);
      key = next;
    }
  });
});

describe("planBoardBatch", () => {
  test("add mints an id, stamps every field and goes last among siblings", () => {
    const a = sticky({ x: 0, y: 0 });
    const snapshot = board([a]);
    const result = ok(plan(snapshot, [{ op: "add", ref: "$note", object: newSticky(200, 0, "hi") }]));
    const made = find(result.after, result.ids.$note as string) as BoardObject;
    expect(made.kind).toBe("sticky");
    expect(made.order > a.order).toBe(true);
    expect(made.attribution.created).toEqual({ a: "a2", t: T1 });
    expect(made.attribution.fields.pose).toEqual({ a: "a2", t: T1 });
    expect(made.attribution.text).toEqual([{ s: 0, e: 2, a: "a2", t: T1 }]);
    expect(result.results).toEqual([{ index: 0, objects: [made.id] }]);
    expect(result.touched).toEqual([]);
  });

  test("add into a frame needs the frame's base and touches it", () => {
    const f = frame({ x: 0, y: 0, w: 500, h: 500 });
    const snapshot = board([f]);
    const without = plan(snapshot, [{ op: "add", ref: "$n", object: newSticky(10, 10, "x", f.id) }]);
    expect(without).toMatchObject({ outcome: "refused", reason: "invalid" });
    const result = ok(
      plan(
        snapshot,
        [{ op: "add", ref: "$n", object: newSticky(10, 10, "x", f.id) }],
        baseOf(snapshot, f.id),
      ),
    );
    expect(result.touched).toEqual([f.id]);
    expect(find(result.after, result.ids.$n as string)?.parent).toBe(f.id);
  });

  test("move, update and reorder change only what they say, keeping other stamps", () => {
    const a = sticky({ x: 0, y: 0 }, "hello", null, "a0");
    const b = sticky({ x: 200, y: 0 }, "there", null, "a1");
    const snapshot = board([a, b]);
    const result = ok(
      plan(
        snapshot,
        [
          { op: "move", object: a.id, pose: pose(50, 60) },
          { op: "update", object: a.id, patch: { text: "hello world", style: { fill: "#ffffff" } } },
          { op: "reorder", object: a.id, before: null },
        ],
        baseOf(snapshot, a.id),
      ),
    );
    const moved = find(result.after, a.id) as Extract<BoardObject, { kind: "sticky" }>;
    expect(moved.pose).toEqual(pose(50, 60));
    expect(moved.text).toBe("hello world");
    expect(moved.style.fill).toBe("#ffffff");
    expect(moved.order > b.order).toBe(true);
    expect(moved.attribution.fields.label).toEqual(stamp);
    expect(moved.attribution.fields.pose).toEqual({ a: "a2", t: T1 });
    expect(moved.attribution.text).toEqual([
      { s: 0, e: 5, a: "a1", t: T0 },
      { s: 5, e: 11, a: "a2", t: T1 },
    ]);
    expect(find(result.after, b.id)).toEqual(b);
  });

  test("wrong-kind patches, connector moves and rotated frames are invalid", () => {
    const a = sticky({ x: 0, y: 0 });
    const f = frame({ x: 300, y: 0, w: 100, h: 100 });
    const snapshot = board([a, f]);
    const bases = baseOf(snapshot, a.id, f.id);
    expect(
      plan(snapshot, [{ op: "update", object: a.id, patch: { shape: "rect" } }], baseOf(snapshot, a.id)),
    ).toMatchObject({
      reason: "invalid",
    });
    expect(
      plan(snapshot, [{ op: "move", object: f.id, pose: pose(0, 0, 100, 100, 0.5) }], baseOf(snapshot, f.id)),
    ).toMatchObject({
      reason: "invalid",
    });
    expect(plan(snapshot, [{ op: "ungroup", object: a.id }], baseOf(snapshot, a.id))).toMatchObject({
      reason: "invalid",
    });
    expect(Object.keys(bases)).toHaveLength(2);
  });

  test("connect binds ends to objects; deleting a target freezes the end where it was", () => {
    const a = sticky({ x: 0, y: 0 });
    const b = sticky({ x: 400, y: 0 });
    const snapshot = board([a, b]);
    const linked = ok(
      plan(
        snapshot,
        [
          {
            op: "connect",
            ref: "$arrow",
            label: "",
            style,
            start: { point: { x: 0, y: 0 }, binding: { object: a.id, u: 1, v: 0.5 } },
            end: { point: { x: 0, y: 0 }, binding: { object: b.id, u: 0, v: 0.5 } },
            route: "straight",
            startArrow: false,
            endArrow: true,
          },
        ],
        baseOf(snapshot, a.id, b.id),
      ),
    );
    const arrow = find(linked.after, linked.ids.$arrow as string) as Extract<
      BoardObject,
      { kind: "connector" }
    >;
    expect(arrow.parent).toBeNull();
    expect(arrow.pose).toMatchObject({ x: 100, y: 50, w: 300, h: 1 });
    expect(arrow.data.end.point).toEqual({ x: 400, y: 50 });
    // Connecting reads its targets but writes neither.
    expect(linked.touched).toEqual([]);

    const after = linked.after;
    const gone = ok(plan(after, [{ op: "delete", object: b.id }], baseOf(after, b.id)));
    const frozen = find(gone.after, arrow.id) as typeof arrow;
    expect(frozen.data.end).toEqual({ point: { x: 400, y: 50 }, binding: null });
    expect(frozen.data.start.binding?.object).toBe(a.id);
    expect(gone.after.deleted.map((d) => d.id)).toEqual([b.id]);
    // The detached connector is held-checked without a base of its own.
    expect(gone.touched.sort()).toEqual([arrow.id, b.id].sort());
    expect(
      ok(plan(after, [{ op: "delete", object: b.id }], baseOf(after, b.id), { held: (x) => x === arrow.id }))
        .held,
    ).toEqual([arrow.id]);
  });

  test("connectors can't bind to connectors, and move on one is refused", () => {
    const a = sticky({ x: 0, y: 0 });
    const snapshot = board([a]);
    const linked = plan(snapshot, [
      {
        op: "connect",
        ref: "$c",
        label: "",
        style,
        start: { point: { x: 0, y: 0 }, binding: null },
        end: { point: { x: 10, y: 10 }, binding: null },
        route: "elbow",
        startArrow: false,
        endArrow: false,
      },
      {
        op: "connect",
        ref: "$d",
        label: "",
        style,
        start: { point: { x: 0, y: 0 }, binding: { object: "$c", u: 0, v: 0 } },
        end: { point: { x: 10, y: 10 }, binding: null },
        route: "straight",
        startArrow: false,
        endArrow: false,
      },
    ]);
    expect(linked).toMatchObject({ outcome: "refused", reason: "invalid" });
  });

  test("group wraps siblings with 24px padding, keeping board geometry; ungroup undoes it", () => {
    const a = sticky({ x: 100, y: 100 });
    const b = sticky({ x: 300, y: 200 });
    const snapshot = board([a, b]);
    const grouped = ok(
      plan(
        snapshot,
        [{ op: "group", ref: "$g", objects: [a.id, b.id], label: "Ideas" }],
        baseOf(snapshot, a.id, b.id),
      ),
    );
    const g = find(grouped.after, grouped.ids.$g as string) as BoardObject;
    expect(g.pose).toEqual({ x: 76, y: 76, w: 348, h: 248, angle: 0 });
    expect(find(grouped.after, a.id)).toMatchObject({ parent: g.id, pose: { x: 24, y: 24 } });
    const after = grouped.after;
    const undone = ok(plan(after, [{ op: "ungroup", object: g.id }], baseOf(after, g.id, a.id, b.id)));
    expect(find(undone.after, a.id)).toMatchObject({ parent: null, pose: { x: 100, y: 100 } });
    expect(find(undone.after, g.id)).toBeUndefined();
    // Ungrouping writes the children: without their bases it's invalid.
    expect(plan(after, [{ op: "ungroup", object: g.id }], baseOf(after, g.id))).toMatchObject({
      reason: "invalid",
    });
  });

  test("deleting a frame never deletes a person's children", () => {
    const f = frame({ x: 100, y: 100, w: 400, h: 400 });
    const child = sticky({ x: 10, y: 20 }, "keep me", f.id);
    const snapshot = board([f, child]);
    const result = ok(plan(snapshot, [{ op: "delete", object: f.id }], baseOf(snapshot, f.id, child.id)));
    expect(find(result.after, child.id)).toMatchObject({ parent: null, pose: { x: 110, y: 120 } });
  });

  test("moving a group needs and touches every descendant", () => {
    const f = frame({ x: 0, y: 0, w: 400, h: 400 });
    const inner = frame({ x: 10, y: 10, w: 200, h: 200 }, f.id);
    const leaf = sticky({ x: 5, y: 5 }, "deep", inner.id);
    const snapshot = board([f, inner, leaf]);
    expect(
      plan(snapshot, [{ op: "move", object: f.id, pose: pose(50, 0, 400, 400) }], baseOf(snapshot, f.id)),
    ).toMatchObject({
      reason: "invalid",
    });
    const result = plan(
      snapshot,
      [{ op: "move", object: f.id, pose: pose(50, 0, 400, 400) }],
      baseOf(snapshot, f.id, inner.id, leaf.id),
      { held: (x) => x === leaf.id },
    );
    expect(ok(result).held).toEqual([leaf.id]);
    // A child is translated with its group, not written: only the group's pose changes.
    expect(find(ok(result).after, leaf.id)).toEqual(leaf);
  });

  test("a stale base refuses the whole batch, before any hold or later failure", () => {
    const a = sticky({ x: 0, y: 0 });
    const snapshot = board([a]);
    const result = plan(
      snapshot,
      [
        { op: "add", ref: "$x", object: newSticky(500, 0) },
        { op: "update", object: a.id, patch: { text: "changed" } },
        { op: "update", object: a.id, patch: { shape: "rect" } },
      ],
      { [a.id]: "000000000000" },
      { held: () => true },
    );
    expect(result).toMatchObject({ outcome: "refused", reason: "stale" });
    expect((result as { message: string }).message).toContain(objectBase(a));
    // force bypasses the stale base, nothing else.
    expect(
      plan(
        snapshot,
        [{ op: "update", object: a.id, patch: { text: "x" } }],
        { [a.id]: "000000000000" },
        { force: true },
      ).outcome,
    ).toBe("ok");
  });

  test("missing ids, deleted ids, forward and duplicate refs, and surplus bases are refused", () => {
    const a = sticky({ x: 0, y: 0 });
    const tomb = {
      id: id(),
      a: "a1",
      t: T0,
      pose: pose(0, 0),
      parent: null,
      worldPose: pose(0, 0),
    };
    const snapshot = board([a], [tomb]);
    expect(plan(snapshot, [{ op: "delete", object: "~zzzzzzzzzz" }])).toMatchObject({ reason: "missing" });
    expect(plan(snapshot, [{ op: "move", object: tomb.id, pose: pose(1, 1) }])).toMatchObject({
      reason: "missing",
    });
    expect(
      plan(snapshot, [
        { op: "delete", object: "$later" },
        { op: "add", ref: "$later", object: newSticky(0, 0) },
      ]),
    ).toMatchObject({
      reason: "invalid",
    });
    expect(
      plan(snapshot, [
        { op: "add", ref: "$a", object: newSticky(0, 0) },
        { op: "add", ref: "$a", object: newSticky(0, 0) },
      ]),
    ).toMatchObject({ reason: "invalid" });
    expect(
      plan(snapshot, [{ op: "add", ref: "$a", object: newSticky(0, 0) }], baseOf(snapshot, a.id)),
    ).toMatchObject({
      reason: "invalid",
    });
  });

  test("ids never collide with active, deleted or reserved ones", () => {
    const a = sticky({ x: 0, y: 0 });
    const reserved = "~reserved00";
    const mints = [a.id, reserved, "~freshid000"];
    const result = ok(
      plan(
        board([a]),
        [{ op: "add", ref: "$n", object: newSticky(300, 0) }],
        {},
        {
          mint: () => mints.shift() as string,
          reserved: new Set([reserved]),
        },
      ),
    );
    expect(result.ids.$n).toBe("~freshid000");
  });

  test("an accepted suggestion keeps the ids it promised", () => {
    const result = ok(
      plan(
        board([]),
        [{ op: "add", ref: "$n", object: newSticky(0, 0) }],
        {},
        { ids: { $n: "~promised00" } },
      ),
    );
    expect(result.ids).toEqual({ $n: "~promised00" });
  });

  test("bounds and depth are checked on the final state", () => {
    const a = sticky({ x: 0, y: 0 });
    const snapshot = board([a]);
    expect(
      plan(snapshot, [{ op: "move", object: a.id, pose: pose(999_950, 0) }], baseOf(snapshot, a.id)),
    ).toMatchObject({
      reason: "limit",
    });
    const nest: BoardObject[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 8; i++) {
      const f = frame({ x: 0, y: 0, w: 100, h: 100 }, parent);
      nest.push(f);
      parent = f.id;
    }
    const deep = board(nest);
    expect(
      plan(
        deep,
        [{ op: "add", ref: "$f", object: { kind: "frame", pose: pose(0, 0), parent, label: "", style } }],
        {
          [parent as string]: objectBase(nest.at(-1) as BoardObject),
        },
      ),
    ).toMatchObject({ reason: "limit" });
  });

  test("images need a validated asset on this artifact", () => {
    const image = {
      kind: "image",
      pose: pose(0, 0),
      parent: null,
      label: "",
      style,
      asset: HASH,
      alt: "A sketch",
    };
    expect(plan(board([]), [{ op: "add", ref: "$i", object: image }])).toMatchObject({ reason: "missing" });
    const asset = { hash: HASH, type: "image/png" as const, bytes: 10, width: 10, height: 10 };
    const result = ok(plan(board([]), [{ op: "add", ref: "$i", object: image }], {}, { asset: () => asset }));
    expect(result.after.assets).toEqual([asset]);
  });
});

describe("place_frame", () => {
  const near = (
    snapshot: BoardSnapshot,
    objectId: string,
    side: string,
    over?: Partial<PlanContext>,
    extra = {},
  ) =>
    plan(
      snapshot,
      [
        {
          op: "place_frame",
          ref: "$mock",
          source: rendered,
          near: { object: objectId },
          side,
          gap: 80,
          ...extra,
        },
      ],
      baseOf(snapshot, objectId),
      { source: () => renderedData(), ...over },
    );

  test("an unplaced source lands beside the sketch at its intrinsic size, on every side", () => {
    const sketch = sticky({ x: 1000, y: 1000 });
    const snapshot = board([sketch]);
    const at = (side: string) => {
      const result = ok(near(snapshot, sketch.id, side));
      return find(result.after, result.ids.$mock as string) as BoardObject;
    };
    expect(at("right").pose).toMatchObject({ x: 1180, y: 1000, w: 390, h: 844 });
    expect(at("left").pose).toMatchObject({ x: 1000 - 80 - 390, y: 1000 });
    expect(at("below").pose).toMatchObject({ x: 1000, y: 1180 });
    expect(at("above").pose).toMatchObject({ x: 1000, y: 1000 - 80 - 844 });
    expect(at("right")).toMatchObject({ kind: "rendered_frame", parent: null });
  });

  test("it steps past obstacles along the perpendicular axis, never overlapping", () => {
    const sketch = sticky({ x: 0, y: 0 });
    const blocker = sticky({ x: 200, y: 0 });
    blocker.pose = pose(200, 0, 500, 500);
    const snapshot = board([sketch, blocker]);
    const result = ok(near(snapshot, sketch.id, "right"));
    const placed = find(result.after, result.ids.$mock as string) as BoardObject;
    expect(placed.pose.x).toBe(180);
    expect(placed.pose.y).toBe(844 + 80);
    const a = poseBox(placed.pose);
    for (const other of [sketch, blocker]) {
      const b = poseBox(other.pose);
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart).toBe(true);
    }
  });

  test("placeBeside gives up after the try limit rather than overlap", () => {
    const wall = { x: 100, y: -1_000_000, w: 10, h: 2_000_000 };
    expect(
      placeBeside({
        near: { x: 0, y: 0, w: 10, h: 10 },
        size: { w: 50, h: 50 },
        side: "right",
        gap: 80,
        obstacles: [wall],
      }),
    ).toBeNull();
    const many = Array.from({ length: BOARD_PLACEMENT_TRIES + 5 }, (_, i) => ({
      x: 100,
      y: i * 130,
      w: 10,
      h: 50,
    }));
    expect(
      placeBeside({
        near: { x: 0, y: 0, w: 10, h: 10 },
        size: { w: 50, h: 50 },
        side: "right",
        gap: 80,
        obstacles: many,
      }),
    ).toBeNull();
    const edge = sticky({ x: 999_500, y: 0 });
    expect(near(board([edge]), edge.id, "right")).toMatchObject({
      outcome: "refused",
      reason: "placement_full",
    });
  });

  test("random scenes: a placement never overlaps any obstacle grown by half the gap", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let round = 0; round < 200; round++) {
      const obstacles = Array.from({ length: 12 }, () => ({
        x: random() * 3000,
        y: random() * 3000,
        w: 20 + random() * 400,
        h: 20 + random() * 400,
      }));
      const gap = 16 + random() * 200;
      const size = { w: 50 + random() * 400, h: 50 + random() * 400 };
      for (const side of ["right", "left", "below", "above"] as const) {
        const spot = placeBeside({ near: obstacles[0] as (typeof obstacles)[0], size, side, gap, obstacles });
        if (!spot) continue;
        for (const b of obstacles) {
          const apart =
            spot.x + size.w <= b.x - gap / 2 ||
            b.x + b.w + gap / 2 <= spot.x ||
            spot.y + size.h <= b.y - gap / 2 ||
            b.y + b.h + gap / 2 <= spot.y;
          expect(apart).toBe(true);
        }
      }
    }
  });

  test("a placed source moves, keeping its size; a deleted one is refused missing; a stale board hint is stale", () => {
    const sketch = sticky({ x: 0, y: 0 });
    const mock = {
      id: id(),
      kind: "rendered_frame",
      pose: pose(5000, 5000, 200, 400),
      parent: null,
      order: "a1",
      label: "login",
      style,
      data: renderedData(),
      attribution: { created: stamp, fields, text: [] },
    } as BoardObject;
    const snapshot = board([sketch, mock]);
    const moved = ok(
      plan(
        snapshot,
        [{ op: "place_frame", source: rendered, near: { object: sketch.id }, side: "right", gap: 80 }],
        baseOf(snapshot, sketch.id, mock.id),
        { source: () => renderedData() },
      ),
    );
    expect(find(moved.after, mock.id)?.pose).toEqual(pose(180, 0, 200, 400));
    expect(moved.ids).toEqual({});

    const tomb = {
      id: mock.id,
      a: "a1",
      t: T0,
      pose: mock.pose,
      parent: null,
      worldPose: mock.pose,
      source: rendered,
    };
    const deleted = board([sketch], [tomb]);
    expect(near(deleted, sketch.id, "right")).toMatchObject({ outcome: "refused", reason: "missing" });
    expect(near(board([sketch]), sketch.id, "right", { source: () => renderedData("other") })).toMatchObject({
      reason: "stale",
    });
    expect(
      near(board([sketch]), sketch.id, "right", { reservedSources: new Set([`board\u0000login`]) }),
    ).toMatchObject({
      reason: "invalid",
    });
  });
});

describe("writing a plan into Yjs", () => {
  test("the board reader sees exactly the planned snapshot, with text as a diff", () => {
    const a = sticky({ x: 0, y: 0 }, "hello");
    const b = sticky({ x: 400, y: 0 }, "bye");
    const start = board([a, b]);
    // Seed through the writer itself: an empty board, then two adds.
    const ydoc = boardToY(board([]));
    const seed = { outcome: "ok" as const, touched: [], held: [], ids: {}, results: [], meta: null };
    writePlan(ydoc, { ...seed, before: board([]), after: start }, { a: "a1", t: T0 });
    expect(yToBoard(ydoc).objects).toEqual(start.objects);

    const result = ok(
      plan(
        start,
        [
          { op: "update", object: a.id, patch: { text: "hello, world" } },
          { op: "move", object: a.id, pose: pose(10, 20) },
          { op: "delete", object: b.id },
          { op: "add", ref: "$n", object: newSticky(0, 300, "fresh") },
        ],
        baseOf(start, a.id, b.id),
      ),
    );
    // Someone else types at the end of a's text concurrently; their characters survive the diff.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc));
    ((other.getMap("objects").get(a.id) as Y.Map<unknown>).get("text") as Y.Text).insert(5, "!", {
      author: { a: "a9", t: T1 },
    });
    writePlan(ydoc, result, { a: "a2", t: T1 });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(other));
    const read = yToBoard(ydoc);
    expect(read.objects.map((o) => o.id).sort()).toEqual([a.id, result.ids.$n as string].sort());
    expect(read.deleted.map((d) => d.id)).toEqual([b.id]);
    const text = (read.objects.find((o) => o.id === a.id) as { text: string }).text;
    expect(text).toContain("!");
    expect(text.replace("!", "")).toBe("hello, world");
    const fresh = result.after.objects.find((o) => o.id === result.ids.$n);
    expect(read.objects.find((o) => o.id === result.ids.$n)).toEqual(fresh as BoardObject);
  });

  test("textDiff never splits a surrogate pair", () => {
    expect(textDiff("a😀b", "a😃b")).toEqual({ from: 1, removed: 2, inserted: "😃" });
  });
});
