import { z } from "zod";
import { WikiAudience } from "./api.ts";
import {
  AGENT_MAX,
  BLOCK_ID_PATTERN,
  BOARD_ASSET_MAX,
  BOARD_ASSET_PIXELS_MAX,
  BOARD_ASSETS_MAX,
  BOARD_COORD_MAX,
  BOARD_DIMENSION_MAX,
  BOARD_JSON_MAX,
  BOARD_LABEL_MAX,
  BOARD_OBJECT_JSON_MAX,
  BOARD_OBJECTS_MAX,
  BOARD_OPS_MAX,
  BOARD_ORDER_MAX,
  BOARD_STROKE_POINTS_MAX,
  BOARD_TEXT_MAX,
  KEY_PATTERN,
  SLUG_PATTERN,
  SUGGESTION_NOTE_MAX,
  WIKI_SOURCES_MAX,
} from "./constants.ts";
import { AgentPolicy, Author, Checkpoint, EditMode, Run, SuggestionStatus } from "./editing.ts";
import { Summary, Tags } from "./manifest.ts";

/** Phase 3 contract: docs/implementation/14-boards.md. JSON boundaries, never whole-scene writes. */
const Id = z.uuid();
const Time = z.iso.datetime({ offset: true });
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Key = z.string().regex(KEY_PATTERN);
const Coordinate = z.number().finite().min(-BOARD_COORD_MAX).max(BOARD_COORD_MAX);
const Unit = z.number().finite().min(0).max(1);
const Label = z.string().max(BOARD_LABEL_MAX);
const Sources = z.array(z.string().regex(SLUG_PATTERN)).max(WIKI_SOURCES_MAX);

/** Same namespace and crypto generator as Phase 2 block ids; unique within an artifact. */
export const BoardObjectId = z.string().regex(BLOCK_ID_PATTERN);
export type BoardObjectId = z.infer<typeof BoardObjectId>;
export const BoardBase = z.string().regex(/^[0-9a-f]{12}$/);
/** A batch-local name declared by an earlier add/connect/group, or a lasting id. */
export const BoardObjectRef = z.union([BoardObjectId, z.string().regex(/^\$[a-z][a-z0-9_]{0,31}$/)]);
export const BoardOrder = z
  .string()
  .min(1)
  .max(BOARD_ORDER_MAX)
  .regex(/^[0-9A-Za-z]+$/);
export const BoardPoint = z.strictObject({ x: Coordinate, y: Coordinate });
export const BoardPose = z.strictObject({
  x: Coordinate,
  y: Coordinate,
  w: z.number().finite().min(1).max(BOARD_DIMENSION_MAX),
  h: z.number().finite().min(1).max(BOARD_DIMENSION_MAX),
  /** Radians, clockwise around the object's centre. Containers and connectors have angle 0. */
  angle: z.number().finite().min(-Math.PI).max(Math.PI),
});
export type BoardPose = z.infer<typeof BoardPose>;

export const BoardStyle = z.strictObject({
  fill: z.union([z.literal("transparent"), z.string().regex(/^#[0-9a-f]{6}$/)]),
  stroke: z.string().regex(/^#[0-9a-f]{6}$/),
  strokeWidth: z.number().finite().min(0).max(16),
  opacity: Unit,
  fontSize: z.number().finite().min(8).max(144),
  align: z.enum(["left", "center", "right"]),
});
export type BoardStyle = z.infer<typeof BoardStyle>;

/** UTF-16 offsets, as Y.Text uses. Text itself is plain; author keys resolve through edit_authors. */
export const BoardTextRun = z
  .strictObject({
    s: z.number().int().nonnegative(),
    e: z.number().int().positive(),
    a: z.string().regex(/^a[1-9][0-9]*$/),
    t: Time,
  })
  .refine((run) => run.e > run.s, "an author run must have positive length");
export const BoardStamp = z.strictObject({ a: z.string().regex(/^a[1-9][0-9]*$/), t: Time });
/** A mutation and its attribution occupy one Y.Map value, so concurrent winners agree. */
export const BoardAttribution = z.strictObject({
  created: BoardStamp,
  fields: z.record(z.enum(["pose", "parent", "order", "style", "label", "data"]), BoardStamp),
  text: z.array(BoardTextRun).max(BOARD_TEXT_MAX),
});
export type BoardAttribution = z.infer<typeof BoardAttribution>;

export const BoardImage = z
  .strictObject({
    hash: Hash,
    type: z.enum(["image/png", "image/jpeg", "image/webp"]),
    bytes: z.number().int().positive().max(BOARD_ASSET_MAX),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
  })
  .refine((image) => image.width * image.height <= BOARD_ASSET_PIXELS_MAX, "too many decoded pixels");
export type BoardImage = z.infer<typeof BoardImage>;

const Binding = z.strictObject({ object: BoardObjectId, u: Unit, v: Unit });
export const BoardEndpoint = z.strictObject({
  /** Absolute board coordinates, used when unbound and retained as the delete fallback. */
  point: BoardPoint,
  binding: Binding.nullable(),
});
const InputEndpoint = z.strictObject({
  point: BoardPoint,
  binding: z.strictObject({ object: BoardObjectRef, u: Unit, v: Unit }).nullable(),
});
export const BoardConnectorData = z.strictObject({
  start: BoardEndpoint,
  end: BoardEndpoint,
  route: z.enum(["straight", "elbow"]),
  startArrow: z.boolean(),
  endArrow: z.boolean(),
});
export type BoardEndpoint = z.infer<typeof BoardEndpoint>;
export const BoardStrokePoint = z.strictObject({ u: Unit, v: Unit, pressure: Unit });
export const BoardFrameSource = z.strictObject({ page: Key, board: Key, frame: z.string().min(1).max(200) });
export const BoardRenderedData = z.strictObject({
  source: BoardFrameSource,
  version: z.number().int().positive(),
  /** Existing CLI @1x pixel hash; do not replace with the board object's base. */
  contentHash: Hash,
  renders: z.strictObject({ "1x": Hash, "2x": Hash, "3x": Hash, thumb: Hash }),
  intrinsic: z.strictObject({ w: z.number().positive(), h: z.number().positive() }),
  /** Bundle-relative content-host path, never loaded in the viewer origin. */
  livePath: z.string().max(1000).nullable(),
  missing: z.boolean(),
});

const common = {
  id: BoardObjectId,
  pose: BoardPose,
  parent: BoardObjectId.nullable(),
  order: BoardOrder,
  label: Label,
  style: BoardStyle,
  attribution: BoardAttribution,
};
const text = z.string().max(BOARD_TEXT_MAX);
export const BoardObject = z
  .discriminatedUnion("kind", [
    z.strictObject({ ...common, kind: z.literal("sticky"), text }),
    z.strictObject({ ...common, kind: z.literal("text"), text }),
    z.strictObject({
      ...common,
      kind: z.literal("shape"),
      shape: z.enum(["rect", "ellipse", "diamond", "line"]),
      text,
    }),
    z.strictObject({ ...common, kind: z.literal("image"), asset: Hash, alt: Label }),
    z.strictObject({ ...common, kind: z.literal("connector"), data: BoardConnectorData }),
    z.strictObject({ ...common, kind: z.literal("frame") }),
    z.strictObject({ ...common, kind: z.literal("rendered_frame"), data: BoardRenderedData }),
    z.strictObject({
      ...common,
      kind: z.literal("stroke"),
      points: z.array(BoardStrokePoint).min(2).max(BOARD_STROKE_POINTS_MAX),
    }),
  ])
  .refine(
    (object) => new TextEncoder().encode(JSON.stringify(object)).byteLength <= BOARD_OBJECT_JSON_MAX,
    "an object is at most 256 KiB of JSON",
  );
export type BoardObject = z.infer<typeof BoardObject>;

/** Remove-wins markers also survive a checkpoint/reseed, preserving deleted rendered identities. */
export const BoardDeletedObject = z.strictObject({
  id: BoardObjectId,
  a: z.string().regex(/^a[1-9][0-9]*$/),
  t: Time,
  pose: BoardPose,
  parent: BoardObjectId.nullable(),
  worldPose: BoardPose,
  source: BoardFrameSource.optional(),
});
export type BoardDeletedObject = z.infer<typeof BoardDeletedObject>;

/** Canonical object/asset ordering and graph checks are the board model package's responsibility. */
export const BoardSnapshot = z
  .strictObject({
    schema: z.literal(1),
    page: Key,
    objects: z.array(BoardObject).max(BOARD_OBJECTS_MAX),
    deleted: z.array(BoardDeletedObject).default([]),
    assets: z.array(BoardImage).max(BOARD_ASSETS_MAX),
  })
  .refine(
    (snapshot) => new TextEncoder().encode(JSON.stringify(snapshot)).byteLength <= BOARD_JSON_MAX,
    "a board snapshot is at most 4 MiB of JSON",
  );
export type BoardSnapshot = z.infer<typeof BoardSnapshot>;

/** Input omits ids, fractional order and authorship: the server supplies all three. */
const create = { pose: BoardPose, parent: BoardObjectRef.nullable(), label: Label, style: BoardStyle };
export const BoardCreateObject = z.discriminatedUnion("kind", [
  z.strictObject({ ...create, kind: z.literal("sticky"), text }),
  z.strictObject({ ...create, kind: z.literal("text"), text }),
  z.strictObject({
    ...create,
    kind: z.literal("shape"),
    shape: z.enum(["rect", "ellipse", "diamond", "line"]),
    text,
  }),
  z.strictObject({ ...create, kind: z.literal("image"), asset: Hash, alt: Label }),
  z.strictObject({ ...create, kind: z.literal("frame") }),
  z.strictObject({
    ...create,
    kind: z.literal("stroke"),
    points: z.array(BoardStrokePoint).min(2).max(BOARD_STROKE_POINTS_MAX),
  }),
]);
export type BoardCreateObject = z.infer<typeof BoardCreateObject>;

const RefName = z.string().regex(/^\$[a-z][a-z0-9_]{0,31}$/);
const Patch = z
  .strictObject({
    label: Label.optional(),
    style: BoardStyle.partial()
      .refine((style) => Object.keys(style).length > 0, "style needs a field")
      .optional(),
    text: text.optional(),
    shape: z.enum(["rect", "ellipse", "diamond", "line"]).optional(),
    asset: Hash.optional(),
    alt: Label.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, "an update needs a field");
export const BoardOp = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), ref: RefName, object: BoardCreateObject }),
  z.strictObject({ op: z.literal("move"), object: BoardObjectRef, pose: BoardPose }),
  z.strictObject({ op: z.literal("update"), object: BoardObjectRef, patch: Patch }),
  z.strictObject({
    op: z.literal("connect"),
    ref: RefName,
    label: Label,
    style: BoardStyle,
    start: InputEndpoint,
    end: InputEndpoint,
    route: z.enum(["straight", "elbow"]),
    startArrow: z.boolean(),
    endArrow: z.boolean(),
  }),
  z.strictObject({
    op: z.literal("bind"),
    object: BoardObjectRef,
    start: InputEndpoint,
    end: InputEndpoint,
    route: z.enum(["straight", "elbow"]),
    startArrow: z.boolean(),
    endArrow: z.boolean(),
  }),
  z.strictObject({
    op: z.literal("group"),
    ref: RefName,
    objects: z.array(BoardObjectRef).min(1).max(BOARD_OBJECTS_MAX),
    label: Label,
  }),
  z.strictObject({ op: z.literal("ungroup"), object: BoardObjectRef }),
  z.strictObject({ op: z.literal("delete"), object: BoardObjectRef }),
  z.strictObject({ op: z.literal("reorder"), object: BoardObjectRef, before: BoardObjectRef.nullable() }),
  z.strictObject({
    op: z.literal("place_frame"),
    /** Required only when placing a published source with no canonical object yet. */
    ref: RefName.optional(),
    source: BoardFrameSource,
    near: z.union([z.strictObject({ object: BoardObjectRef }), z.strictObject({ region: BoardPose })]),
    side: z.enum(["right", "below", "left", "above"]),
    gap: z.number().finite().min(16).max(2000).default(80),
  }),
  z
    .strictObject({
      op: z.literal("meta"),
      title: z.string().trim().min(1).max(120).optional(),
      summary: Summary.optional(),
      tags: Tags.optional(),
      sources: Sources.optional(),
    })
    .refine((op) => Object.keys(op).length > 1, "metadata needs a field"),
]);
export type BoardOp = z.infer<typeof BoardOp>;
export const BoardEditRequest = z.strictObject({
  epoch: z.number().int().positive(),
  /** Idempotency key, scoped to artifact + caller + epoch; same key with different body is a conflict. */
  requestId: Id,
  /** Every existing explicit target and containment mutation target, from board_read. */
  bases: z.record(BoardObjectId, BoardBase),
  ops: z.array(BoardOp).min(1).max(BOARD_OPS_MAX),
  suggest: z.boolean().optional(),
  sources: Sources.optional(),
  note: z.string().trim().max(SUGGESTION_NOTE_MAX).optional(),
  fixes: z.array(z.number().int().positive()).max(50).optional(),
  run: Id.optional(),
  checkpoint: z.boolean().optional(),
  agent: z.string().max(AGENT_MAX).nullable().optional(),
});
export type BoardEditRequest = z.infer<typeof BoardEditRequest>;
export const BoardEditResult = z.strictObject({
  outcome: z.enum(["applied", "suggested", "refused"]),
  reason: z
    .enum([
      "held",
      "pair",
      "audience",
      "run",
      "stale",
      "missing",
      "writing",
      "invalid",
      "limit",
      "no_edit",
      "placement_full",
    ])
    .nullable(),
  message: z.string().nullable(),
  seq: z.number().int().nonnegative(),
  version: z.number().int().positive().nullable(),
  suggestion: Id.nullable(),
  /** Reserved on suggestion as well as apply. Empty on refusal. */
  ids: z.record(RefName, BoardObjectId),
  results: z.array(
    z.strictObject({ index: z.number().int().nonnegative(), objects: z.array(BoardObjectId) }),
  ),
  agents: AgentPolicy,
});
export type BoardEditResult = z.infer<typeof BoardEditResult>;

/** One atomic batch becomes one suggestion; references between ghost objects remain valid. */
export const BoardSuggestion = z.strictObject({
  id: Id,
  epoch: z.number().int().positive(),
  request: BoardEditRequest,
  ids: z.record(RefName, BoardObjectId),
  status: SuggestionStatus,
  author: Author,
  note: z.string().nullable(),
  sources: z.array(z.string()),
  run: Id.nullable(),
  createdAt: Time,
  expiresAt: Time,
  decidedAt: Time.nullable(),
  decidedBy: z.string().nullable(),
});
export type BoardSuggestion = z.infer<typeof BoardSuggestion>;
export const BoardPresence = z.strictObject({
  kind: z.enum(["person", "agent"]),
  name: z.string(),
  for: z.string().nullable(),
  mode: EditMode.nullable(),
  objects: z.array(BoardObjectId).max(50),
  run: Id.nullable(),
});
export const BoardState = z.strictObject({
  editable: z.boolean(),
  reason: z.enum(["not_wiki", "not_canvas", "has_backend", "archived"]).nullable(),
  canEdit: z.boolean(),
  canAccept: z.boolean(),
  canMaintain: z.boolean(),
  version: z.number().int().nonnegative(),
  dirty: z.boolean(),
  seq: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  updatedAt: Time.nullable(),
  agentMaintained: z.boolean(),
  agents: AgentPolicy.nullable(),
  audience: WikiAudience.nullable(),
  present: z.array(BoardPresence),
  openSuggestions: z.number().int().nonnegative(),
  runs: z.array(Run),
});
export type BoardState = z.infer<typeof BoardState>;
export const BoardAvailableFrame = z.strictObject({
  source: BoardFrameSource,
  object: BoardObjectId.nullable(),
  base: BoardBase.nullable(),
  contentHash: Hash,
  intrinsic: z.strictObject({ w: z.number().positive(), h: z.number().positive() }),
  placement: z.enum(["placed", "suggested", "unplaced", "deleted"]),
});
export const BoardRead = z.strictObject({
  artifact: z.string(),
  page: Key,
  title: z.string(),
  summary: z.string().nullable(),
  tags: z.array(z.string()),
  sources: z.array(z.string()),
  version: z.number().int().positive(),
  draft: z.boolean(),
  epoch: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  hash: Hash,
  agents: AgentPolicy,
  objects: z.array(
    z.strictObject({ object: BoardObject, base: BoardBase, threads: z.array(z.number().int().positive()) }),
  ),
  assets: z.array(BoardImage),
  frames: z.array(BoardAvailableFrame).max(BOARD_OBJECTS_MAX),
  authors: z.array(Author),
  suggestions: z.array(BoardSuggestion),
  nextCursor: z.string().nullable(),
});
export type BoardRead = z.infer<typeof BoardRead>;

/** Add to the shared Anchor union during implementation, without changing existing frame anchors. */
export const BoardObjectAnchor = z.strictObject({
  type: z.literal("object"),
  object: BoardObjectId,
  u: Unit,
  v: Unit,
  checkpoint: z.number().int().positive(),
});
export type BoardObjectAnchor = z.infer<typeof BoardObjectAnchor>;
export const BoardThumbnail = BoardImage.refine(
  (image) =>
    image.type !== "image/jpeg" &&
    image.bytes <= 2 * 1024 * 1024 &&
    image.width === 1200 &&
    image.height === 630,
  "a thumbnail is a 1200 by 630 PNG/WebP, at most 2 MiB",
);
export const BoardCropImage = BoardImage.refine(
  (image) =>
    image.type !== "image/jpeg" &&
    image.bytes <= 2 * 1024 * 1024 &&
    image.width === 480 &&
    image.height === 320,
  "a crop is a 480 by 320 PNG/WebP, at most 2 MiB",
);
export const BoardCrop = z.strictObject({ thread: z.number().int().positive(), image: BoardCropImage });
export const BoardRenders = z
  .strictObject({ thumbnail: BoardThumbnail, crops: z.array(BoardCrop).max(500) })
  .superRefine((renders, ctx) => {
    const total = renders.thumbnail.bytes + renders.crops.reduce((sum, crop) => sum + crop.image.bytes, 0);
    if (total > 16 * 1024 * 1024) ctx.addIssue({ code: "custom", message: "a capture is at most 16 MiB" });
    if (new Set(renders.crops.map((crop) => crop.thread)).size !== renders.crops.length)
      ctx.addIssue({ code: "custom", message: "one crop per thread" });
  });
export type BoardRenders = z.infer<typeof BoardRenders>;
export const BoardCaptureRequest = z.strictObject({
  /** Exactly one: a live-draft capture, or derived pictures of an existing immutable version. */
  target: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("draft"),
      epoch: z.number().int().positive(),
      seq: z.number().int().nonnegative(),
    }),
    z.strictObject({ kind: z.literal("version"), version: z.number().int().positive() }),
  ]),
});
export const BoardCaptureThread = z.strictObject({
  n: z.number().int().positive(),
  anchor: BoardObjectAnchor,
});
export type BoardCaptureThread = z.infer<typeof BoardCaptureThread>;
export const BoardCapture = z.strictObject({
  ticket: Id,
  epoch: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
  hash: Hash,
  snapshot: BoardSnapshot,
  threads: z.array(BoardCaptureThread).max(500),
  expiresAt: Time,
});
export const BoardCheckpoint = Checkpoint.strict().extend({
  epoch: z.number().int().positive(),
  /** A browser supplies both, or neither. Without them the JSON version has pending pictures. */
  capture: z.strictObject({ ticket: Id, renders: BoardRenders }).optional(),
});
export const BoardCaptureCommit = z.strictObject({ ticket: Id, renders: BoardRenders });
export const BoardAssetPrepare = z.strictObject({ images: z.array(BoardImage).min(1).max(50) });
export const BoardAssetsPrepared = z.strictObject({
  images: z.array(
    z.strictObject({ hash: Hash, url: z.url().nullable(), headers: z.record(z.string(), z.string()) }),
  ),
});
/** Board awareness uses the existing transport; unrelated pointers never extend a gesture. */
export const BoardAwarenessState = z.strictObject({
  user: z.strictObject({
    author: z.string(),
    name: z.string(),
    kind: z.enum(["person", "agent"]),
    color: z.string(),
  }),
  mode: EditMode,
  objects: z.array(BoardObjectId).max(50),
  pending: z.array(BoardObjectId).max(50),
  cursor: BoardPoint.nullable(),
});

export const BoardCreateRequest = z.strictObject({
  project: z.string().regex(SLUG_PATTERN),
  slug: z.string().regex(SLUG_PATTERN),
  title: z.string().trim().min(1).max(120),
  summary: Summary,
  tags: Tags.optional(),
  sources: Sources.optional(),
});
export const BoardSuggestionList = z.strictObject({
  suggestions: z.array(BoardSuggestion).max(50),
  nextCursor: z.string().nullable(),
});
export const BoardCaptureCommitted = z.strictObject({
  version: z.number().int().positive(),
  hash: Hash,
  renders: BoardRenders,
});
export const BoardAssetsCommitted = z.strictObject({ images: z.array(BoardImage).max(50) });
export type BoardCreateRequest = z.infer<typeof BoardCreateRequest>;
export type BoardCheckpoint = z.infer<typeof BoardCheckpoint>;
export type BoardCapture = z.infer<typeof BoardCapture>;
export type BoardAwarenessState = z.infer<typeof BoardAwarenessState>;

/** Full immutable scene for the native reader; object pagination remains the agent read interface. */
export const BoardVersionView = z.strictObject({
  version: z.number().int().positive(),
  page: Key,
  hash: Hash,
  snapshot: BoardSnapshot,
  authors: z.array(Author),
  renders: BoardRenders.nullable(),
});
export type BoardVersionView = z.infer<typeof BoardVersionView>;

/** Paginated server projection of a ghost batch, kept out of bounded suggestion-list results. */
export const BoardSuggestionPreview = z.strictObject({
  id: Id,
  epoch: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
  objects: z.array(z.strictObject({ object: BoardObject, base: BoardBase })),
  deleted: z.array(BoardObjectId),
  nextCursor: z.string().nullable(),
});
export type BoardSuggestionPreview = z.infer<typeof BoardSuggestionPreview>;
