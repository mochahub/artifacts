import {
  BOARD_CAPTURE_TTL_MS,
  type BoardCapture,
  type BoardCaptureRequest,
  type BoardRenders,
} from "@artifacts/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { z } from "zod";
import type { LoadedArtifact } from "../auth/access.ts";
import { lockArtifact } from "../db/locks.ts";
import { boardCaptures, boardVersions, threads, versions } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { loadDoc, withDocLock } from "../editing/store.ts";
import { ApiError } from "../http/errors.ts";
import { blobKey, cropKey } from "../layout.ts";
import { mapLimit } from "../map-limit.ts";
import {
  boardModel,
  canonicalJson,
  canonicalSnapshot,
  checkRenders,
  objectThreads,
  sameThreads,
  sourceAssets,
  validatedImages,
} from "./checkpoint.ts";

const stale = () =>
  new ApiError("conflict", "The board changed since this picture was taken. Capture it again.", {
    reason: "stale_capture",
  });

/**
 * `POST …/board/captures` (14, "Browser capture protocol"): fences a persisted draft state or an immutable
 * version, freezes its open object-pinned threads, and answers the exact snapshot to draw. Only a session
 * with edit reaches this; the ticket is that person's.
 */
export async function prepareCapture(
  deps: Deps,
  personId: string,
  artifact: LoadedArtifact,
  request: z.infer<typeof BoardCaptureRequest>,
): Promise<BoardCapture> {
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + BOARD_CAPTURE_TTL_MS);
  const target = request.target;
  if (target.kind === "draft") {
    return withDocLock(deps, artifact.id, async (lock) => {
      if (!lock.row || lock.row.kind !== "board" || lock.row.snapshot.length === 0) throw stale();
      if (lock.row.epoch !== target.epoch)
        throw new ApiError("conflict", "The draft was reset.", { reason: "stale_epoch" });
      const model = await boardModel();
      const { ydoc, row } = await loadDoc(deps, artifact.id, lock);
      if (row.seq !== target.seq) throw stale();
      const draft = model.yToBoard(ydoc);
      const images = await validatedImages(lock.tx, artifact.id, sourceAssets(draft));
      const snapshot = canonicalSnapshot({ ...draft, assets: [...images.values()] });
      const threads = await objectThreads(lock.tx, artifact.id, row.pageKey);
      if (threads.length > 500)
        throw new ApiError("too_large", "Too many open pins to picture at once. Save without pictures.");
      const hash = model.boardHash(snapshot);
      const ticket = Bun.randomUUIDv7();
      await lock.tx.insert(boardCaptures).values({
        id: ticket,
        orgId: artifact.row.orgId,
        artifactId: artifact.id,
        pageKey: row.pageKey,
        versionId: null,
        epoch: row.epoch,
        seq: row.seq,
        hash,
        threads,
        createdBy: personId,
        expiresAt,
        createdAt: now,
      });
      return {
        ticket,
        epoch: row.epoch,
        seq: row.seq,
        hash,
        snapshot,
        threads,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }
  // A version target never seeds a draft: its snapshot is immutable.
  const [found] = await deps.db
    .select({
      versionId: versions.id,
      docSeq: versions.docSeq,
      deletedAt: versions.deletedAt,
      board: boardVersions,
    })
    .from(versions)
    .innerJoin(boardVersions, eq(boardVersions.versionId, versions.id))
    .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, target.version)))
    .limit(1);
  if (!found || found.deletedAt) throw new ApiError("not_found", "No such version.");
  // Only threads without a crop on this version yet: existing pictures are immutable.
  const captured = new Set(found.board.renders?.crops.map((crop) => crop.thread) ?? []);
  const threads = (
    await objectThreads(deps.db, artifact.id, found.board.pageKey, { version: target.version })
  ).filter(
    (entry) =>
      !captured.has(entry.n) &&
      found.board.snapshot.objects.some((object) => object.id === entry.anchor.object),
  );
  if (threads.length > 500) throw new ApiError("too_large", "Too many open pins to picture at once.");
  const ticket = Bun.randomUUIDv7();
  const seq = found.docSeq ?? 0;
  await deps.db.insert(boardCaptures).values({
    id: ticket,
    orgId: artifact.row.orgId,
    artifactId: artifact.id,
    pageKey: found.board.pageKey,
    versionId: found.versionId,
    epoch: 1,
    seq,
    hash: found.board.hash,
    threads,
    createdBy: personId,
    expiresAt,
    createdAt: now,
  });
  return {
    ticket,
    epoch: 1,
    seq,
    hash: found.board.hash,
    snapshot: found.board.snapshot,
    threads,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * `POST …/board/captures/commit`: derived pictures for an immutable version. Compare-and-set per slot: the
 * thumbnail goes from null once; a crop may only fill a thread slot that had none. An identical retry is
 * fine; a differing set is `conflict`. Content, hash, version number and authorship never change.
 */
export async function commitCapture(
  deps: Deps,
  personId: string,
  artifact: LoadedArtifact,
  body: { ticket: string; renders: BoardRenders },
) {
  return deps.db.transaction(async (tx) => {
    await lockArtifact(tx, artifact.id, "content");
    const [ticket] = await tx
      .select()
      .from(boardCaptures)
      .where(and(eq(boardCaptures.id, body.ticket), eq(boardCaptures.artifactId, artifact.id)))
      .for("update")
      .limit(1);
    if (!ticket || ticket.createdBy !== personId || !ticket.versionId)
      throw new ApiError("not_found", "No such capture.");
    const [row] = await tx
      .select({ board: boardVersions, n: versions.n })
      .from(boardVersions)
      .innerJoin(versions, eq(versions.id, boardVersions.versionId))
      .where(and(eq(boardVersions.versionId, ticket.versionId), eq(boardVersions.pageKey, ticket.pageKey)))
      .for("update")
      .limit(1);
    if (!row) throw new ApiError("not_found", "No such version.");
    const existing = row.board.renders;
    const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
    // A retry of the identical set succeeds, even once its ticket was used.
    if (existing && same(existing.thumbnail, body.renders.thumbnail)) {
      const had = new Map(existing.crops.map((crop) => [crop.thread, crop]));
      if (body.renders.crops.every((crop) => had.has(crop.thread) && same(had.get(crop.thread), crop)))
        return { version: row.n, hash: row.board.hash, renders: existing };
    }
    if (ticket.consumedAt || ticket.expiresAt <= deps.clock.now() || ticket.hash !== row.board.hash)
      throw stale();
    if (!sameThreads(ticket.threads, body.renders))
      throw new ApiError(
        "invalid",
        "A capture has one crop for each of its ticket's threads, and no others.",
      );
    await checkRenders(tx, artifact.id, body.renders);
    let renders: BoardRenders;
    if (!existing) renders = body.renders;
    else {
      if (!same(existing.thumbnail, body.renders.thumbnail))
        throw new ApiError("conflict", "This version already has pictures.", { reason: "captured" });
      const had = new Set(existing.crops.map((crop) => crop.thread));
      if (body.renders.crops.some((crop) => had.has(crop.thread)))
        throw new ApiError("conflict", "A pin on this version already has its picture.", {
          reason: "captured",
        });
      renders = { thumbnail: existing.thumbnail, crops: [...existing.crops, ...body.renders.crops] };
    }
    const now = deps.clock.now();
    await tx
      .update(boardVersions)
      .set({ renders, renderedAt: now })
      .where(and(eq(boardVersions.versionId, ticket.versionId), eq(boardVersions.pageKey, ticket.pageKey)));
    await tx.update(boardCaptures).set({ consumedAt: now }).where(eq(boardCaptures.id, ticket.id));
    return { version: row.n, hash: row.board.hash, renders };
  });
}

/**
 * After a capture is attached: each object-pinned thread made on that version gets its crop as its own
 * crop picture (14, "Object comments"), copied to the thread's crop key so a thread purge never deletes a
 * shared blob. Only pins matching the ticket's frozen anchor, and only ones without a crop. Best effort: a
 * failure is logged and the pictures stay with the version.
 */
export async function attachThreadCrops(
  deps: Deps,
  artifactId: string,
  version: number,
  crops: BoardRenders["crops"],
  ticketId: string,
) {
  if (crops.length === 0) return;
  // The ticket freezes the exact anchor drawn, including its original checkpoint. An unchanged pin
  // can be pictured on a later checkpoint; attachment must compare that provenance, not rewrite it.
  const [ticket] = await deps.db
    .select()
    .from(boardCaptures)
    .where(and(eq(boardCaptures.id, ticketId), eq(boardCaptures.artifactId, artifactId)))
    .limit(1);
  if (!ticket?.consumedAt) return;
  const anchors = new Map(ticket.threads.map((entry) => [entry.n, entry.anchor]));
  const rows = await deps.db
    .select({ id: threads.id, n: threads.n, anchor: threads.anchor, cropKey: threads.cropKey })
    .from(threads)
    .where(
      and(
        eq(threads.artifactId, artifactId),
        inArray(
          threads.n,
          crops.map((crop) => crop.thread),
        ),
        isNull(threads.cropKey),
      ),
    )
    .limit(crops.length);
  const byN = new Map(crops.map((crop) => [crop.thread, crop.image.hash]));
  await mapLimit(rows, 4, async (row) => {
    const hash = byN.get(row.n);
    if (
      !hash ||
      row.anchor?.type !== "object" ||
      row.anchor.checkpoint > version ||
      canonicalJson(row.anchor) !== canonicalJson(anchors.get(row.n) ?? null)
    )
      return;
    try {
      const object = await deps.bucket.get(blobKey(hash));
      if (!object) return;
      await deps.db.transaction(async (tx) => {
        const [current] = await tx
          .select({ anchor: threads.anchor, cropKey: threads.cropKey })
          .from(threads)
          .where(eq(threads.id, row.id))
          .for("update")
          .limit(1);
        if (!current || current.cropKey || canonicalJson(current.anchor) !== canonicalJson(row.anchor))
          return;
        const key = cropKey(row.id);
        await deps.bucket.put(key, object.body, { contentType: object.contentType ?? "image/webp" });
        await tx.update(threads).set({ cropKey: key }).where(eq(threads.id, row.id));
      });
    } catch (error) {
      deps.log.warn("couldn't attach a board crop", { thread: row.id, error: String(error) });
    }
  });
}
