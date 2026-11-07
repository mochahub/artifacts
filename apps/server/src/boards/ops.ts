import { createHash } from "node:crypto";
import {
  assetsMap,
  canonicalJSON,
  deletedMap,
  objectsMap,
  objectToY,
  setBoardText,
  validateBoard,
  yToBoard,
} from "@artifacts/doc/board";
import { boardBase } from "@artifacts/doc/board-hash";
import { mintBoardObjectId } from "@artifacts/doc/board-ids";
import { keyBetween } from "@artifacts/doc/board-order";
import {
  type AgentPolicy,
  BOARD_CALL_MAX,
  BOARD_COORD_MAX,
  BOARD_DEPTH_MAX,
  BOARD_OBJECT_JSON_MAX,
  BOARD_OBJECTS_MAX,
  BOARD_PLACEMENT_TRIES,
  DAY_MS,
  EDIT_CALLS_PER_MINUTE,
  MINUTE_MS,
  SUGGESTION_DAYS,
  SUGGESTIONS_OPEN_MAX,
  type WikiMeta,
} from "@artifacts/schema";
import type {
  BoardDeletedObject,
  BoardEditRequest,
  BoardEditResult,
  BoardEndpoint,
  BoardImage,
  BoardObject,
  BoardOp,
  BoardPose,
  BoardSnapshot,
} from "@artifacts/schema/boards";
import { and, eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import type { LoadedArtifact } from "../auth/access.ts";
import { type Caller, limiterKey } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import {
  activity,
  boardRequests,
  boardSuggestions,
  editDocs,
  frames,
  suggestions,
  versions,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { checkpointLocked, queueFixes } from "../editing/checkpoint.ts";
import { agentPolicy, freshPresence, type Policy } from "../editing/policy.ts";
import {
  type Actor,
  authorKey,
  type DocLock,
  editActor,
  editability,
  loadDoc,
  persistUpdate,
  withDocLock,
} from "../editing/store.ts";
import { ApiError } from "../http/errors.ts";
import { validateWikiSources } from "../wiki/service.ts";
import { validatedImages } from "./checkpoint.ts";

/**
 * Agents' board operations as a pure plan over `BoardSnapshot` JSON (14, "Agent operations and
 * placement"): resolve refs, check bases, run every op in order on a copy, and say whether the whole
 * batch applies, waits as one suggestion, or is refused. Nothing here touches Yjs or the database.
 */

type Rendered = Extract<BoardObject, { kind: "rendered_frame" }>;
type RenderedData = Rendered["data"];
type Connector = Extract<BoardObject, { kind: "connector" }>;
export type Reason = NonNullable<BoardEditResult["reason"]>;
type Field = "pose" | "parent" | "order" | "style" | "label" | "data";
type Fields = BoardObject["attribution"]["fields"];
type Box = { x: number; y: number; w: number; h: number };

export type PlanContext = {
  /** The author key and ISO time every authored field of this batch is stamped with. */
  author: string;
  time: string;
  /** A fresh object id; the planner retries a collision with any known id. */
  mint(): string;
  /** Ids no new object may take: reserved by open suggestions, beyond this snapshot's own. */
  reserved?: Set<string>;
  /** Fresh holds from people's connections (and, on acceptance, other people's only). */
  held(id: string): boolean;
  /** A validated raster on this artifact, or null. */
  asset(hash: string): BoardImage | null;
  /** The current published rendered data for `(page, frame)`, or null when it was never published. */
  source(source: { page: string; frame: string }): RenderedData | null;
  /** `page\u0000frame` of sources reserved by another open placement proposal. */
  reservedSources?: Set<string>;
  /** A person reviewed the new preview: stale bases don't refuse. */
  force?: boolean;
  /** Ids an accepted suggestion promised, by `$ref`. */
  ids?: Record<string, string>;
};

export type BatchPlan =
  | { outcome: "refused"; reason: Reason; message: string }
  | {
      outcome: "ok";
      /** Ids that existed and that this batch writes; any held one turns the batch into a suggestion. */
      touched: string[];
      held: string[];
      ids: Record<string, string>;
      results: { index: number; objects: string[] }[];
      before: BoardSnapshot;
      after: BoardSnapshot;
      meta: Omit<Extract<BoardOp, { op: "meta" }>, "op"> | null;
    };

class Refusal extends Error {
  constructor(
    readonly reason: Reason,
    message: string,
  ) {
    super(message);
  }
}
const refuse = (reason: Reason, message: string): never => {
  throw new Refusal(reason, message);
};

// Canonical JSON and bases come from the board model package, shared with the checkpoint and viewer.

export const canonical = canonicalJSON;
/** An object's operation base: its visible authored fields, without attribution; a connector without pose. */
export const objectBase = boardBase;

// ---------------------------------------------------------------------------------------------------
// Geometry: parent-local translations, rotation about the centre, world AABBs.

const byOrder = (a: BoardObject, b: BoardObject) =>
  a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** The axis-aligned box around a pose's rotated corners. */
export function poseBox(pose: BoardPose): Box {
  if (!pose.angle) return { x: pose.x, y: pose.y, w: pose.w, h: pose.h };
  const cos = Math.abs(Math.cos(pose.angle));
  const sin = Math.abs(Math.sin(pose.angle));
  const w = pose.w * cos + pose.h * sin;
  const h = pose.w * sin + pose.h * cos;
  return { x: pose.x + pose.w / 2 - w / 2, y: pose.y + pose.h / 2 - h / 2, w, h };
}
const union = (boxes: Box[]): Box | null => {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: bottom - y };
};
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Does a segment cross (or lie in) a box? Liang–Barsky clipping. */
function segmentHits(p: { x: number; y: number }, q: { x: number; y: number }, box: Box) {
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const edges: [number, number][] = [
    [-dx, p.x - box.x],
    [dx, box.x + box.w - p.x],
    [-dy, p.y - box.y],
    [dy, box.y + box.h - p.y],
  ];
  for (const [num, room] of edges) {
    if (num === 0) {
      if (room <= 0) return false;
      continue;
    }
    const t = room / num;
    if (num < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return true;
}

class Scene {
  readonly objects: Map<string, BoardObject>;
  constructor(objects: BoardObject[]) {
    this.objects = new Map(objects.map((o) => [o.id, structuredClone(o)]));
  }
  get(id: string) {
    return this.objects.get(id);
  }
  children(parent: string | null) {
    return [...this.objects.values()].filter((o) => o.parent === parent).sort(byOrder);
  }
  descendants(id: string): string[] {
    const out: string[] = [];
    const walk = (at: string) => {
      for (const child of this.children(at)) {
        out.push(child.id);
        walk(child.id);
      }
    };
    walk(id);
    return out;
  }
  /** The board translation of a parent, adding every ancestor frame's x/y. */
  offset(parent: string | null): { x: number; y: number } {
    let x = 0;
    let y = 0;
    let at = parent;
    for (let depth = 0; at && depth <= BOARD_DEPTH_MAX + 1; depth++) {
      const frame = this.objects.get(at);
      if (!frame) break;
      x += frame.pose.x;
      y += frame.pose.y;
      at = frame.parent;
    }
    return { x, y };
  }
  depth(id: string | null): number {
    let n = 0;
    for (let at = id; at; at = this.objects.get(at)?.parent ?? null) n++;
    return n;
  }
  /** Container levels under an object, itself included when it's a frame. */
  height(id: string): number {
    const object = this.objects.get(id);
    if (object?.kind !== "frame") return 0;
    return 1 + Math.max(0, ...this.children(id).map((child) => this.height(child.id)));
  }
  world(id: string): BoardPose {
    const object = this.objects.get(id) as BoardObject;
    const at = this.offset(object.parent);
    return { ...object.pose, x: object.pose.x + at.x, y: object.pose.y + at.y };
  }
  endpoint(end: BoardEndpoint): { x: number; y: number } {
    const target = end.binding ? this.objects.get(end.binding.object) : undefined;
    if (!end.binding || !target) return end.point;
    const pose = this.world(target.id);
    const lx = (end.binding.u - 0.5) * pose.w;
    const ly = (end.binding.v - 0.5) * pose.h;
    const cos = Math.cos(pose.angle);
    const sin = Math.sin(pose.angle);
    return { x: pose.x + pose.w / 2 + lx * cos - ly * sin, y: pose.y + pose.h / 2 + lx * sin + ly * cos };
  }
  /** A connector's segments in board coordinates: straight, or bent at (end.x, start.y). */
  segments(connector: Connector) {
    const a = this.endpoint(connector.data.start);
    const b = this.endpoint(connector.data.end);
    if (connector.data.route === "straight") return [[a, b]] as const;
    const bend = { x: b.x, y: a.y };
    return [
      [a, bend],
      [bend, b],
    ] as const;
  }
  /** World AABB of an object with its descendants; a connector's is its endpoints'. */
  box(id: string): Box {
    const object = this.objects.get(id) as BoardObject;
    if (object.kind === "connector") {
      const points = this.segments(object).flat();
      const x = Math.min(...points.map((p) => p.x));
      const y = Math.min(...points.map((p) => p.y));
      return {
        x,
        y,
        w: Math.max(1, Math.max(...points.map((p) => p.x)) - x),
        h: Math.max(1, Math.max(...points.map((p) => p.y)) - y),
      };
    }
    return union([poseBox(this.world(id)), ...this.descendants(id).map((d) => this.box(d))]) as Box;
  }
  /** A connector's derived pose: the axis-aligned bound of its endpoints, at least 1px each way. */
  connectorPose(data: Connector["data"]): BoardPose {
    const a = this.endpoint(data.start);
    const b = this.endpoint(data.end);
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.max(1, Math.abs(a.x - b.x)),
      h: Math.max(1, Math.abs(a.y - b.y)),
      angle: 0,
    };
  }
}

// ---------------------------------------------------------------------------------------------------
// Placement (14, "Placement algorithm").

export type PlaceSide = "right" | "below" | "left" | "above";

/**
 * Where a box of `size` goes beside `near`: the first of up to 100 candidates, stepping along the
 * perpendicular positive axis, that overlaps no obstacle (each grown by gap/2) and stays inside the
 * world. Obstacles are boxes, or segments for connectors. Null when every candidate is taken.
 */
export function placeBeside(input: {
  near: Box;
  size: { w: number; h: number };
  side: PlaceSide;
  gap: number;
  obstacles: Box[];
  lines?: [{ x: number; y: number }, { x: number; y: number }][];
}): { x: number; y: number } | null {
  const { near, size, side, gap } = input;
  const half = gap / 2;
  const grown = input.obstacles.map((b) => ({ x: b.x - half, y: b.y - half, w: b.w + gap, h: b.h + gap }));
  let x = side === "right" ? near.x + near.w + gap : side === "left" ? near.x - gap - size.w : near.x;
  let y = side === "below" ? near.y + near.h + gap : side === "above" ? near.y - gap - size.h : near.y;
  for (let i = 0; i < BOARD_PLACEMENT_TRIES; i++) {
    const at = { x, y, w: size.w, h: size.h };
    const inside =
      at.x >= -BOARD_COORD_MAX &&
      at.y >= -BOARD_COORD_MAX &&
      at.x + at.w <= BOARD_COORD_MAX &&
      at.y + at.h <= BOARD_COORD_MAX;
    if (!inside) return null;
    const padded = { x: at.x - half, y: at.y - half, w: at.w + gap, h: at.h + gap };
    const free =
      !grown.some((b) => overlaps(at, b)) && !(input.lines ?? []).some(([p, q]) => segmentHits(p, q, padded));
    if (free) return { x, y };
    if (side === "right" || side === "left") y += size.h + gap;
    else x += size.w + gap;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// The planner.

const sourceKey = (source: { page: string; frame: string }) => `${source.page}\u0000${source.frame}`;
const TEXT_KINDS = new Set(["sticky", "text", "shape"]);
const kindFields = (object: BoardObject): unknown => {
  switch (object.kind) {
    case "shape":
      return { shape: object.shape };
    case "image":
      return { asset: object.asset, alt: object.alt };
    case "stroke":
      return { points: object.points };
    case "connector":
    case "rendered_frame":
      return object.data;
    default:
      return null;
  }
};
/** What a person sees changed, field by field, for stamping only what this batch wrote. */
const fieldValue = (object: BoardObject, field: Field) =>
  field === "data" ? kindFields(object) : (object as Record<string, unknown>)[field];

/**
 * Plans a batch (14, "Agent operations and placement"). Refuses the whole batch on the first missing
 * target, invalid op, stale base or limit; stale bases are checked before any other failure is told.
 */
export function planBoardBatch(
  snapshot: BoardSnapshot,
  request: Pick<BoardEditRequest, "bases" | "ops">,
  ctx: PlanContext,
): BatchPlan {
  const initial = new Map(snapshot.objects.map((o) => [o.id, o]));
  const initialBase = new Map(snapshot.objects.map((o) => [o.id, objectBase(o)]));
  const tombstones = new Map(snapshot.deleted.map((d) => [d.id, d]));
  const scene = new Scene(snapshot.objects);
  const deleted: BoardDeletedObject[] = [...snapshot.deleted];
  const assets = new Map(snapshot.assets.map((a) => [a.hash, a]));
  const refs = new Map<string, string>();
  const required = new Set<string>();
  const touched = new Set<string>();
  const results: { index: number; objects: string[] }[] = [];
  const created = new Set<string>();
  const stamped = new Map<string, Set<Field>>();
  let meta: Extract<BatchPlan, { outcome: "ok" }>["meta"] = null;

  const known = (id: string) =>
    initial.has(id) || tombstones.has(id) || scene.objects.has(id) || !!ctx.reserved?.has(id);
  const mint = (ref: string) => {
    const promised = ctx.ids?.[ref];
    if (promised) {
      if (scene.objects.has(promised) || tombstones.has(promised))
        refuse("invalid", `The id ${promised} this suggestion promised is taken.`);
      return promised;
    }
    for (let i = 0; i < 8; i++) {
      const id = ctx.mint();
      if (!known(id) && ![...refs.values()].includes(id)) return id;
    }
    return refuse("invalid", "Couldn't make a fresh id. Try again.");
  };
  const declare = (ref: string) => {
    if (refs.has(ref)) refuse("invalid", `${ref} is declared twice in this batch.`);
    const id = mint(ref);
    refs.set(ref, id);
    created.add(id);
    return id;
  };
  /** A target: a lasting id that exists now, or a `$ref` an earlier op declared. */
  const resolve = (ref: string, role: "write" | "read" = "write"): BoardObject => {
    if (ref.startsWith("$")) {
      const id = refs.get(ref);
      if (!id) return refuse("invalid", `${ref} isn't declared by an earlier op in this batch.`);
      const found = scene.get(id);
      if (!found) return refuse("missing", `${ref} was deleted earlier in this batch.`);
      return found;
    }
    const found = scene.get(ref);
    if (!found) {
      if (tombstones.has(ref) || (initial.has(ref) && !scene.objects.has(ref)))
        return refuse("missing", `${ref} was deleted. Read the board again.`);
      return refuse("missing", `No object ${ref} on this board. Read it again.`);
    }
    if (initial.has(found.id)) {
      required.add(found.id);
      if (role === "write") touched.add(found.id);
    }
    return found;
  };
  const stamp = (id: string, ...fields: Field[]) => {
    const object = scene.get(id) as BoardObject;
    const set = stamped.get(id) ?? new Set<Field>();
    for (const field of fields) {
      set.add(field);
      object.attribution.fields[field] = { a: ctx.author, t: ctx.time };
    }
    stamped.set(id, set);
  };
  const lastKey = (parent: string | null) => keyBetween(scene.children(parent).at(-1)?.order ?? null, null);
  const parentFrame = (ref: string | null): string | null => {
    if (ref === null) return null;
    const parent = resolve(ref);
    if (parent.kind !== "frame") refuse("invalid", `${parent.id} isn't a frame, so it can't hold objects.`);
    return parent.id;
  };
  const checkDepth = (id: string) => {
    if (scene.depth(scene.get(id)?.parent ?? null) + scene.height(id) > BOARD_DEPTH_MAX)
      refuse("limit", `Frames nest at most ${BOARD_DEPTH_MAX} deep.`);
  };
  /** Reparents keeping board geometry: the new local pose is the world pose minus the new parent's. */
  const reparent = (id: string, parent: string | null) => {
    const object = scene.get(id) as BoardObject;
    const world = scene.world(id);
    const at = scene.offset(parent);
    object.parent = parent;
    object.pose = { ...object.pose, x: world.x - at.x, y: world.y - at.y };
    stamp(id, "pose", "parent");
  };
  const endpointIn = (end: {
    point: { x: number; y: number };
    binding: { object: string; u: number; v: number } | null;
  }): BoardEndpoint => {
    if (!end.binding) return { point: end.point, binding: null };
    const target = resolve(end.binding.object, "read");
    if (target.kind === "connector") refuse("invalid", "A connector can't bind to another connector.");
    const binding = { object: target.id, u: end.binding.u, v: end.binding.v };
    return { point: scene.endpoint({ point: end.point, binding }), binding };
  };
  /** A deletion: remove-wins tombstone, and every connector bound to it freezes where it was. */
  const remove = (id: string) => {
    const object = scene.get(id) as BoardObject;
    for (const other of scene.objects.values()) {
      if (other.kind !== "connector" || other.id === id) continue;
      let changed = false;
      const data = structuredClone(other.data);
      for (const end of [data.start, data.end]) {
        if (end.binding?.object !== id) continue;
        end.point = scene.endpoint(end);
        end.binding = null;
        changed = true;
      }
      if (!changed) continue;
      if (initial.has(other.id)) touched.add(other.id);
      other.data = data;
      stamp(other.id, "data");
    }
    deleted.push({
      id,
      a: ctx.author,
      t: ctx.time,
      pose: object.pose,
      parent: object.parent,
      worldPose: scene.world(id),
      ...(object.kind === "rendered_frame" ? { source: object.data.source } : {}),
    });
    scene.objects.delete(id);
    created.delete(id);
  };
  const repose = (connector: Connector) => {
    connector.pose = scene.connectorPose(connector.data);
  };
  const stalePending = (): Refusal | null => {
    if (ctx.force) return null;
    for (const id of required) {
      const base = request.bases[id];
      const current = initialBase.get(id);
      if (base !== undefined && current !== undefined && base !== current)
        return new Refusal(
          "stale",
          `${id} changed since you read it (base ${current} now). Read the board again, then retry.`,
        );
    }
    return null;
  };

  try {
    for (const [index, op] of request.ops.entries()) {
      switch (op.op) {
        case "add": {
          const parent = parentFrame(op.object.parent);
          if (op.object.kind === "image") {
            const image = ctx.asset(op.object.asset);
            if (!image)
              refuse("missing", `No validated image ${op.object.asset} on this board. Upload it first.`);
            assets.set(op.object.asset, image as BoardImage);
          }
          if (op.object.kind === "frame" && op.object.pose.angle !== 0)
            refuse("invalid", "A frame can't be rotated.");
          const id = declare(op.ref);
          const { parent: _, ...fields } = op.object;
          const text = "text" in fields ? fields.text : null;
          const object = {
            ...fields,
            id,
            parent,
            order: lastKey(parent),
            attribution: {
              created: { a: ctx.author, t: ctx.time },
              fields: {} as Fields,
              text: text ? [{ s: 0, e: text.length, a: ctx.author, t: ctx.time }] : [],
            },
          } as BoardObject;
          scene.objects.set(id, object);
          stamp(id, "pose", "parent", "order", "style", "label", "data");
          if (parent) checkDepth(id);
          results.push({ index, objects: [id] });
          break;
        }
        case "move": {
          const object = resolve(op.object);
          if (object.kind === "connector")
            refuse("invalid", "Move a connector by binding its ends with a bind op.");
          if (object.kind === "frame" && op.pose.angle !== 0) refuse("invalid", "A frame can't be rotated.");
          // Moving a group translates what's in it: each descendant is checked as if it moved itself.
          for (const id of scene.descendants(object.id)) {
            if (initial.has(id)) {
              required.add(id);
              touched.add(id);
            }
          }
          object.pose = op.pose;
          stamp(object.id, "pose");
          results.push({ index, objects: [object.id] });
          break;
        }
        case "update": {
          const object = resolve(op.object);
          const patch = op.patch;
          const fits = (field: string, kinds: string[]) => {
            if (!kinds.includes(object.kind)) refuse("invalid", `A ${object.kind} has no ${field}.`);
          };
          if (patch.text !== undefined) fits("text", ["sticky", "text", "shape"]);
          if (patch.shape !== undefined) fits("shape", ["shape"]);
          if (patch.asset !== undefined || patch.alt !== undefined) fits("asset or alt", ["image"]);
          if (patch.label !== undefined && patch.label !== object.label) {
            object.label = patch.label;
            stamp(object.id, "label");
          }
          if (patch.style) {
            const style = { ...object.style, ...patch.style };
            if (canonical(style) !== canonical(object.style)) {
              object.style = style;
              stamp(object.id, "style");
            }
          }
          if (patch.text !== undefined && "text" in object && object.text !== patch.text) {
            object.attribution.text = diffRuns(object.text, patch.text, object.attribution.text, ctx);
            object.text = patch.text;
          }
          if (object.kind === "shape" && patch.shape !== undefined && patch.shape !== object.shape) {
            object.shape = patch.shape;
            stamp(object.id, "data");
          }
          if (object.kind === "image") {
            if (patch.asset !== undefined && patch.asset !== object.asset) {
              const image = ctx.asset(patch.asset);
              if (!image)
                refuse("missing", `No validated image ${patch.asset} on this board. Upload it first.`);
              assets.set(patch.asset, image as BoardImage);
              object.asset = patch.asset;
              stamp(object.id, "data");
            }
            if (patch.alt !== undefined && patch.alt !== object.alt) {
              object.alt = patch.alt;
              stamp(object.id, "data");
            }
          }
          results.push({ index, objects: [object.id] });
          break;
        }
        case "connect": {
          const data = {
            start: endpointIn(op.start),
            end: endpointIn(op.end),
            route: op.route,
            startArrow: op.startArrow,
            endArrow: op.endArrow,
          };
          const id = declare(op.ref);
          scene.objects.set(id, {
            id,
            kind: "connector",
            pose: scene.connectorPose(data),
            parent: null,
            order: lastKey(null),
            label: op.label,
            style: op.style,
            data,
            attribution: { created: { a: ctx.author, t: ctx.time }, fields: {} as Fields, text: [] },
          });
          stamp(id, "pose", "parent", "order", "style", "label", "data");
          results.push({ index, objects: [id] });
          break;
        }
        case "bind": {
          const object = resolve(op.object);
          if (object.kind !== "connector") refuse("invalid", `${object.id} isn't a connector.`);
          const connector = object as Connector;
          connector.data = {
            start: endpointIn(op.start),
            end: endpointIn(op.end),
            route: op.route,
            startArrow: op.startArrow,
            endArrow: op.endArrow,
          };
          repose(connector);
          stamp(connector.id, "data", "pose");
          results.push({ index, objects: [connector.id] });
          break;
        }
        case "group": {
          const targets = op.objects.map((ref) => resolve(ref));
          if (new Set(targets.map((t) => t.id)).size !== targets.length)
            refuse("invalid", "A group names each object once.");
          const parent = targets[0]?.parent ?? null;
          if (targets.some((t) => t.parent !== parent))
            refuse("invalid", "Group objects that share a parent.");
          if (targets.some((t) => t.kind === "connector"))
            refuse("invalid", "Connectors stay at the top level; group what they connect.");
          if (parent && initial.has(parent)) {
            required.add(parent);
            touched.add(parent);
          }
          const at = scene.offset(parent);
          const bounds = union(targets.map((t) => scene.box(t.id))) as Box;
          const id = declare(op.ref);
          scene.objects.set(id, {
            id,
            kind: "frame",
            pose: {
              x: bounds.x - 24 - at.x,
              y: bounds.y - 24 - at.y,
              w: bounds.w + 48,
              h: bounds.h + 48,
              angle: 0,
            },
            parent,
            order: lastKey(parent),
            label: op.label,
            style: {
              fill: "transparent",
              stroke: "#242424",
              strokeWidth: 2,
              opacity: 1,
              fontSize: 20,
              align: "left",
            },
            attribution: { created: { a: ctx.author, t: ctx.time }, fields: {} as Fields, text: [] },
          });
          stamp(id, "pose", "parent", "order", "style", "label", "data");
          for (const target of targets) reparent(target.id, id);
          checkDepth(id);
          results.push({ index, objects: [id, ...targets.map((t) => t.id)] });
          break;
        }
        case "ungroup":
        case "delete": {
          const object = resolve(op.object);
          if (op.op === "ungroup" && object.kind !== "frame")
            refuse("invalid", `${object.id} isn't a frame.`);
          const moved: string[] = [];
          if (object.kind === "frame") {
            if (object.parent && initial.has(object.parent)) touched.add(object.parent);
            // Its direct children move up a level, where they are now: never deleted with it.
            for (const child of scene.children(object.id)) {
              if (initial.has(child.id)) {
                required.add(child.id);
                touched.add(child.id);
              }
              reparent(child.id, object.parent);
              moved.push(child.id);
            }
          }
          remove(object.id);
          results.push({ index, objects: [object.id, ...moved] });
          break;
        }
        case "reorder": {
          const object = resolve(op.object);
          const before = op.before === null ? null : resolve(op.before, "read");
          if (before && before.parent !== object.parent)
            refuse("invalid", "Reorder among objects that share a parent.");
          if (before?.id === object.id) refuse("invalid", "An object can't go before itself.");
          const siblings = scene.children(object.parent).filter((s) => s.id !== object.id);
          const at = before ? siblings.findIndex((s) => s.id === before.id) : siblings.length;
          const low = siblings[at - 1]?.order ?? null;
          const high = siblings[at]?.order ?? null;
          object.order =
            low !== null && high !== null && low >= high
              ? refuse("limit", "Those objects share an order key. Try again after the board settles.")
              : keyBetween(low, high);
          stamp(object.id, "order");
          results.push({ index, objects: [object.id] });
          break;
        }
        case "place_frame": {
          const key = sourceKey(op.source);
          const published = ctx.source(op.source);
          const existing = [...scene.objects.values()].find(
            (o): o is Rendered => o.kind === "rendered_frame" && sourceKey(o.data.source) === key,
          );
          const gone = deleted.find((d) => d.source && sourceKey(d.source) === key);
          if (!existing && gone)
            refuse(
              "missing",
              `The frame ${op.source.frame} was deleted from this board by ${gone.a}; publish a new key instead.`,
            );
          if (!existing && !published)
            refuse("missing", `No published frame ${op.source.frame} on page ${op.source.page}.`);
          if (published && published.source.board !== op.source.board)
            refuse("stale", `That frame is now on board ${published.source.board}. Read the board again.`);
          let object: BoardObject;
          if (existing) {
            if (op.ref) refuse("invalid", `That frame is already on the board as ${existing.id}: omit ref.`);
            object = resolve(existing.id);
            if (object.parent) reparent(object.id, null);
          } else {
            if (!op.ref) refuse("invalid", "Placing a frame that isn't on the board yet needs a ref.");
            if (ctx.reservedSources?.has(key))
              refuse(
                "invalid",
                "Another open suggestion already places that frame. Read it, then accept or withdraw it.",
              );
            const data = published as RenderedData;
            const id = declare(op.ref as string);
            object = {
              id,
              kind: "rendered_frame",
              pose: { x: 0, y: 0, w: data.intrinsic.w, h: data.intrinsic.h, angle: 0 },
              parent: null,
              order: lastKey(null),
              label: op.source.frame,
              style: {
                fill: "transparent",
                stroke: "#242424",
                strokeWidth: 0,
                opacity: 1,
                fontSize: 20,
                align: "left",
              },
              data: { ...data, source: op.source },
              attribution: { created: { a: ctx.author, t: ctx.time }, fields: {} as Fields, text: [] },
            };
            scene.objects.set(id, object);
            stamp(id, "pose", "parent", "order", "style", "label", "data");
          }
          let near: Box;
          if ("object" in op.near) {
            const target = resolve(op.near.object, "read");
            if (target.id === object.id) refuse("invalid", "Place a frame beside something else.");
            near = scene.box(target.id);
          } else {
            if (op.near.region.angle !== 0) refuse("invalid", "A region can't be rotated.");
            near = op.near.region;
          }
          const moving = object;
          const box = poseBox({ ...moving.pose, x: 0, y: 0 });
          const obstacles: Box[] = [];
          const lines: [{ x: number; y: number }, { x: number; y: number }][] = [];
          for (const other of scene.children(null)) {
            if (other.id === moving.id) continue;
            if (other.kind === "connector")
              lines.push(...scene.segments(other).map(([p, q]) => [p, q] as [typeof p, typeof q]));
            else obstacles.push(scene.box(other.id));
          }
          const spot = placeBeside({
            near,
            size: { w: box.w, h: box.h },
            side: op.side,
            gap: op.gap,
            obstacles,
            lines,
          });
          if (!spot)
            refuse(
              "placement_full",
              `No free space ${op.side} of that within ${BOARD_PLACEMENT_TRIES} tries. Pick another side or a region.`,
            );
          const placed = spot as { x: number; y: number };
          moving.pose = { ...moving.pose, x: placed.x - box.x, y: placed.y - box.y };
          stamp(moving.id, "pose");
          results.push({ index, objects: [moving.id] });
          break;
        }
        case "meta": {
          const { op: _, ...fields } = op;
          meta = { ...(meta ?? {}), ...fields };
          results.push({ index, objects: [] });
          break;
        }
      }
    }

    // Preconditions, against the board as read: exactly the bases the batch needs.
    const stale = stalePending();
    if (stale) throw stale;
    for (const id of required)
      if (request.bases[id] === undefined)
        refuse("invalid", `${id} needs its base from board_read in bases.`);
    for (const id of Object.keys(request.bases))
      if (!required.has(id)) refuse("invalid", `bases names ${id}, which this batch doesn't use.`);

    // Final state, whole: count, depth, bounds and size.
    if (scene.objects.size > BOARD_OBJECTS_MAX)
      refuse("limit", `A board holds at most ${BOARD_OBJECTS_MAX} objects.`);
    for (const id of new Set([...stamped.keys()].filter((id) => scene.objects.has(id)))) {
      for (const affected of [id, ...scene.descendants(id)]) {
        const box = scene.box(affected);
        if (
          !Number.isFinite(box.x + box.y + box.w + box.h) ||
          box.x < -BOARD_COORD_MAX ||
          box.y < -BOARD_COORD_MAX ||
          box.x + box.w > BOARD_COORD_MAX ||
          box.y + box.h > BOARD_COORD_MAX
        )
          refuse("limit", `${affected} would leave the board's bounds.`);
      }
      const object = scene.get(id) as BoardObject;
      if (Buffer.byteLength(JSON.stringify(object)) > BOARD_OBJECT_JSON_MAX)
        refuse("limit", `${id} would be over 256 KiB. Split it.`);
    }
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    // A stale base explains a later failure better than the failure does.
    const stale = error.reason === "stale" ? null : stalePending();
    const told = stale ?? error;
    return { outcome: "refused", reason: told.reason, message: told.message };
  }

  // Unchanged fields keep their old stamps: drop a stamp whose value didn't change.
  for (const [id, fields] of stamped) {
    const before = initial.get(id);
    const after = scene.get(id);
    if (!before || !after) continue;
    for (const field of fields) {
      if (canonical(fieldValue(before, field)) === canonical(fieldValue(after, field))) {
        const old = before.attribution.fields[field];
        if (old) after.attribution.fields[field] = old;
        else delete after.attribution.fields[field];
      }
    }
  }
  const objects = [...scene.objects.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Set(objects.flatMap((o) => (o.kind === "image" ? [o.asset] : [])));
  const after: BoardSnapshot = {
    schema: 1,
    page: snapshot.page,
    objects,
    deleted: deleted.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    assets: [...assets.values()]
      .filter((a) => used.has(a.hash) || snapshot.assets.some((s) => s.hash === a.hash))
      .sort((a, b) => (a.hash < b.hash ? -1 : 1)),
  };
  const touchedIds = [...touched].filter((id) => initial.has(id));
  return {
    outcome: "ok",
    touched: touchedIds,
    held: touchedIds.filter((id) => ctx.held(id)),
    ids: Object.fromEntries(refs),
    results,
    before: snapshot,
    after,
    meta,
  };
}

/**
 * Text author runs after a plain-text change: one changed range, by common prefix and suffix (never
 * splitting a surrogate pair). Kept characters keep their authors; inserted ones are this batch's.
 */
export function diffRuns(
  before: string,
  after: string,
  runs: { s: number; e: number; a: string; t: string }[],
  ctx: Pick<PlanContext, "author" | "time">,
) {
  const { from, removed, inserted } = textDiff(before, after);
  const out: { s: number; e: number; a: string; t: string }[] = [];
  const shift = inserted.length - removed;
  for (const run of runs) {
    // Left part, before the change.
    if (run.s < from) out.push({ ...run, e: Math.min(run.e, from) });
    // Right part, after the removed range, shifted.
    if (run.e > from + removed)
      out.push({ ...run, s: Math.max(run.s, from + removed) + shift, e: run.e + shift });
  }
  if (inserted.length) out.push({ s: from, e: from + inserted.length, a: ctx.author, t: ctx.time });
  out.sort((a, b) => a.s - b.s);
  // Neighbouring runs by the same author at the same time are one run.
  const merged: typeof out = [];
  for (const run of out) {
    const last = merged.at(-1);
    if (last && last.e === run.s && last.a === run.a && last.t === run.t) last.e = run.e;
    else if (run.e > run.s) merged.push({ ...run });
  }
  return merged;
}

/** The one changed range between two strings, in UTF-16 units, as Y.Text counts. */
export function textDiff(before: string, after: string) {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  const high = (s: string, i: number) => {
    const c = s.charCodeAt(i);
    return c >= 0xd800 && c <= 0xdbff;
  };
  if (p > 0 && high(before, p - 1)) p--;
  let s = 0;
  while (
    s < before.length - p &&
    s < after.length - p &&
    before[before.length - 1 - s] === after[after.length - 1 - s]
  )
    s++;
  if (s > 0 && high(before, before.length - s - 1)) s--;
  return { from: p, removed: before.length - p - s, inserted: after.slice(p, after.length - s) };
}

export const isTextKind = (kind: string) => TEXT_KINDS.has(kind);
export { kindFields, sourceKey };

// ---------------------------------------------------------------------------------------------------
// Writing a plan into the Y.Doc: one register per field, as the board model lays them out (14, "Yjs").

/** The board pose of an object in a snapshot, adding ancestor frames' translations. */
export function worldPoseIn(snapshot: BoardSnapshot, id: string): BoardPose | null {
  const scene = new Scene(snapshot.objects);
  return scene.get(id) ? scene.world(id) : null;
}

type Stamp = { a: string; t: string };
const register = (value: unknown, stamp: Stamp) => ({ value, a: stamp.a, t: stamp.t });

/**
 * Writes the difference between a plan's `before` and `after` into `ydoc`, in one transaction: new
 * objects as whole maps, changed fields as their registers, text as a diff against the same Y.Text (so a
 * person's unseen typing survives), deletions as remove-wins tombstones, new images in the asset map.
 */
export function writePlan(
  ydoc: Y.Doc,
  plan: Extract<BatchPlan, { outcome: "ok" }>,
  stamp: Stamp,
  origin: unknown = "agent",
) {
  const objects = objectsMap(ydoc);
  const before = new Map(plan.before.objects.map((o) => [o.id, o]));
  const scene = new Scene(plan.after.objects);
  const was = new Set(plan.before.deleted.map((d) => d.id));
  const hadAsset = new Set(plan.before.assets.map((a) => a.hash));
  ydoc.transact(() => {
    for (const image of plan.after.assets)
      if (!hadAsset.has(image.hash)) assetsMap(ydoc).set(image.hash, image);
    for (const object of plan.after.objects) {
      const old = before.get(object.id);
      if (!old) {
        objects.set(object.id, objectToY(object, scene.world(object.id)));
        continue;
      }
      const map = objects.get(object.id);
      if (!map) continue;
      const stamps = object.attribution.fields;
      if (
        canonical([old.pose, old.parent]) !== canonical([object.pose, object.parent]) &&
        object.kind !== "connector"
      )
        map.set(
          "placement",
          register(
            { pose: object.pose, parent: object.parent, worldPose: scene.world(object.id) },
            stamps.pose,
          ),
        );
      for (const field of ["order", "style", "label"] as const)
        if (canonical(old[field]) !== canonical(object[field]))
          map.set(field, register(object[field], stamps[field]));
      if (canonical(kindFields(old)) !== canonical(kindFields(object)))
        map.set("data", register(kindFields(object), stamps.data));
      if ("text" in object && "text" in old && old.text !== object.text)
        setBoardText(ydoc, object.id, object.text, stamp);
    }
    for (const tomb of plan.after.deleted) {
      if (was.has(tomb.id)) continue;
      const { id, ...value } = tomb;
      deletedMap(ydoc).set(id, value);
    }
  }, origin);
}

// ---------------------------------------------------------------------------------------------------
// applyBoardBatchLocked: policy, idempotency, the plan, then one update, one suggestion or a refusal.

/** A person accepting a suggestion: its author, its promised ids, and the person (whose own holds don't count). */
export type BoardAcceptActor = {
  personId: string;
  authorKey: string;
  actor: Actor;
  ids: Record<string, string>;
  force?: boolean;
};

const empty = (agents: AgentPolicy, seq: number, reason: Reason, message: string): BoardEditResult => ({
  outcome: "refused",
  reason,
  message,
  seq,
  version: null,
  suggestion: null,
  ids: {},
  results: [],
  agents,
});
const requestHash = (request: BoardEditRequest) =>
  createHash("sha256")
    .update(canonical({ ...request, requestId: undefined }))
    .digest("hex");
const callerKeyOf = (caller: Caller) =>
  caller.kind === "person"
    ? `person:${caller.person.id}`
    : "tokenId" in caller
      ? `token:${caller.tokenId}`
      : null;

/** Rendered sources of the latest version, keyed by `(page, frame)`, for `place_frame` on the token path. */
async function latestSources(lock: DocLock, artifact: LoadedArtifact, pageKey: string) {
  const [version] = await lock.tx
    .select({ id: versions.id, n: versions.n })
    .from(versions)
    .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, artifact.row.latestVersion)))
    .limit(1);
  const map = new Map<string, RenderedData>();
  if (!version) return map;
  const rows = await lock.tx
    .select()
    .from(frames)
    .where(and(eq(frames.versionId, version.id), eq(frames.pageKey, pageKey)))
    .limit(5000);
  for (const row of rows)
    map.set(sourceKey({ page: row.pageKey, frame: row.frameKey }), {
      source: { page: row.pageKey, board: row.boardKey, frame: row.frameKey },
      version: version.n,
      contentHash: row.contentHash,
      renders: row.renders,
      intrinsic: { w: row.w, h: row.h },
      livePath: row.livePath,
      missing: false,
    });
  return map;
}

/** Ids and sources open suggestions reserved, so a new batch neither reuses one nor places a source twice. */
async function openReservations(lock: DocLock, artifactId: string) {
  const rows = await lock.tx
    .select({ ids: boardSuggestions.ids, request: boardSuggestions.request })
    .from(boardSuggestions)
    .where(and(eq(boardSuggestions.artifactId, artifactId), eq(boardSuggestions.status, "open")));
  const ids = new Set<string>();
  const sources = new Set<string>();
  for (const row of rows) {
    for (const id of Object.values(row.ids)) ids.add(id);
    for (const op of row.request.ops)
      if (op.op === "place_frame" && op.ref) sources.add(sourceKey(op.source));
  }
  return { ids, sources };
}

/** Open proposals on this artifact, article and board together, against the one limit. */
async function openCount(lock: DocLock, artifactId: string) {
  const [a, b] = await Promise.all([
    lock.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(suggestions)
      .where(and(eq(suggestions.artifactId, artifactId), eq(suggestions.status, "open"))),
    lock.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(boardSuggestions)
      .where(and(eq(boardSuggestions.artifactId, artifactId), eq(boardSuggestions.status, "open"))),
  ]);
  return (a[0]?.n ?? 0) + (b[0]?.n ?? 0);
}

/** Why a batch is a suggestion, in the result's words; a requested suggestion has none. */
const suggestionReason = (policy: AgentPolicy, suggest?: boolean): Reason | null =>
  policy.reason === "pair"
    ? "pair"
    : policy.reason === "run"
      ? "run"
      : policy.reason === "audience"
        ? "audience"
        : suggest
          ? null
          : "audience";

/**
 * Applies one board batch under a lock the caller holds (14, "Fixed server interfaces"). Authorizes and
 * resolves policy again, checks the epoch, replays an identical retry's receipt, plans every op, then
 * writes one update, stores one suggestion, or refuses all. It never checkpoints: `boardEdit` does that
 * after, under the same lock. `accept` is a person accepting a stored batch: its author, its promised ids,
 * no policy, but other people's holds still keep it a suggestion.
 */
export async function applyBoardBatchLocked(
  deps: Deps,
  caller: Caller,
  artifact: LoadedArtifact,
  request: BoardEditRequest,
  lock: DocLock,
  accept?: BoardAcceptActor,
): Promise<BoardEditResult> {
  if (Buffer.byteLength(JSON.stringify(request)) > BOARD_CALL_MAX)
    throw new ApiError("too_large", "That batch is over 256 KiB. Send fewer ops at a time.", {
      limit: BOARD_CALL_MAX,
    });
  const state = (await editability(deps, artifact)) as Awaited<ReturnType<typeof editability>> & {
    kind?: string;
  };
  if (!state.editable)
    throw new ApiError("conflict", "This board can't be edited here.", {
      reason: "not_editable",
      editable: state.reason,
    });
  if (state.kind !== "board")
    throw new ApiError("conflict", "This page is an article: edit it with page operations.", {
      reason: "not_canvas",
    });

  let policy: Policy;
  let actor: Actor;
  if (accept) {
    const present = await freshPresence(deps, artifact.id);
    const others = new Set(
      present.filter((row) => row.personId !== accept.personId).flatMap((row) => row.objects ?? []),
    );
    policy = {
      edits: "direct",
      reason: "maintained",
      text: "A person accepted this.",
      held: (id) => others.has(id),
    };
    actor = accept.actor;
  } else {
    if (!(caller.kind === "cliToken" || caller.kind === "orgToken" || caller.kind === "person"))
      throw new ApiError("forbidden", "You can't edit this board.");
    if (!can(caller, "artifact.edit", artifact))
      throw new ApiError("forbidden", "You can't edit this board.");
    deps.limits.hit(`edit:${limiterKey(caller) ?? caller.kind}`, EDIT_CALLS_PER_MINUTE, MINUTE_MS);
    policy = await agentPolicy(deps, caller, artifact, { run: request.run, suggest: request.suggest });
    actor = editActor(caller, request.agent ?? null);
  }
  const agents: AgentPolicy = { edits: policy.edits, reason: policy.reason, text: policy.text };

  const { ydoc, row } = await loadDoc(deps, artifact.id, lock);
  if (row.epoch !== request.epoch)
    throw new ApiError("conflict", `The board was started again: read it, then use epoch ${row.epoch}.`, {
      reason: "stale_epoch",
      epoch: row.epoch,
    });
  if ((row as { kind?: string }).kind && (row as { kind?: string }).kind !== "board")
    throw new ApiError("conflict", "This page is an article: edit it with page operations.", {
      reason: "not_canvas",
    });

  // An identical retry gets its receipt back; the same id for a different batch is a conflict.
  const callerKey = accept ? null : callerKeyOf(caller);
  const hash = requestHash(request);
  if (callerKey) {
    const [kept] = await lock.tx
      .select({ hash: boardRequests.hash, epoch: boardRequests.epoch, result: boardRequests.result })
      .from(boardRequests)
      .where(
        and(
          eq(boardRequests.artifactId, artifact.id),
          eq(boardRequests.callerKey, callerKey),
          eq(boardRequests.requestId, request.requestId),
        ),
      )
      .limit(1);
    if (kept) {
      if (kept.hash !== hash || kept.epoch !== request.epoch)
        throw new ApiError("conflict", "That requestId was used for a different batch. Use a fresh one.", {
          reason: "request_reused",
        });
      return kept.result;
    }
  }

  if (policy.edits === "refused")
    return empty(agents, row.seq, policy.reason === "writing" ? "writing" : "no_edit", policy.text);
  const runId = policy.reason === "run" ? (request.run ?? null) : null;

  const snapshot = yToBoard(ydoc);
  const images = new Map(snapshot.assets.map((image) => [image.hash, image]));
  const key = accept?.authorKey ?? (await authorKey(deps, artifact.id, actor, request.sources ?? [], lock));
  const now = deps.clock.now();
  const sources = await latestSources(lock, artifact, row.pageKey);
  const reservations = await openReservations(lock, artifact.id);
  const wanted = request.ops.flatMap((op) =>
    op.op === "add" && op.object.kind === "image"
      ? [op.object.asset]
      : op.op === "update" && op.patch.asset
        ? [op.patch.asset]
        : [],
  );
  const usable = await validatedImages(lock.tx, artifact.id, wanted);
  const plan = planBoardBatch(snapshot, request, {
    author: key,
    time: now.toISOString(),
    mint: mintBoardObjectId,
    reserved: reservations.ids,
    held: policy.held,
    asset: (h) => usable.get(h) ?? images.get(h) ?? null,
    source: (s) => sources.get(sourceKey(s)) ?? null,
    reservedSources: reservations.sources,
    force: accept?.force,
    ids: accept?.ids,
  });
  if (plan.outcome === "refused") return empty(agents, row.seq, plan.reason, plan.message);

  // Meta sources are checked as a publish checks them, so a bad slug never reaches the draft.
  if (plan.meta?.sources?.length) {
    try {
      await validateWikiSources(deps, artifact.row.orgId, caller, artifact.project.id, artifact.row.slug, {
        role: "page",
        sources: plan.meta.sources,
      } as WikiMeta);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return empty(agents, row.seq, "invalid", error.message);
    }
  }

  // Accepting can't interrupt another person's drag: the stored suggestion stays open, nothing new is filed.
  if (accept && plan.held.length)
    throw new ApiError(
      "conflict",
      `Someone is working on ${plan.held.join(", ")}. Try again when they're done.`,
      {
        reason: "held",
        objects: plan.held,
      },
    );
  const direct = policy.edits === "direct" && plan.held.length === 0;
  const results = plan.results;
  let result: BoardEditResult;
  if (direct) {
    const before = Y.encodeStateVector(ydoc);
    writePlan(ydoc, plan, { a: key, t: now.toISOString() });
    const checked = validateBoard(ydoc, {
      assets: new Set(plan.after.assets.map((a) => a.hash)),
      author: key,
      touched: new Set([...plan.touched, ...Object.values(plan.ids)]),
    });
    if (!checked.ok)
      return empty(agents, row.seq, "invalid", `The board would be invalid: ${checked.reason}`);
    const update = Y.encodeStateAsUpdate(ydoc, before);
    const changed = canonical(plan.before) !== canonical(plan.after);
    const seq = changed ? await persistUpdate(deps, artifact.id, update, actor, lock) : row.seq;
    if (plan.meta) {
      const merged = { ...(lock.row?.meta ?? {}), ...plan.meta };
      await lock.tx
        .update(editDocs)
        .set({
          meta: merged,
          dirtySince: sql`coalesce(${editDocs.dirtySince}, ${now.toISOString()}::timestamptz)`,
          updatedAt: now,
          lastActorPersonId: actor.personId,
          lastAgent: actor.agent,
        })
        .where(eq(editDocs.artifactId, artifact.id));
      if (lock.row) lock.row = { ...lock.row, meta: merged };
    }
    if (!accept && request.fixes?.length)
      await queueFixes(lock, request.fixes, {
        personId: actor.personId,
        agent: actor.agent,
        tokenId: actor.tokenId,
      });
    result = {
      outcome: "applied",
      reason: null,
      message: null,
      seq,
      version: null,
      suggestion: null,
      ids: plan.ids,
      results,
      agents,
    };
  } else {
    if ((await openCount(lock, artifact.id)) >= SUGGESTIONS_OPEN_MAX)
      return empty(
        agents,
        row.seq,
        "limit",
        `This page has ${SUGGESTIONS_OPEN_MAX} open suggestions. Wait for people to decide some.`,
      );
    const id = Bun.randomUUIDv7();
    await lock.tx.insert(boardSuggestions).values({
      id,
      orgId: artifact.row.orgId,
      artifactId: artifact.id,
      pageKey: row.pageKey,
      epoch: row.epoch,
      request,
      ids: plan.ids,
      runId,
      authorKey: key,
      authorPersonId: actor.personId,
      agent: actor.agent,
      tokenId: actor.tokenId,
      note: request.note ?? null,
      sources: request.sources ?? [],
      fixes: request.fixes ?? [],
      createdAt: now,
      expiresAt: new Date(now.getTime() + SUGGESTION_DAYS * DAY_MS),
    });
    lock.after(() => deps.docs?.notify(artifact.id, "c", { t: "suggestion", id, status: "open" }));
    const reason =
      plan.held.length && policy.edits === "direct" ? "held" : suggestionReason(policy, request.suggest);
    result = {
      outcome: "suggested",
      reason,
      message:
        reason === "held"
          ? `Someone is working on ${plan.held.join(", ")}, so this waits as a suggestion.`
          : null,
      seq: row.seq,
      version: null,
      suggestion: id,
      ids: plan.ids,
      results,
      agents,
    };
  }

  if (!accept) {
    await lock.tx.insert(activity).values({
      id: Bun.randomUUIDv7(),
      orgId: artifact.row.orgId,
      artifactId: artifact.id,
      projectId: artifact.project.id,
      actorPersonId: actor.personId,
      agent: actor.agent,
      kind: result.outcome === "applied" ? "edited" : "suggested",
      payload: {
        document: "board",
        page: row.pageKey,
        seq: result.seq,
        requestId: request.requestId,
        operations: request.ops.map((op) => op.op),
        objects: new Set(results.flatMap((r) => r.objects)).size,
        ...(result.suggestion ? { suggestion: result.suggestion } : {}),
        ...(runId ? { run: runId } : {}),
      },
      createdAt: now,
    });
    if (callerKey)
      await lock.tx.insert(boardRequests).values({
        artifactId: artifact.id,
        requestId: request.requestId,
        orgId: artifact.row.orgId,
        epoch: row.epoch,
        callerKey,
        hash,
        result,
        createdAt: now,
      });
  }
  return result;
}

/**
 * The entry point every caller shares, hosted MCP, local MCP through the CLI, and the HTTP route: the
 * lock, the batch, then the checkpoint it asked for under that same lock, only when it applied. A
 * checkpoint that fails says so with no version, never as a failed edit.
 */
export async function boardEdit(
  deps: Deps,
  caller: Caller,
  artifact: LoadedArtifact,
  request: BoardEditRequest,
): Promise<BoardEditResult> {
  return withDocLock(deps, artifact.id, async (lock) => {
    const result = await applyBoardBatchLocked(deps, caller, artifact, request, lock);
    if (!request.checkpoint || result.outcome !== "applied" || result.version !== null) return result;
    if (!(caller.kind === "cliToken" || caller.kind === "orgToken" || caller.kind === "person"))
      return result;
    try {
      const made = await checkpointLocked(
        deps,
        lock,
        { row: artifact.row, project: artifact.project },
        {
          kind: caller.kind === "person" ? "saved" : "agent",
          personId: caller.kind === "orgToken" ? caller.createdBy : caller.person.id,
          agent: caller.kind === "person" ? null : request.agent?.trim() || "agent",
          message: request.note ?? null,
        },
      );
      return { ...result, version: made.version };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return result;
    }
  });
}
