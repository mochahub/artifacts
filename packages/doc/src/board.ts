import {
  type BoardDeletedObject,
  BoardDeletedObject as BoardDeletedSchema,
  type BoardEndpoint,
  type BoardImage,
  BoardImage as BoardImageSchema,
  type BoardObject,
  BoardObject as BoardObjectSchema,
  type BoardPose,
  type BoardSnapshot,
  type BoardStyle,
} from "@artifacts/schema/boards";
import {
  BLOCK_ID_PATTERN,
  BOARD_ASSETS_MAX,
  BOARD_DEPTH_MAX,
  BOARD_JSON_MAX,
  BOARD_OBJECTS_MAX,
  BOARD_ORDER_MAX,
  KEY_PATTERN,
} from "@artifacts/schema/constants";
import * as Y from "yjs";
import {
  clean,
  connectorPose,
  endpointPoint,
  poseInWorld,
  poseLocalPoint,
  translate,
} from "./board-geometry.ts";
import { compareSiblings, isOrderKey, rebalanceOrders } from "./board-order.ts";

/**
 * The board document model (14, "Yjs mapping and concurrency"). Browser-safe: Yjs and board schemas
 * only. One Y.Map per object, keyed by id; every field a single atomic `{ value, a, t }` register, so
 * attribution travels inside the update with the value it describes; text is a Y.Text whose inserted
 * ranges carry `author: { a, t }`. Deletion is a remove-wins tombstone in `deleted`; the object's map
 * stays (hidden) so the deleter's own undo can restore its identity.
 */

export const BOARD = "board";
export const OBJECTS = "objects";
export const DELETED = "deleted";
/** Validated raster metadata, hash → `BoardImage`. Only hashes the artifact owns may appear. */
export const ASSETS = "assets";
export const BOARD_SHARES = new Set([BOARD, OBJECTS, DELETED, ASSETS]);
/** Origin of the server's own board transactions (seed, repair, operations). */
export const BOARD_SERVER_ORIGIN = "server";

export type Stamp = { a: string; t: string };
export type Register<T> = { value: T; a: string; t: string };
export type Placement = { pose: BoardPose; parent: string | null; worldPose: BoardPose };
export type BoardKind = BoardObject["kind"];
export type Tombstone = Omit<BoardDeletedObject, "id">;
/** A serialized object before stamping, kind by kind. */
export type BoardObjectInput = BoardObject extends infer O
  ? O extends BoardObject
    ? Omit<O, "attribution">
    : never
  : never;
type Fields = "pose" | "parent" | "order" | "style" | "label" | "data";
export const REGISTERS = ["placement", "order", "style", "label", "data"] as const;
export type RegisterKey = (typeof REGISTERS)[number];

export const TEXT_KINDS = new Set<BoardKind>(["sticky", "text", "shape"]);
export const KINDS = new Set<BoardKind>([
  "sticky",
  "text",
  "shape",
  "image",
  "connector",
  "frame",
  "rendered_frame",
  "stroke",
]);

const AUTHOR = /^a[1-9][0-9]*$/;

/** A stamp at minute precision, so one author's typing in one minute stays one text run. */
export function boardStamp(a: string, at: number = Date.now()): Stamp {
  return { a, t: new Date(Math.floor(at / 60_000) * 60_000).toISOString() };
}

export const objectsMap = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>(OBJECTS);
export const deletedMap = (doc: Y.Doc) => doc.getMap<Tombstone>(DELETED);
export const assetsMap = (doc: Y.Doc) => doc.getMap<BoardImage>(ASSETS);
export const boardMap = (doc: Y.Doc) => doc.getMap<unknown>(BOARD);

// Reading.

/** Kind-specific non-text fields, as the `data` register holds them. */
function dataOf(object: BoardObject): unknown {
  switch (object.kind) {
    case "shape":
      return { shape: object.shape };
    case "image":
      return { asset: object.asset, alt: object.alt };
    case "connector":
    case "rendered_frame":
      return object.data;
    case "stroke":
      return { points: object.points };
    default:
      return null;
  }
}

/** Every active (not tombstoned) object map, by id. */
export function boardObjects(doc: Y.Doc): Map<string, Y.Map<unknown>> {
  const deleted = deletedMap(doc);
  const out = new Map<string, Y.Map<unknown>>();
  for (const [id, map] of objectsMap(doc).entries())
    if (!deleted.has(id) && map instanceof Y.Map) out.set(id, map);
  return out;
}

/** An id is taken if it is active, hidden by a tombstone, or only a tombstone (after a reseed). */
export const boardIdTaken = (doc: Y.Doc, id: string) => objectsMap(doc).has(id) || deletedMap(doc).has(id);

type TextRun = { s: number; e: number; a: string; t: string };

/**
 * A Y.Text's plain text and author runs (UTF-16 offsets), merging equal neighbours. Yjs keeps authors
 * as formatting, and its format cleanup can leave a concurrently merged span with no author at all;
 * such a span takes the author before it (or after it, or `fallback`), deterministically on every
 * replica, so a merge of individually valid updates is never refused. Embeds and malformed or extra
 * attributes are problems.
 */
export function textRuns(
  text: Y.Text,
  fallback: Stamp | null = null,
): { text: string; runs: TextRun[]; problem: string | null } {
  let out = "";
  const segments: { s: number; e: number; who: Stamp | null }[] = [];
  let problem: string | null = null;
  for (const op of text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
    if (typeof op.insert !== "string") {
      problem ??= "an embed in text";
      continue;
    }
    const keys = Object.keys(op.attributes ?? {});
    const author = op.attributes?.author as { a?: unknown; t?: unknown } | undefined;
    let who: Stamp | null = null;
    if (keys.some((key) => key !== "author")) problem ??= "text with formatting other than its author";
    else if (author !== undefined) {
      if (
        !author ||
        typeof author !== "object" ||
        Object.keys(author).length !== 2 ||
        typeof author.a !== "string" ||
        !AUTHOR.test(author.a) ||
        typeof author.t !== "string" ||
        Number.isNaN(Date.parse(author.t))
      )
        problem ??= "a malformed text author";
      else who = { a: author.a, t: author.t };
    }
    const s = out.length;
    out += op.insert;
    if (op.insert.length > 0) segments.push({ s, e: out.length, who });
  }
  const runs: TextRun[] = [];
  for (const [index, segment] of segments.entries()) {
    const who =
      segment.who ??
      [...segments.slice(0, index)].reverse().find((x) => x.who)?.who ??
      segments.slice(index + 1).find((x) => x.who)?.who ??
      fallback;
    if (!who) {
      problem ??= "text without an author";
      continue;
    }
    const last = runs.at(-1);
    if (last && last.a === who.a && last.t === who.t && last.e === segment.s) last.e = segment.e;
    else runs.push({ s: segment.s, e: segment.e, a: who.a, t: who.t });
  }
  return { text: out, runs, problem };
}

const isRegister = (value: unknown): value is Register<unknown> =>
  !!value &&
  typeof value === "object" &&
  Object.keys(value).length === 3 &&
  "value" in value &&
  typeof (value as Register<unknown>).a === "string" &&
  AUTHOR.test((value as Register<unknown>).a) &&
  typeof (value as Register<unknown>).t === "string" &&
  !Number.isNaN(Date.parse((value as Register<unknown>).t));

const stampOf = (r: Register<unknown>): Stamp => ({ a: r.a, t: r.t });

/**
 * One object map as stored, before the referential projection: the registers unwrapped, attribution
 * rebuilt, text runs computed. Returns a reason instead when the map is malformed.
 */
export function readObject(
  id: string,
  map: Y.Map<unknown>,
): { object: BoardObject; worldPose: BoardPose } | { problem: string } {
  const kind = map.get("kind") as BoardKind;
  if (map.get("id") !== id || !BLOCK_ID_PATTERN.test(id)) return { problem: `object ${id}: wrong id` };
  if (!KINDS.has(kind)) return { problem: `object ${id}: unknown kind` };
  const allowed = new Set(["id", "kind", "created", ...REGISTERS, ...(TEXT_KINDS.has(kind) ? ["text"] : [])]);
  for (const key of map.keys())
    if (!allowed.has(key)) return { problem: `object ${id}: unknown field ${key}` };
  for (const key of allowed) if (!map.has(key)) return { problem: `object ${id}: missing ${key}` };
  const created = map.get("created") as Stamp;
  if (
    !created ||
    typeof created !== "object" ||
    Object.keys(created).length !== 2 ||
    typeof created.a !== "string" ||
    !AUTHOR.test(created.a) ||
    typeof created.t !== "string"
  )
    return { problem: `object ${id}: malformed created stamp` };
  const registers = {} as Record<RegisterKey, Register<unknown>>;
  for (const key of REGISTERS) {
    const r = map.get(key);
    if (!isRegister(r)) return { problem: `object ${id}: malformed ${key} register` };
    registers[key] = r;
  }
  const placement = registers.placement.value as Placement;
  if (
    !placement ||
    typeof placement !== "object" ||
    Object.keys(placement).length !== 3 ||
    !("pose" in placement) ||
    !("parent" in placement) ||
    !("worldPose" in placement)
  )
    return { problem: `object ${id}: malformed placement` };
  const fields: Record<Fields, Stamp> = {
    pose: stampOf(registers.placement),
    parent: stampOf(registers.placement),
    order: stampOf(registers.order),
    style: stampOf(registers.style),
    label: stampOf(registers.label),
    data: stampOf(registers.data),
  };
  let text = "";
  let runs: TextRun[] = [];
  if (TEXT_KINDS.has(kind)) {
    const y = map.get("text");
    if (!(y instanceof Y.Text)) return { problem: `object ${id}: text isn't a Y.Text` };
    const read = textRuns(y, { a: created.a, t: created.t });
    if (read.problem) return { problem: `object ${id}: ${read.problem}` };
    text = read.text;
    runs = read.runs;
  }
  const common = {
    id,
    pose: placement.pose,
    parent: placement.parent,
    order: registers.order.value as string,
    label: registers.label.value as string,
    style: registers.style.value as BoardStyle,
    attribution: { created: { a: created.a, t: created.t }, fields, text: runs },
  };
  const data = registers.data.value as Record<string, unknown> | null;
  let object: unknown;
  const kindData = (keys: string[]) =>
    data &&
    typeof data === "object" &&
    Object.keys(data).length === keys.length &&
    keys.every((k) => k in data);
  switch (kind) {
    case "sticky":
    case "text":
      if (data !== null) return { problem: `object ${id}: unexpected data` };
      object = { ...common, kind, text };
      break;
    case "frame":
      if (data !== null) return { problem: `object ${id}: unexpected data` };
      object = { ...common, kind };
      break;
    case "shape":
      if (!kindData(["shape"])) return { problem: `object ${id}: malformed shape data` };
      object = { ...common, kind, shape: data?.shape, text };
      break;
    case "image":
      if (!kindData(["asset", "alt"])) return { problem: `object ${id}: malformed image data` };
      object = { ...common, kind, asset: data?.asset, alt: data?.alt };
      break;
    case "stroke":
      if (!kindData(["points"])) return { problem: `object ${id}: malformed stroke data` };
      object = { ...common, kind, points: data?.points };
      break;
    default:
      object = { ...common, kind, data };
  }
  return { object: object as BoardObject, worldPose: placement.worldPose };
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

type Raw = { object: BoardObject; worldPose: BoardPose };

/**
 * The deterministic referential projection (14, "Z-order and containment", "Connectors and deletion"):
 * an object whose parent is missing, hidden, not a frame, in a cycle (the greatest id of each cycle) or
 * too deep becomes a root object at the board pose frozen in its placement; a connector endpoint bound
 * to a hidden target detaches at that target's tombstoned world pose. Connector poses are derived.
 */
function project(raw: Map<string, Raw>, deleted: Map<string, Tombstone>): Map<string, BoardObject> {
  const out = new Map<string, BoardObject>();
  for (const [id, { object }] of raw) out.set(id, { ...object });
  const detach = (id: string) => {
    const r = raw.get(id) as Raw;
    const o = out.get(id) as BoardObject;
    out.set(id, { ...o, parent: null, pose: r.worldPose });
  };
  const ids = [...out.keys()].sort();
  for (const id of ids) {
    const o = out.get(id) as BoardObject;
    if (o.parent === null) continue;
    const parent = out.get(o.parent);
    if (parent?.kind !== "frame" || o.kind === "connector") detach(id);
  }
  // Cycles: walk each chain; on revisiting a node of this walk, detach the cycle's greatest id.
  for (;;) {
    let changed = false;
    const done = new Set<string>();
    for (const id of ids) {
      if (done.has(id)) continue;
      const path: string[] = [];
      const onPath = new Set<string>();
      let at: string | null = id;
      while (at !== null && !done.has(at)) {
        if (onPath.has(at)) {
          const cycle = path.slice(path.indexOf(at));
          detach(cycle.sort().at(-1) as string);
          changed = true;
          break;
        }
        onPath.add(at);
        path.push(at);
        at = (out.get(at) as BoardObject).parent;
      }
      for (const p of path) done.add(p);
      if (changed) break;
    }
    if (!changed) break;
  }
  // Depth: an object more than BOARD_DEPTH_MAX frames deep becomes a root object.
  const depth = (id: string) => {
    let n = 0;
    let at = (out.get(id) as BoardObject).parent;
    while (at !== null) {
      n++;
      at = (out.get(at) as BoardObject).parent;
    }
    return n;
  };
  for (;;) {
    // The shallowest too-deep object, least id first: detaching it fixes everything beneath it.
    const deep = ids.filter((id) => depth(id) > BOARD_DEPTH_MAX);
    if (deep.length === 0) break;
    detach(deep.reduce((best, id) => (depth(id) < depth(best) ? id : best)));
  }
  const worldOf = worldPoses(out);
  for (const id of ids) {
    const o = out.get(id) as BoardObject;
    if (o.kind !== "connector") continue;
    const fix = (endpoint: BoardEndpoint): BoardEndpoint => {
      if (!endpoint.binding) return endpoint;
      const target = out.get(endpoint.binding.object);
      if (target && target.kind !== "connector") return endpoint;
      const tomb = deleted.get(endpoint.binding.object);
      const point = tomb
        ? poseLocalPoint(tomb.worldPose, endpoint.binding.u, endpoint.binding.v)
        : endpoint.point;
      return { point, binding: null };
    };
    const data = { ...o.data, start: fix(o.data.start), end: fix(o.data.end) };
    const start = endpointPoint(data.start, worldOf);
    const end = endpointPoint(data.end, worldOf);
    out.set(id, { ...o, parent: null, data, pose: connectorPose(start, end) });
  }
  return out;
}

/** World poses of projected objects (ancestor translations added), memoized. */
function worldPoses(objects: Map<string, BoardObject>): (id: string) => BoardPose | null {
  const memo = new Map<string, BoardPose | null>();
  const of = (id: string, guard = 0): BoardPose | null => {
    if (memo.has(id)) return memo.get(id) ?? null;
    const o = objects.get(id);
    if (!o || guard > BOARD_DEPTH_MAX + 2) return null;
    let pose = o.pose;
    if (o.parent !== null) {
      const parent = of(o.parent, guard + 1);
      pose = parent ? translate(o.pose, parent) : o.pose;
    }
    memo.set(id, pose);
    return pose;
  };
  return of;
}

function rawObjects(doc: Y.Doc): { raw: Map<string, Raw>; problems: Map<string, string> } {
  const raw = new Map<string, Raw>();
  const problems = new Map<string, string>();
  for (const [id, map] of boardObjects(doc)) {
    const read = readObject(id, map);
    if ("problem" in read) problems.set(id, read.problem);
    else raw.set(id, read);
  }
  return { raw, problems };
}

const tombstones = (doc: Y.Doc) => {
  const out = new Map<string, Tombstone>();
  for (const [id, t] of deletedMap(doc).entries()) out.set(id, t);
  return out;
};

/** The canonical serialized board: projected objects and tombstones by id, referenced assets by hash. */
export function yToBoard(doc: Y.Doc): BoardSnapshot {
  const meta = boardMap(doc);
  const { raw } = rawObjects(doc);
  const deleted = tombstones(doc);
  const objects = [...project(raw, deleted).values()].sort(byId);
  const used = new Set(objects.flatMap((o) => (o.kind === "image" ? [o.asset] : [])));
  const assets = [...assetsMap(doc).entries()]
    .filter(([hash]) => used.has(hash))
    .map(([, image]) => image)
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return {
    schema: 1,
    page: String(meta.get("page") ?? ""),
    objects,
    deleted: [...deleted].map(([id, t]) => ({ id, ...t })).sort(byId),
    assets,
  };
}

// Writing. Every writer runs inside the caller's transaction (or makes one) and stamps what it changes.

const reg = <T>(value: T, stamp: Stamp): Register<T> => ({ value, a: stamp.a, t: stamp.t });

function textY(text: string, runs: { s: number; e: number; a: string; t: string }[]): Y.Text {
  const y = new Y.Text();
  // A prelim Y.Text applies inserts once integrated; insert in order with each run's author.
  let at = 0;
  for (const run of runs) {
    y.insert(at, text.slice(run.s, run.e), { author: { a: run.a, t: run.t } });
    at += run.e - run.s;
  }
  return y;
}

/** An object's map, from its serialized form, keeping its stamps. `worldPose` freezes its board pose. */
export function objectToY(object: BoardObject, worldPose: BoardPose): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  const f = object.attribution.fields;
  const stamp = (key: Fields): Stamp => f[key] ?? object.attribution.created;
  map.set("id", object.id);
  map.set("kind", object.kind);
  map.set("created", { ...object.attribution.created });
  map.set("placement", reg({ pose: object.pose, parent: object.parent, worldPose }, stamp("pose")));
  map.set("order", reg(object.order, stamp("order")));
  map.set("style", reg(object.style, stamp("style")));
  map.set("label", reg(object.label, stamp("label")));
  map.set("data", reg(dataOf(object), stamp("data")));
  if (TEXT_KINDS.has(object.kind)) {
    const text = (object as { text: string }).text;
    map.set("text", textY(text, object.attribution.text));
  }
  return map;
}

/** A Y.Doc holding a snapshot, stamps and tombstones included (seeding, reseeding, tests). */
export function boardToY(snapshot: BoardSnapshot, doc: Y.Doc = new Y.Doc()): Y.Doc {
  const objects = new Map(snapshot.objects.map((o) => [o.id, o]));
  const world = worldPoses(objects);
  doc.transact(() => {
    const meta = boardMap(doc);
    meta.set("schema", 1);
    meta.set("page", snapshot.page);
    const map = objectsMap(doc);
    for (const object of snapshot.objects)
      map.set(object.id, objectToY(object, world(object.id) ?? object.pose));
    const deleted = deletedMap(doc);
    for (const { id, ...tomb } of snapshot.deleted ?? []) deleted.set(id, tomb);
    const assets = assetsMap(doc);
    for (const image of snapshot.assets) assets.set(image.hash, image);
  }, BOARD_SERVER_ORIGIN);
  return doc;
}

/** An empty schema-1 board for a page. */
export const emptyBoard = (page: string): BoardSnapshot => ({
  schema: 1,
  page,
  objects: [],
  deleted: [],
  assets: [],
});

const objectMap = (doc: Y.Doc, id: string) => {
  const map = boardObjects(doc).get(id);
  if (!map) throw new Error(`no active object ${id}`);
  return map;
};

/** The world offset of a would-be parent (sum of its and its ancestors' x/y), from the projection. */
export function parentOffset(doc: Y.Doc, parent: string | null): { x: number; y: number } {
  if (parent === null) return { x: 0, y: 0 };
  const world = boardWorldPose(yToBoard(doc), parent);
  return world ? { x: world.x, y: world.y } : { x: 0, y: 0 };
}

/**
 * Adds an object (fresh id, never a tombstoned one). Its stamps are those in `object.attribution`; a
 * writer makes them with its own key (`newObject` does). Returns the map.
 */
export function addBoardObject(doc: Y.Doc, object: BoardObject): Y.Map<unknown> {
  if (boardIdTaken(doc, object.id)) throw new Error(`id ${object.id} is taken`);
  let map: Y.Map<unknown> | null = null;
  doc.transact(() => {
    const offset = parentOffset(doc, object.parent);
    map = objectToY(object, translate(object.pose, offset));
    objectsMap(doc).set(object.id, map);
  });
  return map as unknown as Y.Map<unknown>;
}

/** A complete new object stamped entirely by one author (every field and every character). */
export function newObject(object: BoardObjectInput, stamp: Stamp): BoardObject {
  const fields = { pose: stamp, parent: stamp, order: stamp, style: stamp, label: stamp, data: stamp };
  const text = "text" in object && typeof object.text === "string" ? object.text : "";
  return {
    ...object,
    attribution: { created: stamp, fields, text: text.length ? [{ s: 0, e: text.length, ...stamp }] : [] },
  } as BoardObject;
}

export function getRegister<T = unknown>(doc: Y.Doc, id: string, key: RegisterKey): Register<T> | null {
  const map = objectsMap(doc).get(id);
  return map instanceof Y.Map ? ((map.get(key) as Register<T>) ?? null) : null;
}

/** Writes one atomic register with a stamp. */
export function setRegister(doc: Y.Doc, id: string, key: RegisterKey, value: unknown, stamp: Stamp) {
  doc.transact(() => objectMap(doc, id).set(key, reg(value, stamp)));
}

/**
 * Moves/reparents in one atomic placement register: pose in the new parent's basis, with the board pose
 * it means frozen beside it for deterministic repair.
 */
export function setPlacement(
  doc: Y.Doc,
  id: string,
  place: { pose: BoardPose; parent: string | null },
  stamp: Stamp,
) {
  doc.transact(() => {
    const worldPose = translate(place.pose, parentOffset(doc, place.parent));
    objectMap(doc, id).set("placement", reg({ pose: place.pose, parent: place.parent, worldPose }, stamp));
  });
}

/** Moves an object into another parent (or root), preserving its board geometry. */
export function reparentPreserving(doc: Y.Doc, id: string, parent: string | null, stamp: Stamp) {
  const snapshot = yToBoard(doc);
  const world = boardWorldPose(snapshot, id);
  if (!world) throw new Error(`no active object ${id}`);
  const offset = parent === null ? { x: 0, y: 0 } : (boardWorldPose(snapshot, parent) ?? { x: 0, y: 0 });
  setPlacement(
    doc,
    id,
    { pose: { ...world, x: clean(world.x - offset.x), y: clean(world.y - offset.y) }, parent },
    stamp,
  );
}

export function boardTextOf(doc: Y.Doc, id: string): Y.Text | null {
  const text = objectsMap(doc).get(id)?.get("text");
  return text instanceof Y.Text ? text : null;
}

/** Inserts text with one author's stamp. */
export function insertBoardText(doc: Y.Doc, id: string, index: number, value: string, stamp: Stamp) {
  const text = boardTextOf(doc, id);
  if (!text) throw new Error(`object ${id} has no text`);
  if (value) text.insert(index, value, { author: { a: stamp.a, t: stamp.t } });
}

/**
 * Replaces an object's text by a character diff (common prefix and suffix kept) on the same Y.Text, so
 * a concurrent person's insertions elsewhere survive an agent's `update.text`.
 */
export function setBoardText(doc: Y.Doc, id: string, next: string, stamp: Stamp) {
  const text = boardTextOf(doc, id);
  if (!text) throw new Error(`object ${id} has no text`);
  const current = text.toString();
  if (current === next) return;
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) start++;
  // Never split a surrogate pair.
  if (start > 0 && /[\uD800-\uDBFF]/.test(current[start - 1] as string)) start--;
  let end = 0;
  while (
    end < current.length - start &&
    end < next.length - start &&
    current[current.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  if (end > 0 && /[\uDC00-\uDFFF]/.test(current[current.length - end] as string)) end--;
  doc.transact(() => {
    const removed = current.length - start - end;
    if (removed > 0) text.delete(start, removed);
    const inserted = next.slice(start, next.length - end);
    if (inserted) text.insert(start, inserted, { author: { a: stamp.a, t: stamp.t } });
  });
}

/** What deleting `id` also changes: a frame's direct children (ungrouped) and connectors bound to it. */
export function deleteEffects(doc: Y.Doc, id: string): { children: string[]; connectors: string[] } {
  const snapshot = yToBoard(doc);
  const target = snapshot.objects.find((o) => o.id === id);
  if (!target) return { children: [], connectors: [] };
  const children = snapshot.objects.filter((o) => o.parent === id).map((o) => o.id);
  const connectors = snapshot.objects
    .filter(
      (o) =>
        o.kind === "connector" && (o.data.start.binding?.object === id || o.data.end.binding?.object === id),
    )
    .map((o) => o.id);
  return { children, connectors };
}

/**
 * Deletes an object (14, "Connectors and deletion"): a frame's children move to its parent keeping
 * board geometry (deleting a frame never deletes a person's children), connectors bound to it detach at
 * its current world position, and a tombstone records its last pose, parent, world pose and rendered
 * source. One transaction; all stamped by the deleter.
 */
export function deleteBoardObject(doc: Y.Doc, id: string, stamp: Stamp) {
  doc.transact(() => {
    const snapshot = yToBoard(doc);
    const target = snapshot.objects.find((o) => o.id === id);
    if (!target) throw new Error(`no active object ${id}`);
    const world = boardWorldPose(snapshot, id) as BoardPose;
    const { children, connectors } = deleteEffects(doc, id);
    for (const child of children) reparentPreserving(doc, child, target.parent, stamp);
    for (const cid of connectors) {
      const c = snapshot.objects.find((o) => o.id === cid);
      if (c?.kind !== "connector") continue;
      const fix = (e: BoardEndpoint): BoardEndpoint =>
        e.binding?.object === id
          ? { point: poseLocalPoint(world, e.binding.u, e.binding.v), binding: null }
          : e;
      setRegister(doc, cid, "data", { ...c.data, start: fix(c.data.start), end: fix(c.data.end) }, stamp);
    }
    const tomb: Tombstone = {
      a: stamp.a,
      t: stamp.t,
      pose: target.pose,
      parent: target.parent,
      worldPose: world,
    };
    if (target.kind === "rendered_frame") tomb.source = target.data.source;
    deletedMap(doc).set(id, tomb);
  });
}

/** Clears a tombstone: the deleter's own undo. The object's map is still there, hidden. */
export function restoreBoardObject(doc: Y.Doc, id: string) {
  if (!objectsMap(doc).has(id)) throw new Error(`object ${id} can't be restored here`);
  deletedMap(doc).delete(id);
}

export function addBoardAsset(doc: Y.Doc, image: BoardImage) {
  if (!assetsMap(doc).has(image.hash)) assetsMap(doc).set(image.hash, image);
}

// Snapshot helpers (pure JSON).

/** An object's board pose: its pose plus every ancestor frame's x/y. Connectors are already world. */
export function boardWorldPose(snapshot: BoardSnapshot, id: string): BoardPose | null {
  return worldPoses(new Map(snapshot.objects.map((o) => [o.id, o])))(id);
}

/** An endpoint's visible point: its target's transformed `(u, v)`, the tombstone fallback, or `point`. */
export function boardEndpoint(snapshot: BoardSnapshot, endpoint: BoardEndpoint): { x: number; y: number } {
  if (!endpoint.binding) return endpoint.point;
  const world = boardWorldPose(snapshot, endpoint.binding.object);
  if (world) return poseLocalPoint(world, endpoint.binding.u, endpoint.binding.v);
  const tomb = snapshot.deleted.find((d) => d.id === endpoint.binding?.object);
  return tomb ? poseLocalPoint(tomb.worldPose, endpoint.binding.u, endpoint.binding.v) : endpoint.point;
}

/** Objects in outline order: the parent tree depth-first, siblings by `(order, id)`. */
export function boardOutline(snapshot: BoardSnapshot): BoardObject[] {
  const children = new Map<string | null, BoardObject[]>();
  for (const o of snapshot.objects) {
    const list = children.get(o.parent) ?? [];
    list.push(o);
    children.set(o.parent, list);
  }
  for (const list of children.values()) list.sort(compareSiblings);
  const out: BoardObject[] = [];
  const walk = (parent: string | null) => {
    for (const o of children.get(parent) ?? []) {
      out.push(o);
      walk(o.id);
    }
  };
  walk(null);
  return out;
}

/** Sticky, text and shape text in outline order, blank-line separated (search and the outline). */
export function boardText(snapshot: BoardSnapshot): string {
  return boardOutline(snapshot)
    .flatMap((o) => ("text" in o && typeof o.text === "string" && o.text.trim() ? [o.text] : []))
    .join("\n\n");
}

/** Siblings under a parent, in draw order. */
export function boardSiblings(snapshot: BoardSnapshot, parent: string | null): BoardObject[] {
  return snapshot.objects.filter((o) => o.parent === parent).sort(compareSiblings);
}

/**
 * The one canonicalizer for board hashes (14, "Objects and stable ids"), shared by server, model and
 * tests: object keys sorted by code point, arrays in order, strings as they are, finite numbers in JSON
 * form with negative zero as zero. Undefined fields are left out, as JSON.stringify does.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "number":
      if (!Number.isFinite(value)) throw new Error("a board number must be finite");
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJSON(item ?? null)).join(",")}]`;
      const keys = Object.keys(value as object)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`).join(",")}}`;
    }
    default:
      throw new Error(`can't canonicalize a ${typeof value}`);
  }
}

// Validation and repair.

export type BoardValidation = { ok: true } | { ok: false; reason: string };

/**
 * Whether a board document is one the server can keep (14, "Fixed package interfaces"): known shared
 * types only, immutable meta, exact known fields, well-formed registers and authored text, canonical
 * order keys, finite in-world rotated bounds, zero-angle frames, root connectors bound only to
 * non-connectors this board knows, parents that are frames, owned assets, unique rendered sources and
 * the size limits. `touched` limits the per-object checks; the graph and limits are always checked.
 * Concurrent graph conflicts (cycles, hidden parents/targets, depth) are left to the projection.
 */
export function validateBoard(
  doc: Y.Doc,
  opts: { assets: Set<string>; author?: string; touched?: Set<string> },
): BoardValidation {
  const fail = (reason: string): BoardValidation => ({ ok: false, reason });
  for (const name of doc.share.keys())
    if (!BOARD_SHARES.has(name)) return fail(`unknown shared type ${name}`);
  const meta = boardMap(doc);
  if (meta.get("schema") !== 1) return fail("board schema isn't 1");
  const page = meta.get("page");
  if (typeof page !== "string" || !KEY_PATTERN.test(page)) return fail("board page is malformed");
  for (const key of meta.keys())
    if (key !== "schema" && key !== "page") return fail(`unknown board field ${key}`);
  const all = objectsMap(doc);
  const deleted = deletedMap(doc);
  for (const [id, value] of all.entries())
    if (!(value instanceof Y.Map)) return fail(`object ${id} isn't a map`);
  const { raw, problems } = rawObjects(doc);
  // An untouched object can only look malformed mid-delivery (a causal gap); it was valid when accepted.
  for (const [id, problem] of problems) if (!opts.touched || opts.touched.has(id)) return fail(problem);
  if (raw.size > BOARD_OBJECTS_MAX) return fail("too many objects");
  // A touched hidden object is checked too, so restoring it can never expose a malformed map.
  for (const id of opts.touched ?? []) {
    const map = all.get(id);
    if (!(map instanceof Y.Map) || !deleted.has(id)) continue;
    const read = readObject(id, map);
    if ("problem" in read) return fail(read.problem);
    const parsed = BoardObjectSchema.safeParse(read.object);
    if (!parsed.success) return fail(`object ${id}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  for (const [id, tomb] of deleted.entries()) {
    if (opts.touched && !opts.touched.has(id)) continue;
    if (!BoardDeletedSchema.safeParse({ id, ...(tomb as object) }).success)
      return fail(`tombstone ${id} is malformed`);
  }
  const assets = assetsMap(doc);
  if (assets.size > BOARD_ASSETS_MAX) return fail("too many images");
  for (const [hash, image] of assets.entries()) {
    if (!opts.assets.has(hash)) return fail("an image this board doesn't own");
    const parsed = BoardImageSchema.safeParse(image);
    if (!parsed.success || parsed.data.hash !== hash) return fail("malformed image metadata");
  }
  const known = (id: string) => all.has(id) || deleted.has(id);
  const sources = new Set<string>();
  for (const tomb of deleted.values())
    if (tomb?.source) {
      const key = `${tomb.source.page}\u0000${tomb.source.frame}`;
      if (sources.has(key)) return fail(`rendered frame ${tomb.source.frame} appears twice`);
      sources.add(key);
    }
  for (const [id, { object, worldPose }] of raw) {
    if (object.kind === "rendered_frame") {
      const key = `${object.data.source.page}\u0000${object.data.source.frame}`;
      if (sources.has(key)) return fail(`rendered frame ${object.data.source.frame} appears twice`);
      sources.add(key);
    }
    // References this writer just made must be known; untouched ones out of causal order are projected.
    const mine = !opts.touched || opts.touched.has(id);
    if (object.parent !== null) {
      if (!known(object.parent) && mine) return fail(`object ${id}: parent doesn't exist`);
      const parent = raw.get(object.parent);
      if (parent && parent.object.kind !== "frame") return fail(`object ${id}: parent isn't a frame`);
      if (object.parent === id) return fail(`object ${id} is its own parent`);
    }
    if (object.kind === "connector") {
      for (const end of [object.data.start, object.data.end]) {
        if (!end.binding) continue;
        if (!known(end.binding.object) && mine) return fail(`connector ${id}: bound to an unknown object`);
        const target = all.get(end.binding.object);
        if (target instanceof Y.Map && target.get("kind") === "connector")
          return fail(`connector ${id}: bound to a connector`);
      }
    }
    if (opts.touched && !opts.touched.has(id)) continue;
    const parsed = BoardObjectSchema.safeParse(object);
    if (!parsed.success) return fail(`object ${id}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    if (!isOrderKey(object.order)) return fail(`object ${id}: order key isn't canonical`);
    if (!poseInWorld(object.pose) || !poseInWorld(worldPose)) return fail(`object ${id}: outside the board`);
    if ((object.kind === "frame" || object.kind === "connector") && object.pose.angle !== 0)
      return fail(`object ${id}: a ${object.kind} can't rotate`);
    if (object.kind === "connector" && object.parent !== null) return fail(`connector ${id} isn't at root`);
    if (object.kind === "image" && (!assets.has(object.asset) || !opts.assets.has(object.asset)))
      return fail(`image ${id}: an image this board doesn't own`);
    const runs = object.attribution.text;
    if ("text" in object && runs.reduce((n, r) => n + r.e - r.s, 0) !== object.text.length)
      return fail(`object ${id}: text without an author`);
  }
  const snapshot = yToBoard(doc);
  const world = worldPoses(new Map(snapshot.objects.map((o) => [o.id, o])));
  for (const o of snapshot.objects) {
    if (opts.touched && !opts.touched.has(o.id) && o.parent === null) continue;
    const pose = world(o.id);
    if (!pose || !poseInWorld(pose)) return fail(`object ${o.id}: outside the board`);
  }
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > BOARD_JSON_MAX)
    return fail("the board is too large");
  return { ok: true };
}

/**
 * Persists the projection (14, "Z-order and containment"): detached children become root objects at
 * their frozen board pose, connectors bound to hidden or invalid targets detach at the tombstone's
 * position. Server-origin, keeping each register's existing stamp. Returns the update, or null.
 */
export function repairBoard(doc: Y.Doc): Uint8Array | null {
  const before = Y.encodeStateVector(doc);
  const { raw } = rawObjects(doc);
  const projected = project(raw, tombstones(doc));
  let changed = false;
  doc.transact(() => {
    for (const [id, { object, worldPose }] of raw) {
      const p = projected.get(id) as BoardObject;
      const map = objectsMap(doc).get(id) as Y.Map<unknown>;
      if (object.kind !== "connector" && p.parent !== object.parent) {
        const r = map.get("placement") as Register<Placement>;
        map.set("placement", { value: { pose: worldPose, parent: null, worldPose }, a: r.a, t: r.t });
        changed = true;
      }
      if (object.kind === "connector" && p.kind === "connector") {
        const unbound =
          (object.data.start.binding !== null && p.data.start.binding === null) ||
          (object.data.end.binding !== null && p.data.end.binding === null);
        if (unbound) {
          const r = map.get("data") as Register<unknown>;
          map.set("data", { value: p.data, a: r.a, t: r.t });
          changed = true;
        }
        if (object.parent !== null) {
          const r = map.get("placement") as Register<Placement>;
          map.set("placement", { value: { ...r.value, parent: null }, a: r.a, t: r.t });
          changed = true;
        }
      }
    }
  }, BOARD_SERVER_ORIGIN);
  return changed ? Y.encodeStateAsUpdate(doc, before) : null;
}

/**
 * Drops the hidden maps of deleted objects (14, "Yjs mapping"), keeping their tombstones. The server
 * does this at a checkpoint, so a deleted object's text (a pasted secret, say) leaves the draft's
 * snapshot and log once a version records the deletion. An undo of that deletion can't restore it
 * afterwards. Server-origin. Returns the update, or null when nothing was hidden.
 */
export function purgeDeleted(doc: Y.Doc): Uint8Array | null {
  const before = Y.encodeStateVector(doc);
  const objects = objectsMap(doc);
  const hidden = [...deletedMap(doc).keys()].filter((id) => objects.has(id));
  if (hidden.length === 0) return null;
  doc.transact(() => {
    for (const id of hidden) objects.delete(id);
  }, BOARD_SERVER_ORIGIN);
  return Y.encodeStateAsUpdate(doc, before);
}

/** A sibling key this long is close enough to `BOARD_ORDER_MAX` that its group gets fresh keys. */
export const ORDER_REBALANCE_AT = BOARD_ORDER_MAX - 8;

/**
 * Rebalances each sibling group holding an exhausted order key (14, "Z-order and containment"): fresh
 * evenly spaced keys in the group's current `(order, id)` order, each order register keeping its stamp.
 * Only the server does this, as its own update. Returns the update, or null when no key is that long.
 */
export function rebalanceBoard(doc: Y.Doc, at = ORDER_REBALANCE_AT): Uint8Array | null {
  const groups = new Map<string | null, { id: string; order: string }[]>();
  for (const o of yToBoard(doc).objects) groups.set(o.parent, [...(groups.get(o.parent) ?? []), o]);
  const exhausted = [...groups.values()].filter((group) => group.some((o) => o.order.length > at));
  if (exhausted.length === 0) return null;
  const before = Y.encodeStateVector(doc);
  const objects = objectsMap(doc);
  doc.transact(() => {
    for (const group of exhausted)
      for (const [id, key] of rebalanceOrders(group)) {
        const map = objects.get(id) as Y.Map<unknown>;
        const r = map.get("order") as Register<string>;
        if (r.value !== key) map.set("order", { value: key, a: r.a, t: r.t });
      }
  }, BOARD_SERVER_ORIGIN);
  return Y.encodeStateAsUpdate(doc, before);
}

/** Characters per author key over every active and hidden object's text (the server's high-water). */
export function boardAuthorCounts(doc: Y.Doc): Map<string, number> {
  const counts = new Map<string, number>();
  for (const map of objectsMap(doc).values()) {
    const text = map instanceof Y.Map ? map.get("text") : null;
    if (!(text instanceof Y.Text)) continue;
    for (const op of text.toDelta() as { insert: unknown; attributes?: { author?: { a?: string } } }[]) {
      const a = op.attributes?.author?.a;
      if (a && typeof op.insert === "string") counts.set(a, (counts.get(a) ?? 0) + op.insert.length);
    }
  }
  return counts;
}
