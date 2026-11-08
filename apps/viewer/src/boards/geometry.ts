import type { BoardEndpoint, BoardObject, BoardPose, BoardSnapshot } from "@artifacts/schema/boards";

/**
 * Board geometry for the viewer (14, "Z-order and containment", "Connectors and deletion"): world
 * poses, bound endpoints, outline order, bounds and hit-testing. Types only from the schema, and no
 * Yjs, so the reader's chunk stays small. The board model package has the same rules for the server;
 * these must agree with it.
 */

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Scene = { objects: Map<string, BoardObject>; order: BoardObject[] };

/** An empty board fits this neutral region rather than infinity (14, "Read compatibility"). */
export const EMPTY_BOUNDS: Rect = { x: 0, y: 0, w: 800, h: 600 };
const DEPTH_MAX = 8;

const byOrder = (a: BoardObject, b: BoardObject) =>
  a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Objects by id, and in draw/outline order: parent tree, then (order, id), code-point compared. */
export function sceneOf(snapshot: Pick<BoardSnapshot, "objects">): Scene {
  const objects = new Map(snapshot.objects.map((object) => [object.id, object]));
  const children = new Map<string | null, BoardObject[]>();
  for (const object of snapshot.objects) {
    // A missing or non-frame parent draws at root, as the model's projection does.
    const parent = object.parent && objects.get(object.parent)?.kind === "frame" ? object.parent : null;
    const list = children.get(parent) ?? [];
    list.push(object);
    children.set(parent, list);
  }
  const order: BoardObject[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const object of (children.get(parent) ?? []).sort(byOrder)) {
      if (seen.has(object.id)) continue;
      seen.add(object.id);
      order.push(object);
      if (object.kind === "frame" && depth < DEPTH_MAX) walk(object.id, depth + 1);
    }
  };
  walk(null, 0);
  // Anything a cycle cut off still draws, at root, so nothing silently disappears.
  for (const object of snapshot.objects) if (!seen.has(object.id)) order.push(object);
  return { objects, order };
}

/** Parent-local translation to world: containers never rotate or scale children. */
export function worldPose(scene: Scene, id: string): BoardPose | null {
  const object = scene.objects.get(id);
  if (!object) return null;
  let { x, y } = object.pose;
  let parent = object.parent;
  for (let depth = 0; parent && depth < DEPTH_MAX; depth++) {
    const up = scene.objects.get(parent);
    if (up?.kind !== "frame") break;
    x += up.pose.x;
    y += up.pose.y;
    parent = up.parent;
  }
  return { ...object.pose, x, y };
}

/** A local (u, v) in [0,1] on a pose, rotated about its centre, in world coordinates. */
export function posePoint(pose: BoardPose, u: number, v: number): Point {
  const cx = pose.x + pose.w / 2;
  const cy = pose.y + pose.h / 2;
  const dx = (u - 0.5) * pose.w;
  const dy = (v - 0.5) * pose.h;
  const cos = Math.cos(pose.angle);
  const sin = Math.sin(pose.angle);
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/** The inverse: where a world point falls on a pose, as local (u, v) (not clamped). */
export function localUV(pose: BoardPose, point: Point): { u: number; v: number } {
  const cx = pose.x + pose.w / 2;
  const cy = pose.y + pose.h / 2;
  const cos = Math.cos(-pose.angle);
  const sin = Math.sin(-pose.angle);
  const dx = point.x - cx;
  const dy = point.y - cy;
  return { u: (dx * cos - dy * sin) / pose.w + 0.5, v: (dx * sin + dy * cos) / pose.h + 0.5 };
}

/** A visible endpoint: the bound target's current pose, or the stored point when unbound or gone. */
export function endpoint(scene: Scene, end: BoardEndpoint): Point {
  if (end.binding) {
    const pose = worldPose(scene, end.binding.object);
    if (pose) return posePoint(pose, end.binding.u, end.binding.v);
  }
  return end.point;
}

/** A connector's polyline: straight joins the ends, elbow bends at (end.x, start.y). */
export function connectorPath(scene: Scene, object: Extract<BoardObject, { kind: "connector" }>): Point[] {
  const a = endpoint(scene, object.data.start);
  const b = endpoint(scene, object.data.end);
  return object.data.route === "elbow" ? [a, { x: b.x, y: a.y }, b] : [a, b];
}

/** Axis-aligned bounds of a (possibly rotated) pose. */
export function poseBounds(pose: BoardPose): Rect {
  if (!pose.angle) return { x: pose.x, y: pose.y, w: pose.w, h: pose.h };
  const corners = [
    posePoint(pose, 0, 0),
    posePoint(pose, 1, 0),
    posePoint(pose, 1, 1),
    posePoint(pose, 0, 1),
  ];
  return pointsBounds(corners);
}

export function pointsBounds(points: Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) };
}

export function objectBounds(scene: Scene, object: BoardObject): Rect {
  if (object.kind === "connector") return pointsBounds(connectorPath(scene, object));
  const pose = worldPose(scene, object.id) ?? object.pose;
  return poseBounds(pose);
}

export function union(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

/** Whole-board bounds, never infinite: an empty board fits 800 by 600. */
export function sceneBounds(scene: Scene, ghosts?: Scene): Rect {
  const bounds = scene.order.map((object) => objectBounds(scene, object));
  if (ghosts?.order.length) {
    // Resolve ghost bindings/parents in the proposed scene, while retaining the canonical poses too.
    const proposed = sceneOf({
      objects: [...scene.order.filter((object) => !ghosts.objects.has(object.id)), ...ghosts.order],
    });
    bounds.push(...ghosts.order.map((object) => objectBounds(proposed, object)));
  }
  return union(bounds) ?? EMPTY_BOUNDS;
}

function distanceToSegment(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether a world point touches an object, within `slop` world pixels for thin things. */
export function hits(scene: Scene, object: BoardObject, point: Point, slop: number): boolean {
  if (object.kind === "connector") {
    const path = connectorPath(scene, object);
    return path.slice(1).some((b, i) => distanceToSegment(point, path[i] as Point, b) <= slop);
  }
  const pose = worldPose(scene, object.id);
  if (!pose) return false;
  const { u, v } = localUV(pose, point);
  const su = slop / pose.w;
  const sv = slop / pose.h;
  if (u < -su || u > 1 + su || v < -sv || v > 1 + sv) return false;
  if (object.kind === "stroke") {
    const pts = object.points.map((p) => posePoint(pose, p.u, p.v));
    if (pts.length === 1)
      return Math.hypot(point.x - (pts[0] as Point).x, point.y - (pts[0] as Point).y) <= slop;
    return pts.slice(1).some((b, i) => distanceToSegment(point, pts[i] as Point, b) <= slop);
  }
  if (object.kind === "shape" && object.shape === "line") {
    return distanceToSegment(point, posePoint(pose, 0, 0), posePoint(pose, 1, 1)) <= slop;
  }
  // A container is picked by its border and title, so what is inside it stays reachable.
  if (object.kind === "frame") {
    const edge = Math.min(u, v, 1 - u, 1 - v) * Math.min(pose.w, pose.h);
    return edge <= slop * 1.5 || v < 0;
  }
  return true;
}

/** The topmost object under a point, skipping ids in `skip` (ghosts are never ordinary hits). */
export function hitTest(scene: Scene, point: Point, slop: number, skip?: Set<string>): BoardObject | null {
  for (let i = scene.order.length - 1; i >= 0; i--) {
    const object = scene.order[i] as BoardObject;
    if (skip?.has(object.id)) continue;
    if (hits(scene, object, point, slop)) return object;
  }
  return null;
}

/** Plain text of an object, for the outline, labels and search. Never markup. */
export function objectText(object: BoardObject): string {
  if ("text" in object && object.text) return object.text;
  if (object.kind === "image") return object.alt;
  return object.label;
}

const KIND_WORD: Record<BoardObject["kind"], string> = {
  sticky: "Sticky",
  text: "Text",
  shape: "Shape",
  image: "Image",
  connector: "Arrow",
  frame: "Frame",
  rendered_frame: "Mock",
  stroke: "Drawing",
};
export const kindWord = (object: BoardObject) =>
  object.kind === "shape" && object.shape !== "rect"
    ? object.shape === "ellipse"
      ? "Ellipse"
      : object.shape === "diamond"
        ? "Diamond"
        : "Line"
    : KIND_WORD[object.kind];

/** A short accessible name: kind and what it says. */
export function objectName(object: BoardObject): string {
  const text = objectText(object).replace(/\s+/g, " ").trim();
  return text
    ? `${kindWord(object)}: ${text.length > 80 ? `${text.slice(0, 79)}…` : text}`
    : kindWord(object);
}

/** Where a comment pin sits on an object: its (u, v), through rotation and ancestors. */
export function anchorPoint(scene: Scene, id: string, u: number, v: number): Point | null {
  const object = scene.objects.get(id);
  if (!object) return null;
  if (object.kind === "connector") {
    const path = connectorPath(scene, object);
    const a = path[0] as Point;
    const b = path.at(-1) as Point;
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * v };
  }
  const pose = worldPose(scene, id);
  return pose ? posePoint(pose, u, v) : null;
}

/** Where a connector end snaps: the nearest of an object's four connection dots, within `radius`. */
export const DOTS: [number, number][] = [
  [0.5, 0],
  [1, 0.5],
  [0.5, 1],
  [0, 0.5],
];
export function snapDot(
  scene: Scene,
  point: Point,
  radius: number,
  skip?: Set<string>,
): { object: string; u: number; v: number; at: Point } | null {
  let best: { object: string; u: number; v: number; at: Point; d: number } | null = null;
  for (const object of scene.order) {
    if (object.kind === "connector" || object.kind === "stroke" || skip?.has(object.id)) continue;
    const pose = worldPose(scene, object.id);
    if (!pose) continue;
    for (const [u, v] of DOTS) {
      const at = posePoint(pose, u, v);
      const d = Math.hypot(at.x - point.x, at.y - point.y);
      if (d <= radius && (!best || d < best.d)) best = { object: object.id, u, v, at, d };
    }
    // Inside the object, without a dot near: bind where the point is, so the arrow lands on it.
    if (!best && object.kind !== "frame" && hits(scene, object, point, 0)) {
      const { u, v } = localUV(pose, point);
      const cu = Math.min(1, Math.max(0, u));
      const cv = Math.min(1, Math.max(0, v));
      best = { object: object.id, u: cu, v: cv, at: posePoint(pose, cu, cv), d: radius };
    }
  }
  return best && { object: best.object, u: best.u, v: best.v, at: best.at };
}
