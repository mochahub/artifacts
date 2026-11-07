import type { BoardEndpoint, BoardPose } from "@artifacts/schema/boards";
import { BOARD_COORD_MAX } from "@artifacts/schema/constants";

/**
 * Pure board geometry (14, "Z-order and containment" and "Connectors and deletion"). Board CSS pixels at
 * 1x; angle in radians clockwise around the centre. A parent frame only translates its children.
 */
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** Empty boards fit this neutral region, never an infinite or NaN one. */
export const EMPTY_BOUNDS: Rect = { x: 0, y: 0, w: 800, h: 600 };

/** Negative zero becomes zero, so hashes and comparisons agree. */
export const clean = (n: number) => (Object.is(n, -0) ? 0 : n);

/** A pose's four corners, rotated about its centre, in its own coordinate basis. */
export function corners(pose: BoardPose): Point[] {
  const cx = pose.x + pose.w / 2;
  const cy = pose.y + pose.h / 2;
  const cos = Math.cos(pose.angle);
  const sin = Math.sin(pose.angle);
  return [
    [pose.x, pose.y],
    [pose.x + pose.w, pose.y],
    [pose.x + pose.w, pose.y + pose.h],
    [pose.x, pose.y + pose.h],
  ].map(([x, y]) => {
    const dx = (x as number) - cx;
    const dy = (y as number) - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  });
}

/** Axis-aligned bounds of a (rotated) pose. */
export function poseBounds(pose: BoardPose): Rect {
  return pointsBounds(corners(pose));
}

export function pointsBounds(points: Point[], min = 0): Rect {
  if (points.length === 0) return { ...EMPTY_BOUNDS };
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { x: left, y: top, w: Math.max(min, right - left), h: Math.max(min, bottom - top) };
}

export function unionBounds(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  return pointsBounds(
    rects.flatMap((r) => [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
    ]),
  );
}

/** Whether every corner is finite and inside the world bounds. */
export function poseInWorld(pose: BoardPose): boolean {
  return corners(pose).every(
    (p) =>
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      Math.abs(p.x) <= BOARD_COORD_MAX &&
      Math.abs(p.y) <= BOARD_COORD_MAX,
  );
}

/** A local pose translated by an ancestor offset (the sum of ancestor frames' x/y). */
export const translate = (pose: BoardPose, by: Point): BoardPose => ({
  ...pose,
  x: clean(pose.x + by.x),
  y: clean(pose.y + by.y),
});

/** A target-local normalized point `(u, v)`, rotated with the pose and moved into board coordinates. */
export function poseLocalPoint(world: BoardPose, u: number, v: number): Point {
  const cx = world.x + world.w / 2;
  const cy = world.y + world.h / 2;
  const dx = (u - 0.5) * world.w;
  const dy = (v - 0.5) * world.h;
  const cos = Math.cos(world.angle);
  const sin = Math.sin(world.angle);
  return { x: clean(cx + dx * cos - dy * sin), y: clean(cy + dx * sin + dy * cos) };
}

/** The inverse: where a board point falls in a pose's normalized local space (may be outside 0..1). */
export function worldToLocal(world: BoardPose, point: Point): { u: number; v: number } {
  const cx = world.x + world.w / 2;
  const cy = world.y + world.h / 2;
  const cos = Math.cos(-world.angle);
  const sin = Math.sin(-world.angle);
  const dx = point.x - cx;
  const dy = point.y - cy;
  return { u: (dx * cos - dy * sin) / world.w + 0.5, v: (dx * sin + dy * cos) / world.h + 0.5 };
}

/** The pose a connector shows: the endpoints' axis-aligned bound, at least 1px each way, angle zero. */
export function connectorPose(start: Point, end: Point): BoardPose {
  const b = pointsBounds([start, end], 1);
  return { x: clean(b.x), y: clean(b.y), w: b.w, h: b.h, angle: 0 };
}

/** The drawn path: straight joins the points; elbow bends once at `(end.x, start.y)`. */
export function connectorPath(start: Point, end: Point, route: "straight" | "elbow"): Point[] {
  return route === "elbow" ? [start, { x: end.x, y: start.y }, end] : [start, end];
}

/** An endpoint's visible point given a resolver for its bound target's world pose. */
export function endpointPoint(endpoint: BoardEndpoint, worldOf: (id: string) => BoardPose | null): Point {
  if (!endpoint.binding) return endpoint.point;
  const world = worldOf(endpoint.binding.object);
  return world ? poseLocalPoint(world, endpoint.binding.u, endpoint.binding.v) : endpoint.point;
}

/** Whether two rects overlap (touching edges don't). */
export const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export const expand = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + 2 * by,
  h: r.h + 2 * by,
});

/** A stroke's points simplified to at most `max`, keeping both endpoints (Ramer-Douglas-Peucker). */
export function simplifyStroke<T extends { u: number; v: number }>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const dist = (p: T, a: T, b: T) => {
    const dx = b.u - a.u;
    const dy = b.v - a.v;
    const len = Math.hypot(dx, dy);
    if (len === 0) return Math.hypot(p.u - a.u, p.v - a.v);
    return Math.abs(dy * p.u - dx * p.v + b.u * a.v - b.v * a.u) / len;
  };
  // Add the farthest remaining point until the budget is used: deterministic and endpoint-preserving.
  let count = 2;
  const segments: [number, number][] = [[0, points.length - 1]];
  while (count < max && segments.length) {
    let best = -1;
    let bestAt = -1;
    let bestSeg = -1;
    for (const [s, [a, b]] of segments.entries()) {
      for (let i = a + 1; i < b; i++) {
        const d = dist(points[i] as T, points[a] as T, points[b] as T);
        if (d > best) {
          best = d;
          bestAt = i;
          bestSeg = s;
        }
      }
    }
    if (bestAt < 0) break;
    const [a, b] = segments[bestSeg] as [number, number];
    segments.splice(bestSeg, 1, [a, bestAt], [bestAt, b]);
    keep[bestAt] = 1;
    count++;
  }
  return points.filter((_, i) => keep[i] === 1);
}
