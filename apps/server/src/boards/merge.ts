import { createHash } from "node:crypto";
import {
  addBoardObject,
  boardStamp,
  deletedMap,
  emptyBoard,
  getRegister,
  newObject,
  objectsMap,
  setRegister,
  yToBoard,
} from "@artifacts/doc/board";
import { poseBounds, unionBounds } from "@artifacts/doc/board-geometry";
import { mintBoardObjectId } from "@artifacts/doc/board-ids";
import { keyBetween } from "@artifacts/doc/board-order";
import {
  DAY_MS,
  type FrameRecord,
  MANIFEST,
  type PageRecord,
  type PublishResult,
  SUGGESTION_DAYS,
} from "@artifacts/schema";
import type { BoardEditRequest, BoardSnapshot } from "@artifacts/schema/boards";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import { type ArtifactRow, findArtifact } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { boardSuggestions, boardVersions, editDocs, versions } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { agentPolicy } from "../editing/policy.ts";
import { type Actor, authorKey, type DocLock, loadDoc, persistUpdate } from "../editing/store.ts";
import { ApiError } from "../http/errors.ts";
import { blobKey } from "../layout.ts";
import { putBlob } from "../publish/blobs.ts";
import {
  boardLinks,
  boardModel,
  boardPath,
  canonicalJson,
  canonicalSnapshot,
  outline,
  sourceAssets,
  validatedImages,
} from "./checkpoint.ts";
import { placeBeside } from "./ops.ts";

type RenderedData = Extract<BoardSnapshot["objects"][number], { kind: "rendered_frame" }>["data"];

export type MergeInput = {
  artifact: ArtifactRow;
  pageKey: string;
  /** The incoming publish's already-validated frames for this page: the only source records trusted here. */
  frames: FrameRecord[];
  /** The version this publish becomes. */
  version: number;
  /** Board placement policy for new identities, resolved by the publisher like any board operation. */
  placement: "direct" | "suggestion" | "unplaced";
  tokenId: string | null;
};

const identity = (page: string, frame: string) => `${page}\u0000${frame}`;
const GAP = 80;
const TRIES = 100;

function renderedFrom(frame: FrameRecord, version: number): RenderedData {
  return {
    source: { page: frame.pageKey, board: frame.boardKey, frame: frame.frameKey },
    version,
    contentHash: frame.contentHash,
    renders: frame.renders,
    intrinsic: { w: frame.w, h: frame.h },
    livePath: frame.livePath,
    missing: false,
  };
}

/**
 * A compatible CLI republish onto a live native board (14, "Republish merge"), under the content advisory
 * lock and draft row lock the caller holds. Matching `(page, frame)` objects keep id, pose, parent, order,
 * label and human attribution; only their server-owned `data` changes, stamped with the publisher. A
 * removed identity is marked `missing`, a deliberately deleted one stays deleted, and a new identity
 * follows board placement policy: placed at root beside the scene, one ghost batch, or left unplaced.
 * The Yjs update is persisted by the caller before anything is broadcast.
 */
export async function mergeBoardFramesLocked(
  deps: Deps,
  lock: DocLock,
  input: MergeInput,
  actor: Actor,
): Promise<{ snapshot: BoardSnapshot; update: Uint8Array; placement: NonNullable<PublishResult["board"]> }> {
  if (!lock.row || lock.row.kind !== "board") throw new ApiError("conflict", "This page has no board draft.");
  const { ydoc } = await loadDoc(deps, input.artifact.id, lock);
  const key = await authorKey(deps, input.artifact.id, actor, [], lock);
  const stamp = boardStamp(key, deps.clock.now().getTime());
  const incoming = new Map(
    input.frames
      .filter((frame) => frame.pageKey === input.pageKey)
      .map((frame) => [identity(frame.pageKey, frame.frameKey), frame]),
  );
  const before = Y.encodeStateVector(ydoc);
  const represented = new Set<string>();
  const placed: string[] = [];
  const suggested: string[] = [];
  const unplaced: string[] = [];

  ydoc.transact(() => {
    for (const [id, map] of objectsMap(ydoc)) {
      if (map.get("kind") !== "rendered_frame") continue;
      const data = getRegister<RenderedData>(ydoc, id, "data")?.value;
      if (!data) continue;
      const at = identity(data.source.page, data.source.frame);
      represented.add(at);
      const frame = incoming.get(at);
      const next = frame ? renderedFrom(frame, input.version) : { ...data, missing: true };
      // Geometry is the person's: only the rendered source changes, whatever the new intrinsic size.
      if (JSON.stringify(next) !== JSON.stringify(data)) setRegister(ydoc, id, "data", next, stamp);
    }
    // Deleted on purpose stays deleted: the tombstone keeps the source tuple across epochs.
    for (const [, tombstone] of deletedMap(ydoc)) {
      if (tombstone.source) represented.add(identity(tombstone.source.page, tombstone.source.frame));
    }
  });

  const proposed = await openPlacementSources(lock.tx, input.artifact.id);
  const fresh = [...incoming.entries()]
    .filter(([at]) => !represented.has(at) && !proposed.has(at))
    .map(([, frame]) => frame);
  if (fresh.length && input.placement === "unplaced") unplaced.push(...fresh.map((frame) => frame.frameKey));
  if (fresh.length && input.placement !== "unplaced") {
    const scene = yToBoard(ydoc);
    const roots = scene.objects.filter((object) => object.parent === null);
    const obstacles = roots.map((object) => poseBounds(object.pose));
    const bounds = unionBounds(obstacles) ?? { x: 0, y: 0, w: 800, h: 600 };
    let last =
      roots
        .map((object) => object.order)
        .sort()
        .at(-1) ?? null;
    const ops: BoardEditRequest["ops"] = [];
    const ids: Record<string, string> = {};
    for (const [index, frame] of fresh.entries()) {
      const at = placeBeside({
        near: bounds,
        size: { w: frame.w, h: frame.h },
        side: "right",
        gap: GAP,
        obstacles,
      });
      if (!at)
        throw new ApiError("conflict", "There's no room on the board for a new frame.", {
          reason: "placement_full",
        });
      const pose = { x: at.x, y: at.y, w: frame.w, h: frame.h, angle: 0 };
      obstacles.push(poseBounds(pose));
      let id = mintBoardObjectId();
      for (let i = 0; i < TRIES && (objectsMap(ydoc).has(id) || deletedMap(ydoc).has(id)); i++)
        id = mintBoardObjectId();
      if (input.placement === "direct") {
        const order = keyBetween(last, null);
        last = order;
        addBoardObject(
          ydoc,
          newObject(
            {
              id,
              kind: "rendered_frame",
              pose,
              parent: null,
              order,
              label: frame.title ?? frame.frameKey,
              style: {
                fill: "transparent",
                stroke: "#242424",
                strokeWidth: 0,
                opacity: 1,
                fontSize: 20,
                align: "left",
              },
              data: renderedFrom(frame, input.version),
            },
            stamp,
          ),
        );
        placed.push(frame.frameKey);
      } else {
        const ref = `$f${index + 1}`;
        ids[ref] = id;
        ops.push({
          op: "place_frame",
          ref,
          source: { page: frame.pageKey, board: frame.boardKey, frame: frame.frameKey },
          near: { region: { ...bounds, w: Math.max(1, bounds.w), h: Math.max(1, bounds.h), angle: 0 } },
          side: "right",
          gap: GAP,
        });
      }
    }
    if (ops.length) {
      // One ghost batch for every new identity: reserved ids, nothing canonical until a person accepts.
      const now = deps.clock.now();
      const id = Bun.randomUUIDv7();
      await lock.tx.insert(boardSuggestions).values({
        id,
        orgId: input.artifact.orgId,
        artifactId: input.artifact.id,
        pageKey: input.pageKey,
        epoch: lock.row.epoch,
        request: { epoch: lock.row.epoch, requestId: Bun.randomUUIDv7(), bases: {}, ops },
        ids,
        status: "open",
        runId: null,
        authorKey: key,
        authorPersonId: actor.personId,
        agent: actor.agent,
        tokenId: input.tokenId,
        note: null,
        sources: [],
        fixes: [],
        createdAt: now,
        expiresAt: new Date(now.getTime() + SUGGESTION_DAYS * DAY_MS),
      });
      suggested.push(id);
    }
  }
  const update = Y.encodeStateAsUpdate(ydoc, before);
  return {
    snapshot: yToBoard(ydoc),
    update,
    placement: { placed, suggestions: suggested, unplaced },
  };
}

/** Open ghost placements of this page, so a republish never proposes the same source twice. */
export async function openPlacementSources(db: DocLock["tx"], artifactId: string) {
  const rows = await db
    .select({ request: boardSuggestions.request })
    .from(boardSuggestions)
    .where(and(eq(boardSuggestions.artifactId, artifactId), eq(boardSuggestions.status, "open")))
    .limit(200);
  return new Set(
    rows.flatMap((row) =>
      row.request.ops.flatMap((op) =>
        op.op === "place_frame" ? [identity(op.source.page, op.source.frame)] : [],
      ),
    ),
  );
}

type Files = Record<string, { hash: string; size: number; type: string }>;

/**
 * The publisher's side of a compatible republish onto a live board (14, "Republish merge", step 5), inside
 * its transaction and content lock. Null when this isn't one (no board draft, or the page's identity,
 * kind or backend changed): the ordinary live-draft rules then apply. Otherwise the new version carries the
 * new rendered source with the merged canonical board overlaid, and `finish` records it.
 */
export async function publishOntoBoardLocked(
  deps: Deps,
  tx: DocLock["tx"],
  place: { row: ArtifactRow; project: { id: string; slug: string } },
  incoming: { files: Files; pages: PageRecord[]; frames: FrameRecord[]; backendHash: string | null },
  caller: Caller,
  actor: Actor,
) {
  const [row] = await tx.select().from(editDocs).where(eq(editDocs.artifactId, place.row.id)).for("update");
  if (!row || row.kind !== "board" || row.snapshot.length === 0) return null;
  const [page] = incoming.pages;
  if (
    incoming.pages.length !== 1 ||
    page?.kind !== "canvas" ||
    page.key !== row.pageKey ||
    incoming.backendHash
  )
    return null;
  const queued: (() => void)[] = [];
  const lock: DocLock = { tx, row, after: (fn) => queued.push(fn) };
  // Read inside this transaction, never on another pool connection while it holds the content lock.
  const inTx = { ...deps, db: tx as unknown as Deps["db"] };
  const loaded = await findArtifact(inTx, place.row.orgId, place.row.id);
  if (!loaded) throw new ApiError("not_found", "No such artifact.");
  // Publishing rendered source is `publish`; placing a new picture is an ordinary board decision.
  const policy = caller.kind === "person" ? null : await agentPolicy(inTx, caller, loaded);
  const placement =
    !policy || policy.edits === "direct"
      ? "direct"
      : policy.edits === "suggestion"
        ? "suggestion"
        : "unplaced";
  const version = place.row.latestVersion + 1;
  const merged = await mergeBoardFramesLocked(
    deps,
    lock,
    {
      artifact: place.row,
      pageKey: row.pageKey,
      frames: incoming.frames,
      version,
      placement,
      tokenId: caller.kind === "cliToken" || caller.kind === "orgToken" ? caller.tokenId : null,
    },
    actor,
  );
  const seq =
    merged.update.byteLength > 2
      ? await persistUpdate(deps, place.row.id, merged.update, actor, lock, row.epoch)
      : row.seq;
  const tail = await boardVersionTail(deps, tx, place, incoming, merged.snapshot, row.pageKey, async (n) => {
    // Native draft changes are in this version too, so it's the draft's new checkpoint.
    await tx
      .update(editDocs)
      .set({ version: n, checkpointSeq: seq })
      .where(eq(editDocs.artifactId, place.row.id));
    queued.push(() => deps.docs?.notify(place.row.id, "c", { t: "checkpoint", version: n, kind: "handoff" }));
  });
  return {
    ...tail,
    docSeq: seq,
    placement: merged.placement,
    flush() {
      for (const fn of queued.splice(0)) fn();
    },
  };
}

/**
 * What a version carries for a native board, from one canonical snapshot: `__boards/<page>.json`, the
 * manifest's server-owned `native: 1`, the page's `meta.board` marker, object-id index rows for native
 * text and `[[links]]`, and, once `commitVersion` made version `n`, its `board_versions` row.
 */
async function boardVersionTail(
  deps: Deps,
  tx: DocLock["tx"],
  place: { row: ArtifactRow; project: { id: string; slug: string } },
  incoming: { files: Files; pages: PageRecord[] },
  scene: BoardSnapshot,
  pageKey: string,
  then?: (n: number) => Promise<void>,
) {
  const model = await boardModel();
  const hashes = sourceAssets(scene);
  const images = await validatedImages(tx, place.row.id, hashes);
  const snapshot = canonicalSnapshot({
    ...scene,
    assets: hashes.flatMap((hash) => images.get(hash) ?? []),
  });
  const hash = model.boardHash(snapshot);
  const files: Files = Object.fromEntries(
    Object.entries(incoming.files).filter(([path]) => !path.startsWith("__boards/")),
  );
  const bytes = new TextEncoder().encode(canonicalJson(snapshot));
  files[boardPath(pageKey)] = {
    hash: await putBlob(deps, place.row.orgId, bytes, "application/json"),
    size: bytes.length,
    type: "application/json",
  };
  // The native marker is the server's: a client manifest can't drop or forge it.
  const sent = incoming.files[MANIFEST]
    ? await deps.bucket.get(blobKey(incoming.files[MANIFEST].hash))
    : null;
  const client = JSON.parse(sent ? new TextDecoder().decode(sent.body) : "{}") as Record<string, unknown>;
  const manifest = {
    ...client,
    pages: ((client.pages ?? []) as { id: string }[]).map((entry) =>
      entry.id === pageKey ? { ...entry, native: 1 } : entry,
    ),
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  files[MANIFEST] = {
    hash: await putBlob(deps, place.row.orgId, manifestBytes, "application/json"),
    size: manifestBytes.length,
    type: "application/json",
  };
  const pages: PageRecord[] = incoming.pages.map((page) =>
    page.key === pageKey ? { ...page, meta: { ...page.meta, board: { schema: 1 as const, hash } } } : page,
  );
  // Native text stays in search and its links stay, keyed by object id: index rows, not article content.
  const blocks = outline(snapshot).flatMap((object) =>
    "text" in object && object.text
      ? [
          {
            pageKey,
            blockKey: object.id,
            contentHash: createHash("sha256").update(object.text).digest("hex"),
            text: object.text,
            authors: object.attribution.text.length ? object.attribution.text : null,
          },
        ]
      : [],
  );
  return {
    files,
    pages,
    blocks,
    pageKey,
    snapshot,
    links: boardLinks(snapshot, place.project.slug),
    /** Inside the same transaction, once `commitVersion` made version `n`. */
    async finish(n: number) {
      const [made] = await tx
        .select({ id: versions.id })
        .from(versions)
        .where(and(eq(versions.artifactId, place.row.id), eq(versions.n, n)))
        .limit(1);
      if (!made) throw new Error("no version row");
      await tx.insert(boardVersions).values({
        versionId: made.id,
        pageKey,
        orgId: place.row.orgId,
        artifactId: place.row.id,
        snapshot,
        hash,
        renders: null,
        renderedAt: null,
        createdAt: deps.clock.now(),
      });
      await then?.(n);
    },
  };
}

/**
 * A publish onto a native board with no live draft (14, "Republish merge"; never edited, retired after a
 * checkpoint, or just created). There is no draft to merge into, so the latest version's snapshot is
 * carried forward as plain JSON: matching `(page, frame)` objects get the new rendered data, removed
 * identities are marked `missing`, deleted ones stay deleted, and new ones are reported `unplaced` for an
 * ordinary `place_frame`. Null when the latest version has no native board or the page's shape changed.
 * `create` starts an empty native board instead (`POST /api/boards`).
 */
export async function carryBoardLocked(
  deps: Deps,
  tx: DocLock["tx"],
  place: { row: ArtifactRow; project: { id: string; slug: string } } | null,
  incoming: { files: Files; pages: PageRecord[]; frames: FrameRecord[]; backendHash: string | null },
  create?: { row: ArtifactRow; project: { id: string; slug: string }; pageKey: string },
) {
  const [page] = incoming.pages;
  if (incoming.pages.length !== 1 || page?.kind !== "canvas" || incoming.backendHash) return null;
  if (create) {
    if (page.key !== create.pageKey) return null;
    const tail = await boardVersionTail(deps, tx, create, incoming, emptyBoard(page.key), page.key);
    return { ...tail, placement: { placed: [], suggestions: [], unplaced: [] } };
  }
  if (!place) return null;
  const [found] = await tx
    .select({ snapshot: boardVersions.snapshot, pageKey: boardVersions.pageKey })
    .from(boardVersions)
    .innerJoin(versions, eq(versions.id, boardVersions.versionId))
    .where(and(eq(versions.artifactId, place.row.id), eq(versions.n, place.row.latestVersion)))
    .limit(1);
  if (!found || found.pageKey !== page.key) return null;
  const version = place.row.latestVersion + 1;
  const carried = carrySnapshot(found.snapshot, page.key, incoming.frames, version);
  const tail = await boardVersionTail(deps, tx, place, incoming, carried.snapshot, page.key);
  return { ...tail, placement: { placed: [], suggestions: [], unplaced: carried.unplaced } };
}

/** The pure carry-forward: refresh, mark missing, keep deletions, list new identities. Ids never change. */
export function carrySnapshot(
  snapshot: BoardSnapshot,
  pageKey: string,
  frames: FrameRecord[],
  version: number,
) {
  const incoming = new Map(
    frames
      .filter((frame) => frame.pageKey === pageKey)
      .map((frame) => [identity(frame.pageKey, frame.frameKey), frame]),
  );
  const represented = new Set<string>();
  const objects = snapshot.objects.map((object) => {
    if (object.kind !== "rendered_frame") return object;
    const at = identity(object.data.source.page, object.data.source.frame);
    represented.add(at);
    const frame = incoming.get(at);
    const data = frame ? renderedFrom(frame, version) : { ...object.data, missing: true };
    return JSON.stringify(data) === JSON.stringify(object.data) ? object : { ...object, data };
  });
  for (const tombstone of snapshot.deleted)
    if (tombstone.source) represented.add(identity(tombstone.source.page, tombstone.source.frame));
  const unplaced = [...incoming.entries()].filter(([at]) => !represented.has(at)).map(([, f]) => f.frameKey);
  return { snapshot: { ...snapshot, objects }, unplaced };
}
