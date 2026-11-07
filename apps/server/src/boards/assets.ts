import { createHash } from "node:crypto";
import {
  BOARD_ASSET_MAX,
  BOARD_ASSET_PIXELS_MAX,
  BOARD_ASSETS_BYTES_MAX,
  BOARD_ASSETS_MAX,
  type BoardImage,
} from "@artifacts/schema";
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import sharp from "sharp";
import type { LoadedArtifact } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { boardAssets } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { boardUploadKey } from "../layout.ts";
import { IMMUTABLE, putBlob } from "../publish/blobs.ts";

const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const UNATTACHED_MS = 24 * 60 * 60 * 1000;

/** An APNG decodes as one PNG frame in libvips: its `acTL` chunk before `IDAT` says it's animated. */
export function isAnimatedPng(bytes: Uint8Array) {
  if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    at += 12 + length;
  }
  return false;
}

/** The format the bytes are, by magic number, never by the upload's declared type. */
function sniff(bytes: Uint8Array): BoardImage["type"] | null {
  if (PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * Decode completely, with the pixel ceiling enforced before allocation (14, "Assets and limits"). Never
 * trusts the upload's MIME: magic bytes and the decoder must agree with the declared image exactly.
 */
export async function validateBoardImage(bytes: Uint8Array, image: BoardImage) {
  const invalid = () => new ApiError("invalid", "The uploaded raster does not match its declared image.");
  if (
    bytes.length !== image.bytes ||
    bytes.length > BOARD_ASSET_MAX ||
    createHash("sha256").update(bytes).digest("hex") !== image.hash
  )
    throw invalid();
  if (sniff(bytes) !== image.type || isAnimatedPng(bytes)) throw invalid();
  try {
    const decoder = sharp(bytes, {
      limitInputPixels: BOARD_ASSET_PIXELS_MAX,
      failOn: "warning",
      animated: true,
    });
    const meta = await decoder.metadata();
    if (
      MIME[meta.format as keyof typeof MIME] !== image.type ||
      meta.width !== image.width ||
      meta.height !== image.height ||
      (meta.pages ?? 1) !== 1 ||
      image.width > 8192 ||
      image.height > 8192 ||
      image.width * image.height > BOARD_ASSET_PIXELS_MAX
    )
      throw invalid();
    await decoder.raw().toBuffer();
  } catch {
    throw invalid();
  }
}

const sameImage = (a: BoardImage, b: BoardImage) =>
  a.hash === b.hash &&
  a.bytes === b.bytes &&
  a.width === b.width &&
  a.height === b.height &&
  a.type === b.type;

/**
 * `POST …/board/assets/prepare`: associates the images with this artifact and presigns a PUT for each one
 * not yet validated here. The PUT goes to the artifact's own upload key, never the shared blob, and a
 * hash known in another artifact or organization is neither revealed nor reused.
 */
export async function prepareBoardAssets(
  deps: Deps,
  caller: Caller,
  artifact: LoadedArtifact,
  images: BoardImage[],
) {
  const unique = new Map(images.map((image) => [image.hash, image]));
  if (unique.size !== images.length) throw new ApiError("invalid", "Duplicate image hash.");
  // Pending uploads count against the board's quota while they wait, as stored ones do.
  const [usage] = await deps.db
    .select({
      count: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum((${boardAssets.image}->>'bytes')::bigint), 0)::bigint`,
    })
    .from(boardAssets)
    .where(
      and(
        eq(boardAssets.artifactId, artifact.id),
        isNull(boardAssets.validatedAt),
        notInArray(boardAssets.hash, [...unique.keys()]),
      ),
    );
  const adding = [...unique.values()];
  const count = (usage?.count ?? 0) + adding.length;
  const bytes = Number(usage?.bytes ?? 0) + adding.reduce((sum, image) => sum + image.bytes, 0);
  // Uploads still waiting are bounded like a board's images; what a scene uses is checked when it's used.
  if (count > BOARD_ASSETS_MAX || bytes > BOARD_ASSETS_BYTES_MAX)
    throw new ApiError("too_large", "Too many images are waiting to be uploaded to this board.");
  const person = caller.kind === "person" || caller.kind === "cliToken" ? caller.person.id : null;
  const tokenId = caller.kind === "cliToken" || caller.kind === "orgToken" ? caller.tokenId : null;
  await deps.db
    .insert(boardAssets)
    .values(
      adding.map((image) => ({
        artifactId: artifact.id,
        orgId: artifact.row.orgId,
        hash: image.hash,
        image,
        uploadedBy: person,
        tokenId,
        createdAt: deps.clock.now(),
      })),
    )
    .onConflictDoNothing();
  const rows = await deps.db
    .select()
    .from(boardAssets)
    .where(and(eq(boardAssets.artifactId, artifact.id), inArray(boardAssets.hash, [...unique.keys()])))
    .limit(unique.size);
  const results = [];
  for (const row of rows) {
    if (!sameImage(row.image, unique.get(row.hash) as BoardImage))
      throw new ApiError("conflict", "Image metadata differs from its earlier upload.");
    const signed = row.validatedAt
      ? { url: null, headers: {} }
      : await deps.bucket.presignPut(boardUploadKey(artifact.id, row.hash), {
          contentType: row.image.type,
          contentLength: row.image.bytes,
          cacheControl: IMMUTABLE,
        });
    results.push({ hash: row.hash, ...signed });
  }
  return { images: results };
}

/**
 * `POST …/board/assets/commit`: reads the artifact's own upload, checks it completely, then stores it as a
 * content-addressed blob. A bad upload is removed so it can be sent again; nothing else is told about it.
 */
export async function commitBoardAssets(deps: Deps, artifact: LoadedArtifact, images: BoardImage[]) {
  const rows = await deps.db
    .select()
    .from(boardAssets)
    .where(
      and(
        eq(boardAssets.artifactId, artifact.id),
        inArray(
          boardAssets.hash,
          images.map((image) => image.hash),
        ),
      ),
    )
    .limit(images.length);
  const byHash = new Map(rows.map((row) => [row.hash, row]));
  const fresh: BoardImage[] = [];
  for (const image of images) {
    const row = byHash.get(image.hash);
    if (!row || !sameImage(row.image, image)) throw new ApiError("not_found", "No such upload.");
    if (row.validatedAt) continue;
    const key = boardUploadKey(artifact.id, image.hash);
    const object = await deps.bucket.get(key);
    if (!object) throw new ApiError("invalid", "Image was not uploaded.");
    try {
      await validateBoardImage(object.body, image);
    } catch (error) {
      await deps.bucket.delete(key);
      throw error;
    }
    await putBlob(deps, artifact.row.orgId, object.body, image.type);
    await deps.bucket.delete(key);
    fresh.push(image);
  }
  if (fresh.length) {
    await deps.db
      .update(boardAssets)
      .set({ validatedAt: deps.clock.now() })
      .where(
        and(
          eq(boardAssets.artifactId, artifact.id),
          inArray(
            boardAssets.hash,
            fresh.map((image) => image.hash),
          ),
        ),
      );
  }
  return { images };
}

/** Validated images of this artifact only, by hash. */
export async function validatedBoardAssets(deps: Deps, artifactId: string, hashes: string[]) {
  if (!hashes.length) return [];
  return deps.db
    .select({ image: boardAssets.image })
    .from(boardAssets)
    .where(
      and(
        eq(boardAssets.artifactId, artifactId),
        inArray(boardAssets.hash, hashes),
        isNotNull(boardAssets.validatedAt),
      ),
    )
    .limit(hashes.length);
}

/** Uploads never validated within a day go; the blob stays if anything else uses it (14, jobs sweep). */
export async function sweepBoardUploads(deps: Deps) {
  const cutoff = new Date(deps.clock.now().getTime() - UNATTACHED_MS);
  const gone = await deps.db
    .delete(boardAssets)
    .where(and(isNull(boardAssets.validatedAt), sql`${boardAssets.createdAt} < ${cutoff}`))
    .returning({ artifactId: boardAssets.artifactId, hash: boardAssets.hash });
  for (const row of gone.slice(0, 500)) await deps.bucket.delete(boardUploadKey(row.artifactId, row.hash));
}
