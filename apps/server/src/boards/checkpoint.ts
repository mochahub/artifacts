import { createHash } from "node:crypto";
import { boardText, canonicalJSON, purgeDeleted, validateBoard, yToBoard } from "@artifacts/doc/board";
import { boardBase, boardHash } from "@artifacts/doc/board-hash";
import {
  BOARD_ASSETS_BYTES_MAX,
  BOARD_ASSETS_MAX,
  type BoardCaptureThread,
  type BoardImage,
  type BoardObject,
  type BoardRenders,
  type BoardSnapshot,
  type CheckpointResult,
  type FrameRecord,
  MANIFEST,
  type PageRecord,
} from "@artifacts/schema";
import { wikiTarget } from "@artifacts/schema/wiki";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type * as Y from "yjs";
import type { ArtifactRow, ProjectRow } from "../auth/access.ts";
import {
  artifacts,
  boardAssets,
  boardCaptures,
  boardSuggestions,
  boardVersions,
  editDocs,
  frames,
  pages,
  threads,
  versions,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { type CheckpointOptions, markFixed, resolveVersionMeta } from "../editing/checkpoint.ts";
import { compact, type DocLock, loadDoc, persistUpdate } from "../editing/store.ts";
import { ApiError } from "../http/errors.ts";
import { blobKey } from "../layout.ts";
import { putBlob } from "../publish/blobs.ts";
import { commitVersion } from "../publish/publisher.ts";

/** The board model's entry points, behind one name so tests can see what a checkpoint relies on. */
export type BoardModel = {
  yToBoard(doc: Y.Doc): BoardSnapshot;
  validateBoard(
    doc: Y.Doc,
    opts: { assets: Set<string>; author?: string },
  ): { ok: true } | { ok: false; reason: string };
  boardText(snapshot: BoardSnapshot): string;
  boardHash(snapshot: BoardSnapshot): string;
  boardBase(object: BoardObject): string;
};
const model: BoardModel = { yToBoard, validateBoard, boardText, boardHash, boardBase };
export const boardModel = async (): Promise<BoardModel> => model;

/** The shared canonical JSON (14, "Objects"): sorted keys, arrays kept, negative zero as zero. */
export const canonicalJson = (value: unknown): string => canonicalJSON(value);

const byKey =
  <T>(key: (item: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

/** The canonical snapshot: objects and deleted by id, assets by hash. These exact bytes are stored. */
export function canonicalSnapshot(snapshot: BoardSnapshot): BoardSnapshot {
  return {
    schema: 1,
    page: snapshot.page,
    objects: [...snapshot.objects].sort(byKey((object) => object.id)),
    deleted: [...(snapshot.deleted ?? [])].sort(byKey((entry) => entry.id)),
    assets: [...snapshot.assets].sort(byKey((image) => image.hash)),
  };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Parent tree, then `(order, id)`: the stable outline order for text, search and reading. */
export function outline(snapshot: BoardSnapshot): BoardObject[] {
  const children = new Map<string | null, BoardObject[]>();
  const ids = new Set(snapshot.objects.map((object) => object.id));
  for (const object of snapshot.objects) {
    const parent = object.parent && ids.has(object.parent) ? object.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), object]);
  }
  const order = (a: BoardObject, b: BoardObject) =>
    a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const out: BoardObject[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null) => {
    for (const object of (children.get(parent) ?? []).sort(order)) {
      if (seen.has(object.id)) continue;
      seen.add(object.id);
      out.push(object);
      walk(object.id);
    }
  };
  walk(null);
  return out;
}

const WIKILINK = /\[\[([^[\]|\n]{1,200})(?:\|([^[\]\n]{1,200}))?\]\]/g;
/** `[[wiki links]]` in native text, as `project/slug`, in outline order and once each (14, "Search"). */
export function boardLinks(snapshot: BoardSnapshot, project: string, max = 200): string[] {
  const found = new Set<string>();
  for (const object of outline(snapshot)) {
    if (!("text" in object) || !object.text.includes("[[")) continue;
    for (const match of object.text.matchAll(WIKILINK)) {
      const to = wikiTarget(match[1] ?? "", project);
      if (to) found.add(`${to.project}/${to.slug}`);
      if (found.size >= max) return [...found];
    }
  }
  return [...found];
}

export const boardPath = (page: string) => `__boards/${page}.json`;

/** Source image hashes the scene references: what the active-board asset limits count. */
export const sourceAssets = (snapshot: BoardSnapshot) => [
  ...new Set(snapshot.objects.flatMap((object) => (object.kind === "image" ? [object.asset] : []))),
];

/** Validated metadata for the hashes, from this artifact's associations only. */
export async function validatedImages(db: DocLock["tx"] | Deps["db"], artifactId: string, hashes: string[]) {
  if (hashes.length === 0) return new Map<string, BoardImage>();
  const rows = await db
    .select({ hash: boardAssets.hash, image: boardAssets.image, validatedAt: boardAssets.validatedAt })
    .from(boardAssets)
    .where(and(eq(boardAssets.artifactId, artifactId), inArray(boardAssets.hash, hashes)))
    .limit(hashes.length);
  return new Map(rows.filter((row) => row.validatedAt).map((row) => [row.hash, row.image]));
}

/** Frames of a version, as FrameRecords, so a board checkpoint carries rendered mocks through unchanged. */
export async function versionFrames(
  db: DocLock["tx"] | Deps["db"],
  versionId: string,
): Promise<FrameRecord[]> {
  const rows = await db.select().from(frames).where(eq(frames.versionId, versionId)).limit(5000);
  return rows.map((row) => ({
    pageKey: row.pageKey,
    boardKey: row.boardKey,
    frameKey: row.frameKey,
    title: row.title,
    device: row.device,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    contentHash: row.contentHash,
    renders: row.renders,
    livePath: row.livePath,
  }));
}

export type BoardCaptureInput = { ticket: string; renders: BoardRenders; personId: string };

const staleCapture = () =>
  new ApiError("conflict", "The board changed since this picture was taken. Capture it again.", {
    reason: "stale_capture",
  });

/** Every picture in a capture is a validated upload of this artifact with the metadata claimed. */
export async function checkRenders(
  db: DocLock["tx"] | Deps["db"],
  artifactId: string,
  renders: BoardRenders,
) {
  const images = [renders.thumbnail, ...renders.crops.map((crop) => crop.image)];
  const found = await validatedImages(db, artifactId, [...new Set(images.map((image) => image.hash))]);
  for (const image of images) {
    const row = found.get(image.hash);
    if (!row || canonicalJson(row) !== canonicalJson(image))
      throw new ApiError("invalid", "A picture in this capture wasn't uploaded and validated.");
  }
}

/** Same thread set exactly: no extra crops, duplicates or omitted ticket threads (14, "Browser capture"). */
export function sameThreads(frozen: BoardCaptureThread[], renders: BoardRenders) {
  const want = frozen.map((entry) => entry.n).sort((a, b) => a - b);
  const got = renders.crops.map((crop) => crop.thread).sort((a, b) => a - b);
  return want.length === got.length && want.every((n, i) => n === got[i]);
}

/** Open threads pinned to native objects on this page, frozen into a capture ticket. */
export async function objectThreads(
  db: DocLock["tx"] | Deps["db"],
  artifactId: string,
  pageKey: string,
  options: { version?: number; withoutCrop?: boolean } = {},
): Promise<BoardCaptureThread[]> {
  const rows = await db
    .select({ n: threads.n, anchor: threads.anchor })
    .from(threads)
    .where(
      and(
        eq(threads.artifactId, artifactId),
        eq(threads.pageKey, pageKey),
        eq(threads.status, "open"),
        sql`${threads.anchor}->>'type' = 'object'`,
        options.version ? sql`(${threads.anchor}->>'checkpoint')::int = ${options.version}` : undefined,
        options.withoutCrop ? isNull(threads.cropKey) : undefined,
      ),
    )
    .orderBy(threads.n)
    .limit(501);
  return rows.map((row) => ({ n: row.n, anchor: row.anchor as unknown as BoardCaptureThread["anchor"] }));
}

type Place = { row: ArtifactRow; project: ProjectRow };

/**
 * A board checkpoint inside a lock someone already holds (14, "Checkpoints, pictures and anchors"). The
 * immutable snapshot and its `__boards/<page>.json` file are one serialization. Without a capture the
 * version's pictures are pending; with one, consuming the ticket and attaching them is this transaction.
 */
export async function checkpointBoardLocked(
  deps: Deps,
  lock: DocLock,
  place: Place,
  options: CheckpointOptions,
  capture?: BoardCaptureInput,
): Promise<CheckpointResult> {
  const { tx, row } = lock;
  const [current] = await tx.select().from(artifacts).where(eq(artifacts.id, place.row.id)).limit(1);
  if (!current) throw new ApiError("not_found", "No such artifact.");
  const unchanged = { version: current.latestVersion, created: false, kind: null };
  if (!row || row.snapshot.length === 0) {
    if (capture) throw staleCapture();
    return unchanged;
  }
  const meta = row.meta as (typeof row.meta & { fixes?: { n: number }[] }) | null;
  const metaFields = meta ? Object.keys(meta).filter((key) => key !== "fixes" && key !== "sweep") : [];
  if (row.seq === row.checkpointSeq && metaFields.length === 0 && !meta?.fixes?.length) {
    // Nothing new to version; the ticket stays unused, so the browser can picture the version instead.
    return unchanged;
  }
  if (current.archivedAt) throw new ApiError("read_only", "This artifact is archived, so it's read-only.");

  const fail = (message: string): never => {
    deps.log.warn("board checkpoint failed", { artifact: place.row.id, message });
    deps.docs?.notify(place.row.id, "c", { t: "error", code: "checkpoint_failed", message });
    throw new ApiError("invalid", message);
  };

  const model = await boardModel();
  const { ydoc, row: loadedRow } = await loadDoc(deps, place.row.id, lock);
  const draft = model.yToBoard(ydoc);
  const hashes = sourceAssets(draft);
  const images = await validatedImages(tx, current.id, hashes);
  if (hashes.length > BOARD_ASSETS_MAX) fail(`A board holds at most ${BOARD_ASSETS_MAX} images.`);
  if ([...images.values()].reduce((sum, image) => sum + image.bytes, 0) > BOARD_ASSETS_BYTES_MAX)
    fail("This board's images are over the 100 MiB limit.");
  const valid = model.validateBoard(ydoc, { assets: new Set(images.keys()) });
  if (!valid.ok) fail(`The board isn't valid: ${valid.reason}`);
  if (hashes.some((hash) => !images.has(hash))) fail("The board uses an image that wasn't validated.");
  // Asset metadata is the server's validated record, never the document's claim.
  const snapshot = canonicalSnapshot({
    ...draft,
    assets: hashes.map((hash) => images.get(hash) as BoardImage),
  });
  const bytes = canonicalJson(snapshot);
  const hash = model.boardHash(snapshot);

  if (capture) {
    // Fenced to this person's ticket for exactly this persisted state (14, "Browser capture protocol").
    const [ticket] = await tx
      .select()
      .from(boardCaptures)
      .where(and(eq(boardCaptures.id, capture.ticket), eq(boardCaptures.artifactId, current.id)))
      .for("update")
      .limit(1);
    const now = deps.clock.now();
    if (!ticket || ticket.createdBy !== capture.personId || ticket.versionId !== null)
      throw new ApiError("not_found", "No such capture.");
    if (ticket.consumedAt || ticket.expiresAt <= now) throw staleCapture();
    if (ticket.epoch !== loadedRow.epoch || ticket.seq !== loadedRow.seq || ticket.hash !== hash)
      throw staleCapture();
    const open = await objectThreads(tx, current.id, row.pageKey);
    if (canonicalJson(open) !== canonicalJson(ticket.threads)) throw staleCapture();
    if (!sameThreads(ticket.threads, capture.renders))
      throw new ApiError(
        "invalid",
        "A capture has one crop for each of its ticket's threads, and no others.",
      );
    await checkRenders(tx, current.id, capture.renders);
    await tx.update(boardCaptures).set({ consumedAt: now }).where(eq(boardCaptures.id, ticket.id));
  }

  // Deleted objects' hidden maps go now, as the server's own update, so what someone deleted (a pasted
  // secret in a sticky, say) is gone from the draft's snapshot and log once this version records the
  // deletion. Their tombstones stay. The snapshot is unchanged by this, so the capture fence above holds.
  const purge = purgeDeleted(ydoc);
  const docSeq = purge
    ? await persistUpdate(
        deps,
        current.id,
        purge,
        { origin: "server", personId: null, agent: null, tokenId: null },
        lock,
        loadedRow.epoch,
      )
    : loadedRow.seq;

  const [base] = await tx
    .select()
    .from(versions)
    .where(and(eq(versions.artifactId, current.id), eq(versions.n, current.latestVersion)))
    .limit(1);
  const [basePage] = base
    ? await tx
        .select()
        .from(pages)
        .where(and(eq(pages.versionId, base.id), eq(pages.pageKey, row.pageKey)))
        .limit(1)
    : [];
  if (!base || !basePage) return fail("The page's version is missing.");
  const manifestHash = base.files[MANIFEST]?.hash;
  const manifestObject = manifestHash ? await deps.bucket.get(blobKey(manifestHash)) : null;
  const manifest = JSON.parse(manifestObject ? new TextDecoder().decode(manifestObject.body) : "{}") as {
    title?: string;
    pages?: { id: string; title?: string; native?: 1 }[];
  } & Record<string, unknown>;

  const resolved = await resolveVersionMeta(
    deps,
    tx,
    current,
    base,
    manifest,
    meta,
    options,
    loadedRow,
    fail,
  );
  const nextManifest = {
    ...manifest,
    title: resolved.title,
    ...(resolved.summary ? { summary: resolved.summary } : {}),
    ...(resolved.tags ? { tags: resolved.tags } : {}),
    ...(resolved.wiki ? { wiki: resolved.wiki } : {}),
    // A native board keeps its marker from its first checkpoint on, mixed with rendered boards or not.
    pages: manifest.pages?.map((entry) =>
      entry.id === row.pageKey ? { ...entry, title: resolved.title, native: 1 as const } : entry,
    ),
  };
  const files = { ...base.files };
  for (const [path, body] of [
    [boardPath(row.pageKey), bytes],
    [MANIFEST, JSON.stringify(nextManifest, null, 2)],
  ] as const) {
    const encoded = new TextEncoder().encode(body);
    const blob = await putBlob(deps, place.row.orgId, encoded, "application/json");
    files[path] = { hash: blob, size: encoded.length, type: "application/json" };
  }

  // Native text joins the existing search/anchor index as rows keyed by object id; never article content.
  // A native frame's title is its label, so a group is found by its name as a sticky is by its text.
  const blockRows = outline(snapshot).flatMap((object) =>
    "text" in object && object.text
      ? [
          {
            pageKey: row.pageKey,
            blockKey: object.id,
            contentHash: sha256(object.text),
            text: object.text,
            authors: object.attribution.text.length ? object.attribution.text : null,
          },
        ]
      : object.kind === "frame" && object.label.trim()
        ? [
            {
              pageKey: row.pageKey,
              blockKey: object.id,
              contentHash: sha256(object.label),
              text: object.label,
              authors: null,
            },
          ]
        : [],
  );
  const page: PageRecord = {
    key: row.pageKey,
    kind: "canvas",
    title: resolved.title,
    group: basePage.group,
    position: basePage.position,
    meta: { ...basePage.meta, board: { schema: 1, hash } },
  };
  const carried = await versionFrames(tx, base.id);

  const personId = options.personId ?? loadedRow.lastActorPersonId ?? current.publisherId;
  const now = deps.clock.now();
  const result = await commitVersion(
    tx,
    current,
    {
      artifactId: current.id,
      orgId: current.orgId,
      projectId: current.projectId,
      title: resolved.title,
      files,
      backendHash: null,
      message: options.message ?? null,
      name: options.name ?? null,
      notes: {},
      summary: resolved.summary,
      tags: resolved.tags,
      wiki: resolved.wiki as never,
      links: boardLinks(snapshot, place.project.slug).filter(
        (link) => link !== `${place.project.slug}/${current.slug}`,
      ),
      pages: [page],
      frames: carried,
      blocks: blockRows,
      checkpoint: options.kind,
      docSeq,
      now,
      boards: [{ pageKey: loadedRow.pageKey, snapshot }],
    },
    { personId, agent: options.agent },
  );
  const n = result.version;
  const [made] = await tx
    .select({ id: versions.id })
    .from(versions)
    .where(and(eq(versions.artifactId, current.id), eq(versions.n, n)))
    .limit(1);
  await tx.insert(boardVersions).values({
    versionId: made?.id as string,
    pageKey: row.pageKey,
    orgId: current.orgId,
    artifactId: current.id,
    snapshot,
    hash,
    renders: capture?.renders ?? null,
    renderedAt: capture ? now : null,
    createdAt: now,
  });
  await tx
    .update(editDocs)
    .set({ version: n, checkpointSeq: docSeq, meta: null, dirtySince: null })
    .where(eq(editDocs.artifactId, current.id));
  await compact(tx, current.id);
  // Accepted board batches that said they fix a thread are fixed by this version, as article ones are.
  const accepted = await tx
    .update(boardSuggestions)
    .set({ version: n })
    .where(
      and(
        eq(boardSuggestions.artifactId, current.id),
        eq(boardSuggestions.status, "accepted"),
        isNull(boardSuggestions.version),
      ),
    )
    .returning({
      fixes: boardSuggestions.fixes,
      personId: boardSuggestions.authorPersonId,
      agent: boardSuggestions.agent,
      tokenId: boardSuggestions.tokenId,
      decidedBy: boardSuggestions.decidedBy,
    });
  await markFixed(deps, tx, current, n, (meta?.fixes ?? []) as never, accepted);
  lock.row = { ...row, seq: docSeq, version: n, checkpointSeq: docSeq, meta: null, dirtySince: null };
  lock.after(() => {
    void deps.events.emit(current.id, "version", { version: n });
    deps.docs?.notify(current.id, "c", { t: "checkpoint", version: n, kind: options.kind });
  });
  return { version: n, created: true, kind: options.kind };
}

/** Capture tickets that expired unused: nothing refers to them (jobs sweep). */
export async function sweepCaptures(deps: Deps) {
  await deps.db
    .delete(boardCaptures)
    .where(and(gt(sql`now()`, boardCaptures.expiresAt), isNull(boardCaptures.consumedAt)));
}
