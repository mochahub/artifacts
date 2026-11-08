import { createHash } from "node:crypto";
import { boardOutline, yToBoard } from "@artifacts/doc/board";
import { boardBase, boardHash } from "@artifacts/doc/board-hash";
import { keyBetween } from "@artifacts/doc/board-order";
import type { AgentPolicy } from "@artifacts/schema";
import type { BoardObject, BoardRead, BoardSnapshot } from "@artifacts/schema/boards";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { LoadedArtifact } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { boardSuggestions, boardVersions, editDocs, frames, threads, versions } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { agentPolicy, missingEditScope, POLICY_TEXT } from "../editing/policy.ts";
import { type DocLock, editability, ensureDoc, loadDoc } from "../editing/store.ts";
import { authorsFor, visibleSources } from "../editing/suggestions.ts";
import { ApiError } from "../http/errors.ts";
import { sourceKey } from "./ops.ts";
import { toBoardSuggestions } from "./suggestions.ts";

/**
 * `board_read` (14, "Agent operations and placement"): a board as structured objects, a page at a time.
 * The latest checkpoint by default; the live draft only for an editor who asks, never as a fallback.
 * Reads take no write lock. A cursor is bound to what it read, so a draft that moved on says
 * `stale_read` and the agent starts again rather than mixing two boards.
 */

const PAGE_OBJECTS = 50;
const PAGE_BYTES = 32 * 1024;
const SECTIONS = ["objects", "frames", "suggestions"] as const;
type Section = (typeof SECTIONS)[number];
type Cursor = { s: Section; i: number; k: string };

const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
function decode(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString()) as Cursor;
    if (
      SECTIONS.includes(parsed.s) &&
      Number.isInteger(parsed.i) &&
      parsed.i >= 0 &&
      typeof parsed.k === "string"
    )
      return parsed;
  } catch {}
  throw new ApiError("invalid", "That cursor isn't valid.");
}

/** Deterministic temporary ids for a legacy canvas's frames: not editable bases until a first edit. */
const legacyId = (page: string, frame: string) => {
  const digits = BigInt(
    `0x${createHash("sha256").update(`${page}\u0000${frame}`).digest("hex").slice(0, 16)}`,
  );
  return `~${digits.toString(36).padStart(13, "0").slice(-10)}`;
};

type Loaded = {
  snapshot: BoardSnapshot;
  version: number;
  draft: boolean;
  epoch: number;
  seq: number;
  meta: { title?: string; summary?: string; tags?: string[]; sources?: string[] } | null;
};

/** The draft, read in one read-only snapshot of the row and its updates; seeded first if there is none. */
async function readDraft(deps: Deps, artifact: LoadedArtifact): Promise<Loaded> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await ensureDoc(deps, artifact);
    const read = await deps.db.transaction(
      async (tx) => {
        const [row] = await tx.select().from(editDocs).where(eq(editDocs.artifactId, artifact.id));
        if (!row || row.snapshot.length === 0) return null;
        const view: DocLock = { tx, row, after: () => {} };
        const { ydoc, row: current } = await loadDoc(deps, artifact.id, view);
        return {
          snapshot: yToBoard(ydoc),
          epoch: current.epoch,
          seq: current.seq,
          meta: current.meta ?? null,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    if (read) return { ...read, version: artifact.row.latestVersion, draft: true };
  }
  throw new ApiError("conflict", "This board changed as it was read. Read it again.", {
    reason: "stale_read",
  });
}

/** A checkpoint: its immutable native snapshot, or a legacy canvas's frames projected without a draft. */
async function readVersion(deps: Deps, artifact: LoadedArtifact, n: number): Promise<Loaded> {
  const [version] = await deps.db
    .select({ id: versions.id, n: versions.n })
    .from(versions)
    .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, n), isNull(versions.deletedAt)))
    .limit(1);
  if (!version) throw new ApiError("not_found", "There's no such version.");
  const [native] = await deps.db
    .select({ snapshot: boardVersions.snapshot })
    .from(boardVersions)
    .where(eq(boardVersions.versionId, version.id))
    .limit(1);
  if (native) return { snapshot: native.snapshot, version: n, draft: false, epoch: 0, seq: 0, meta: null };
  const rows = await deps.db
    .select()
    .from(frames)
    .where(eq(frames.versionId, version.id))
    .orderBy(asc(frames.pageKey), asc(frames.boardKey), asc(frames.frameKey))
    .limit(5000);
  const stamp = { a: "a1", t: new Date(0).toISOString() };
  const fields = { pose: stamp, parent: stamp, order: stamp, style: stamp, label: stamp, data: stamp };
  const orders: string[] = [];
  for (const _ of rows) orders.push(keyBetween(orders.at(-1) ?? null, null));
  const objects = rows.map(
    (row, i) =>
      ({
        id: legacyId(row.pageKey, row.frameKey),
        kind: "rendered_frame",
        pose: { x: row.x, y: row.y, w: Math.max(1, row.w), h: Math.max(1, row.h), angle: 0 },
        parent: null,
        order: orders[i] as string,
        label: row.title ?? row.frameKey,
        style: {
          fill: "transparent",
          stroke: "#242424",
          strokeWidth: 0,
          opacity: 1,
          fontSize: 20,
          align: "left",
        },
        data: {
          source: { page: row.pageKey, board: row.boardKey, frame: row.frameKey },
          version: n,
          contentHash: row.contentHash,
          renders: row.renders,
          intrinsic: { w: Math.max(1, row.w), h: Math.max(1, row.h) },
          livePath: row.livePath,
          missing: false,
        },
        attribution: { created: stamp, fields, text: [] },
      }) as BoardObject,
  );
  const page = rows[0]?.pageKey ?? "board";
  return {
    snapshot: { schema: 1, page, objects, deleted: [], assets: [] },
    version: n,
    draft: false,
    epoch: 0,
    seq: 0,
    meta: null,
  };
}

/** Open threads pinned to native objects, by object id. */
async function objectThreads(deps: Deps, artifactId: string) {
  const rows = await deps.db
    .select({ n: threads.n, anchor: threads.anchor })
    .from(threads)
    .where(and(eq(threads.artifactId, artifactId), eq(threads.status, "open")))
    .orderBy(asc(threads.n));
  const map = new Map<string, number[]>();
  for (const row of rows) {
    const anchor = row.anchor as { type?: string; object?: string } | null;
    if (anchor?.type !== "object" || !anchor.object) continue;
    map.set(anchor.object, [...(map.get(anchor.object) ?? []), row.n]);
  }
  return map;
}

/** Published frames of the latest version and where each stands on this board. */
async function sourceFrames(deps: Deps, artifact: LoadedArtifact, snapshot: BoardSnapshot, draft: boolean) {
  const [latest] = await deps.db
    .select({ id: versions.id })
    .from(versions)
    .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, artifact.row.latestVersion)))
    .limit(1);
  if (!latest) return [];
  const rows = await deps.db
    .select()
    .from(frames)
    .where(and(eq(frames.versionId, latest.id), eq(frames.pageKey, snapshot.page)))
    .orderBy(asc(frames.boardKey), asc(frames.frameKey))
    .limit(5000);
  const placed = new Map<string, BoardObject>();
  for (const object of snapshot.objects)
    if (object.kind === "rendered_frame") placed.set(sourceKey(object.data.source), object);
  const deleted = new Set(snapshot.deleted.flatMap((d) => (d.source ? [sourceKey(d.source)] : [])));
  const proposed = new Map<string, string>();
  if (draft) {
    const open = await deps.db
      .select({ ids: boardSuggestions.ids, request: boardSuggestions.request })
      .from(boardSuggestions)
      .where(and(eq(boardSuggestions.artifactId, artifact.id), eq(boardSuggestions.status, "open")));
    for (const row of open)
      for (const op of row.request.ops)
        if (op.op === "place_frame" && op.ref && row.ids[op.ref])
          proposed.set(sourceKey(op.source), row.ids[op.ref] as string);
  }
  return rows.map((row) => {
    const key = sourceKey({ page: row.pageKey, frame: row.frameKey });
    const object = placed.get(key);
    const ghost = proposed.get(key);
    return {
      source: { page: row.pageKey, board: row.boardKey, frame: row.frameKey },
      object: object?.id ?? ghost ?? null,
      base: object ? boardBase(object) : null,
      contentHash: row.contentHash,
      intrinsic: { w: Math.max(1, row.w), h: Math.max(1, row.h) },
      placement: object ? "placed" : deleted.has(key) ? "deleted" : ghost ? "suggested" : "unplaced",
    } as BoardRead["frames"][number];
  });
}

/** Author keys an object's stamps and text runs name. */
const authorKeys = (object: BoardObject) => [
  object.attribution.created.a,
  ...Object.values(object.attribution.fields).map((s) => s.a),
  ...object.attribution.text.map((r) => r.a),
];

export async function readBoard(
  deps: Deps,
  caller: Caller,
  artifact: LoadedArtifact,
  options: { draft?: boolean; version?: number; cursor?: string },
): Promise<BoardRead> {
  const canEdit = can(caller, "artifact.edit", artifact);
  if (options.draft && options.version !== undefined)
    throw new ApiError("invalid", "Read the draft or a version, not both.");
  if (options.draft && !canEdit)
    throw new ApiError(
      "forbidden",
      missingEditScope(caller, artifact) ? POLICY_TEXT.scope : "Reading the draft needs the edit right.",
      missingEditScope(caller, artifact) ? { scope: "edit" } : {},
    );
  if (options.draft) {
    const state = (await editability(deps, artifact)) as Awaited<ReturnType<typeof editability>> & {
      kind?: string;
    };
    if (!state.editable)
      throw new ApiError("conflict", "This board can't be edited here.", {
        reason: "not_editable",
        editable: state.reason,
      });
    if (state.kind !== "board")
      throw new ApiError("conflict", "This page is an article: read it with page_read.", {
        reason: "not_canvas",
      });
  }
  const loaded = options.draft
    ? await readDraft(deps, artifact)
    : await readVersion(deps, artifact, options.version ?? artifact.row.latestVersion);
  const hash = boardHash(loaded.snapshot);
  const binding = loaded.draft ? `d:${loaded.epoch}:${loaded.seq}` : `v:${loaded.version}:${hash}`;
  const cursor = options.cursor ? decode(options.cursor) : { s: "objects" as const, i: 0, k: binding };
  if (cursor.k !== binding)
    throw new ApiError("conflict", "The board changed since that page. Read it again from the start.", {
      reason: "stale_read",
    });
  const policy = await agentPolicy(deps, caller, artifact);
  const agents: AgentPolicy = { edits: policy.edits, reason: policy.reason, text: policy.text };

  const outline = boardOutline(loaded.snapshot);
  const pins = await objectThreads(deps, artifact.id);
  const objects: BoardRead["objects"] = [];
  let frameList: BoardRead["frames"] = [];
  let suggestionList: BoardRead["suggestions"] = [];
  let next: Cursor | null = null;
  let section: Section = cursor.s;
  let from = cursor.i;
  // One section after another: a page that finishes one carries on into the next.
  if (section === "objects") {
    let bytes = 0;
    for (let i = from; i < outline.length; i++) {
      const object = outline[i] as BoardObject;
      const size = Buffer.byteLength(JSON.stringify(object));
      if (objects.length >= PAGE_OBJECTS || (objects.length > 0 && bytes + size > PAGE_BYTES)) {
        next = { s: "objects", i, k: binding };
        break;
      }
      bytes += size;
      objects.push({ object, base: boardBase(object), threads: pins.get(object.id) ?? [] });
    }
    section = "frames";
    from = 0;
  }
  if (!next && section === "frames") {
    const all = await sourceFrames(deps, artifact, loaded.snapshot, loaded.draft && canEdit);
    frameList = all.slice(from, from + PAGE_OBJECTS);
    if (from + PAGE_OBJECTS < all.length) next = { s: "frames", i: from + PAGE_OBJECTS, k: binding };
    section = "suggestions";
    from = 0;
  }
  if (!next && section === "suggestions" && loaded.draft && canEdit) {
    const rows = await deps.db
      .select()
      .from(boardSuggestions)
      .where(and(eq(boardSuggestions.artifactId, artifact.id), eq(boardSuggestions.status, "open")))
      .orderBy(asc(boardSuggestions.createdAt), asc(boardSuggestions.id))
      .offset(from)
      .limit(PAGE_OBJECTS + 1);
    suggestionList = await toBoardSuggestions(deps, caller, artifact, rows.slice(0, PAGE_OBJECTS));
    if (rows.length > PAGE_OBJECTS) next = { s: "suggestions", i: from + PAGE_OBJECTS, k: binding };
  }

  const used = new Set(objects.flatMap((entry) => authorKeys(entry.object)));
  const images = new Set(
    objects.flatMap((entry) => (entry.object.kind === "image" ? [entry.object.asset] : [])),
  );
  const [latest] = await deps.db
    .select({ summary: versions.summary, tags: versions.tags, wiki: versions.wiki })
    .from(versions)
    .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, loaded.version)))
    .limit(1);
  const meta = loaded.meta;
  const sources = await visibleSources(deps, caller, artifact);
  return {
    artifact: `${artifact.project.slug}/${artifact.row.slug}`,
    page: loaded.snapshot.page,
    title: meta?.title ?? artifact.row.title,
    summary: meta?.summary ?? latest?.summary ?? null,
    tags: meta?.tags ?? latest?.tags ?? [],
    sources: (meta?.sources ?? latest?.wiki?.sources ?? []).filter((slug) => sources.has(slug)),
    version: Math.max(1, loaded.version),
    draft: loaded.draft,
    epoch: loaded.epoch,
    seq: loaded.seq,
    hash,
    agents,
    objects,
    assets: loaded.snapshot.assets.filter((image) => images.has(image.hash)),
    frames: frameList,
    authors:
      used.size && (loaded.draft || objects.some((entry) => entry.object.kind !== "rendered_frame"))
        ? await authorsFor(deps, artifact.id, [...used], await visibleSources(deps, caller, artifact))
        : [],
    suggestions: suggestionList,
    nextCursor: next ? encode(next) : null,
  };
}
