import { describe, expect, test } from "bun:test";
import type { BoardObject, BoardSnapshot } from "@artifacts/schema/boards";
import { BoardSnapshot as SnapshotSchema } from "@artifacts/schema/boards";
import * as Y from "yjs";
import {
  anchorPoint,
  endpoint,
  hitTest,
  localUV,
  posePoint,
  sceneBounds,
  sceneOf,
  snapDot,
  worldPose,
} from "./geometry.ts";
import { type Action, Arbiter, type Input, type Route } from "./gestures.ts";
import { BoardWriter, boardToY, mintBoardObjectId, yToBoard } from "./model.ts";

const T = "2026-11-07T10:00:00.000Z";
const stamp = { a: "a1", t: T };
const attribution = {
  created: stamp,
  fields: { pose: stamp, parent: stamp, order: stamp, style: stamp, label: stamp, data: stamp },
  text: [],
};
const style = {
  fill: "transparent",
  stroke: "#242424",
  strokeWidth: 2,
  opacity: 1,
  fontSize: 20,
  align: "left",
} as const;
const pose = (x: number, y: number, w = 100, h = 50, angle = 0) => ({ x, y, w, h, angle });
const sticky = (
  id: string,
  x: number,
  y: number,
  order = "a0",
  parent: string | null = null,
): BoardObject => ({
  id,
  kind: "sticky",
  pose: pose(x, y),
  parent,
  order,
  label: "",
  style: { ...style, fill: "#fff2a8" },
  attribution,
  text: "",
});
const snapshot = (objects: BoardObject[]): BoardSnapshot => ({
  schema: 1,
  page: "board",
  objects,
  deleted: [],
  assets: [],
});

describe("geometry", () => {
  const frame: BoardObject = {
    ...sticky("~frame00001", 1000, 500),
    kind: "frame",
    pose: pose(1000, 500, 400, 300),
  } as BoardObject;
  const child = sticky("~child00001", 20, 30, "a0", "~frame00001");
  const scene = sceneOf(snapshot([frame, child]));

  test("children translate by their container, never scale", () => {
    expect(worldPose(scene, "~child00001")).toEqual(pose(1020, 530));
  });
  test("draw order is parent tree then (order, id)", () => {
    const s = sceneOf(
      snapshot([
        sticky("~b000000000", 0, 0, "a1"),
        sticky("~a000000000", 0, 0, "a1"),
        sticky("~c000000000", 0, 0, "a0"),
      ]),
    );
    expect(s.order.map((o) => o.id)).toEqual(["~c000000000", "~a000000000", "~b000000000"]);
  });
  test("rotated anchors go through the centre", () => {
    const p = posePoint(pose(0, 0, 100, 100, Math.PI / 2), 1, 0.5);
    expect(p.x).toBeCloseTo(50);
    expect(p.y).toBeCloseTo(100);
    const back = localUV(pose(0, 0, 100, 100, Math.PI / 2), p);
    expect(back.u).toBeCloseTo(1);
    expect(back.v).toBeCloseTo(0.5);
  });
  test("an empty board fits 800 by 600, not infinity", () => {
    expect(sceneBounds(sceneOf(snapshot([])))).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });
  test("a bound endpoint follows its target; a gone one uses its stored point", () => {
    expect(
      endpoint(scene, { point: { x: 0, y: 0 }, binding: { object: "~child00001", u: 1, v: 0.5 } }),
    ).toEqual({ x: 1120, y: 555 });
    expect(
      endpoint(scene, { point: { x: 7, y: 8 }, binding: { object: "~gone000000", u: 1, v: 0.5 } }),
    ).toEqual({ x: 7, y: 8 });
  });
  test("hit-testing picks the topmost and skips ghosts", () => {
    const s = sceneOf(snapshot([sticky("~low0000000", 0, 0, "a0"), sticky("~top0000000", 10, 10, "a1")]));
    expect(hitTest(s, { x: 20, y: 20 }, 4)?.id).toBe("~top0000000");
    expect(hitTest(s, { x: 20, y: 20 }, 4, new Set(["~top0000000"]))?.id).toBe("~low0000000");
    expect(hitTest(s, { x: 500, y: 500 }, 4)).toBeNull();
  });
  test("arrows snap to the nearest connection dot", () => {
    const hit = snapDot(scene, { x: 1118, y: 556 }, 24);
    expect(hit).toMatchObject({ object: "~child00001", u: 1, v: 0.5 });
  });
  test("a pin follows its object", () => {
    expect(anchorPoint(scene, "~child00001", 0.5, 0.5)).toEqual({ x: 1070, y: 555 });
  });
});

describe("model", () => {
  test("ids match the block id pattern", () => {
    for (let i = 0; i < 50; i++) expect(mintBoardObjectId()).toMatch(/^~[0-9a-z]{10}$/);
  });

  test("a snapshot round-trips through Y.Maps, with Y.Text", () => {
    const original = snapshot([
      {
        ...sticky("~round00001", 5, 6),
        text: "Hello",
        attribution: { ...attribution, text: [{ s: 0, e: 5, a: "a1", t: T }] },
      } as BoardObject,
    ]);
    const doc = boardToY(original);
    const map = doc.getMap<Y.Map<unknown>>("objects").get("~round00001");
    expect(map?.get("text")).toBeInstanceOf(Y.Text);
    const back = yToBoard(doc);
    expect(back.objects).toEqual(original.objects);
    expect(SnapshotSchema.safeParse(back).success).toBe(true);
  });

  test("writes are stamped, one undo item per gesture, and deletion is remove-wins", () => {
    const doc = boardToY(snapshot([]));
    const writer = new BoardWriter(doc, () => "a7");
    doc.getMap("board").set("page", "board");
    const a = writer.add({ kind: "sticky", text: "One" }, pose(0, 0));
    const b = writer.add({ kind: "shape", shape: "rect", text: "" }, pose(300, 0));
    const arrow = writer.add(
      {
        kind: "connector",
        data: {
          start: { point: { x: 100, y: 25 }, binding: { object: a, u: 1, v: 0.5 } },
          end: { point: { x: 300, y: 25 }, binding: { object: b, u: 0, v: 0.5 } },
          route: "straight",
          startArrow: false,
          endArrow: true,
        },
      },
      pose(100, 25, 200, 1),
    );
    writer.transact(() => writer.place(b, pose(300, 200)));
    let s = sceneOf(yToBoard(doc));
    const c = s.objects.get(arrow);
    expect(c?.kind === "connector" && endpoint(s, c.data.end)).toEqual({ x: 300, y: 225 });
    expect(s.objects.get(b)?.attribution.fields.pose?.a).toBe("a7");
    writer.transact(() => writer.remove(b));
    s = sceneOf(yToBoard(doc));
    expect(s.objects.has(b)).toBe(false);
    const freed = s.objects.get(arrow);
    expect(freed?.kind === "connector" && freed.data.end.binding).toBeNull();
    expect(writer.undo.undo().done).toBe(true);
    s = sceneOf(yToBoard(doc));
    expect(s.objects.has(b)).toBe(true);
    const back = s.objects.get(arrow);
    expect(back?.kind === "connector" && back.data.end.binding?.object).toBe(b);
  });

  test("two writers converge: pose and text merge independently", () => {
    const one = boardToY(snapshot([sticky("~shared0001", 0, 0)]));
    const two = new Y.Doc();
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    new BoardWriter(one, () => "a1").transact(() =>
      new BoardWriter(one, () => "a1").place("~shared0001", pose(50, 50)),
    );
    const w2 = new BoardWriter(two, () => "a2");
    w2.transact(() => w2.setText("~shared0001", "From two"));
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two));
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    expect(yToBoard(one)).toEqual(yToBoard(two));
    const merged = yToBoard(one).objects[0] as Extract<BoardObject, { kind: "sticky" }>;
    expect(merged.pose).toEqual(pose(50, 50));
    expect(merged.text).toBe("From two");
    expect(merged.attribution.text).toEqual([
      { s: 0, e: 8, a: "a2", t: merged.attribution.text[0]?.t as string },
    ]);
  });
});

describe("pointer ownership", () => {
  const run = (
    route: (p: Input) => Route,
    steps: [keyof Arbiter & ("down" | "move" | "up"), Input, boolean?][],
  ) => {
    const arbiter = new Arbiter(route);
    const out: Action["t"][] = [];
    for (const [verb, p, cancel] of steps)
      for (const action of verb === "up" ? arbiter.up(p, cancel) : arbiter[verb](p)) out.push(action.t);
    return out;
  };
  const pen = (x: number, t = 0): Input => ({ id: 1, type: "pen", x, y: 0, t });
  const palm = (id: number, x = 0, t = 0): Input => ({ id, type: "touch", x, y: 0, t });
  const pencil = (p: Input): Route => (p.type === "pen" ? "ink" : "nav");

  test("only the initiating pen extends and ends its stroke; palms are ignored", () => {
    expect(
      run(pencil, [
        ["down", pen(0)],
        ["down", palm(9)],
        ["move", palm(9, 40)],
        ["move", pen(10)],
        ["up", palm(9)],
        ["up", palm(9), true],
        ["move", pen(20)],
        ["up", pen(20)],
      ]),
    ).toEqual(["ink-start", "ink-move", "ink-move", "ink-end"]);
  });
  test("a second pen cannot draw into or end the first stroke", () => {
    const other: Input = { id: 2, type: "pen", x: 0, y: 0, t: 0 };
    expect(
      run(pencil, [
        ["down", pen(0)],
        ["down", other],
        ["move", other],
        ["up", other],
        ["up", pen(5)],
      ]),
    ).toEqual(["ink-start", "ink-end"]);
  });
  test("fingers navigate after the pen lifts", () => {
    expect(
      run(pencil, [
        ["down", pen(0)],
        ["up", pen(0)],
        ["down", palm(3)],
        ["move", palm(3, 30)],
      ]),
    ).toEqual(["ink-start", "ink-end", "nav-down", "nav-move"]);
  });
  test("a second finger during a finger stroke cancels it and pinches", () => {
    const finger = (): Route => "ink";
    expect(
      run(finger, [
        ["down", palm(1)],
        ["move", palm(1, 5)],
        ["down", palm(2, 100)],
        ["move", palm(2, 140)],
      ]),
    ).toEqual(["ink-start", "ink-move", "ink-cancel", "nav-down", "nav-down", "nav-move"]);
  });
  test("a still two-finger tap is undo; a pinch is not", () => {
    const nav = (): Route => "nav";
    expect(
      run(nav, [
        ["down", palm(1, 0, 0)],
        ["down", palm(2, 80, 20)],
        ["up", palm(1, 0, 90)],
        ["up", palm(2, 80, 100)],
      ]),
    ).toContain("undo");
    expect(
      run(nav, [
        ["down", palm(1, 0, 0)],
        ["down", palm(2, 80, 20)],
        ["move", palm(2, 160, 40)],
        ["up", palm(1, 0, 90)],
        ["up", palm(2, 160, 100)],
      ]),
    ).not.toContain("undo");
  });
});
