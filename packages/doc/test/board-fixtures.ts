import type { BoardObject, BoardPose, BoardSnapshot, BoardStyle } from "@artifacts/schema/boards";
import { type BoardObjectInput, newObject, type Stamp } from "../src/board.ts";

export const T = "2026-11-07T12:00:00.000Z";
export const A1: Stamp = { a: "a1", t: T };
export const A2: Stamp = { a: "a2", t: T };
export const A3: Stamp = { a: "a3", t: T };
export const STYLE: BoardStyle = {
  fill: "transparent",
  stroke: "#242424",
  strokeWidth: 2,
  opacity: 1,
  fontSize: 20,
  align: "left",
};
export const pose = (x: number, y: number, w = 100, h = 80, angle = 0): BoardPose => ({ x, y, w, h, angle });
export const HASH = "a".repeat(64);
export const HASH2 = "b".repeat(64);

/** One object of every kind, in a frame where it can be. */
export function everyKind(stamp: Stamp = A1): BoardSnapshot {
  const o = (object: BoardObjectInput) => newObject(object, stamp);
  const objects: BoardObject[] = [
    o({
      id: "~frame00001",
      kind: "frame",
      pose: pose(0, 0, 600, 400),
      parent: null,
      order: "a0",
      label: "Group",
      style: STYLE,
    }),
    o({
      id: "~sticky0001",
      kind: "sticky",
      pose: pose(20, 20),
      parent: "~frame00001",
      order: "a0",
      label: "",
      style: { ...STYLE, fill: "#fff2a8" },
      text: "Hello\nworld",
    }),
    o({
      id: "~text000001",
      kind: "text",
      pose: pose(200, 20, 120, 40, 0.5),
      parent: "~frame00001",
      order: "a1",
      label: "",
      style: STYLE,
      text: "Plain 🙂",
    }),
    o({
      id: "~shape00001",
      kind: "shape",
      shape: "ellipse",
      pose: pose(700, 0),
      parent: null,
      order: "a1",
      label: "",
      style: STYLE,
      text: "",
    }),
    o({
      id: "~image00001",
      kind: "image",
      asset: HASH,
      alt: "A chart",
      pose: pose(700, 200),
      parent: null,
      order: "a2",
      label: "",
      style: STYLE,
    }),
    o({
      id: "~conn000001",
      kind: "connector",
      pose: pose(0, 0, 1, 1),
      parent: null,
      order: "a3",
      label: "",
      style: STYLE,
      data: {
        start: { point: { x: 0, y: 0 }, binding: { object: "~sticky0001", u: 1, v: 0.5 } },
        end: { point: { x: 750, y: 40 }, binding: { object: "~shape00001", u: 0, v: 0.5 } },
        route: "elbow",
        startArrow: false,
        endArrow: true,
      },
    }),
    o({
      id: "~render0001",
      kind: "rendered_frame",
      pose: pose(300, 200, 200, 150),
      parent: "~frame00001",
      order: "a2",
      label: "Home",
      style: STYLE,
      data: {
        source: { page: "board", board: "main", frame: "home" },
        version: 1,
        contentHash: HASH2,
        renders: { "1x": HASH2, "2x": HASH2, "3x": HASH2, thumb: HASH2 },
        intrinsic: { w: 390, h: 844 },
        livePath: null,
        missing: false,
      },
    }),
    o({
      id: "~stroke0001",
      kind: "stroke",
      points: [
        { u: 0, v: 0, pressure: 0.5 },
        { u: 1, v: 1, pressure: 0.7 },
      ],
      pose: pose(900, 0, 50, 50),
      parent: null,
      order: "a4",
      label: "",
      style: STYLE,
    }),
  ];
  return {
    schema: 1,
    page: "board",
    objects,
    deleted: [],
    assets: [{ hash: HASH, type: "image/png", bytes: 100, width: 10, height: 10 }],
  };
}
