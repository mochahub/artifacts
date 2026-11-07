import { BOARD_ASSET_MAX, BOARD_ASSET_PIXELS_MAX } from "@artifacts/schema";
import type { BoardImage } from "@artifacts/schema/boards";
import { sha256 } from "../hash.ts";
import { UsageError } from "../output.ts";

const u32 = (b: Uint8Array, at: number) =>
  ((b[at] ?? 0) << 24) + ((b[at + 1] ?? 0) << 16) + ((b[at + 2] ?? 0) << 8) + (b[at + 3] ?? 0);
const le16 = (b: Uint8Array, at: number) => (b[at] ?? 0) + ((b[at + 1] ?? 0) << 8);
const le24 = (b: Uint8Array, at: number) => le16(b, at) + ((b[at + 2] ?? 0) << 16);
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** Width and height from the header alone, for the kinds a board takes. Null for anything else. */
function dimensions(
  bytes: Uint8Array,
): { type: BoardImage["type"]; width: number; height: number } | "animated" | null {
  if (bytes.length > 24 && ascii(bytes, 1, 3) === "PNG" && bytes[0] === 0x89) {
    // An animated PNG announces itself with acTL before the first image data.
    for (let at = 8; at + 8 <= bytes.length; ) {
      const kind = ascii(bytes, at + 4, 4);
      if (kind === "acTL") return "animated";
      if (kind === "IDAT") break;
      at += 12 + u32(bytes, at);
    }
    return { type: "image/png", width: u32(bytes, 16), height: u32(bytes, 20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 9 < bytes.length; ) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1] ?? 0;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return {
          type: "image/jpeg",
          height: (bytes[at + 5] ?? 0) * 256 + (bytes[at + 6] ?? 0),
          width: (bytes[at + 7] ?? 0) * 256 + (bytes[at + 8] ?? 0),
        };
      at += 2 + (bytes[at + 2] ?? 0) * 256 + (bytes[at + 3] ?? 0);
    }
    return null;
  }
  if (bytes.length > 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const kind = ascii(bytes, 12, 4);
    if (kind === "VP8X") {
      if (((bytes[20] ?? 0) & 0x02) !== 0) return "animated";
      return { type: "image/webp", width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 };
    }
    if (kind === "VP8 ")
      return { type: "image/webp", width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff };
    if (kind === "VP8L") {
      const bits =
        (bytes[21] ?? 0) + ((bytes[22] ?? 0) << 8) + ((bytes[23] ?? 0) << 16) + (bytes[24] ?? 0) * 2 ** 24;
      return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/**
 * A board's image, read locally the way the server will read it: PNG, JPEG or still WebP, within the
 * size and pixel limits. The server decodes it for real; this only spares an upload that can't pass.
 */
export function boardImage(bytes: Uint8Array, name: string): BoardImage {
  if (bytes.length === 0) throw new UsageError(`${name} is empty.`);
  if (bytes.length > BOARD_ASSET_MAX)
    throw new UsageError(
      `${name} is ${Math.ceil(bytes.length / 1024 / 1024)} MiB; a board image is at most ${BOARD_ASSET_MAX / 1024 / 1024} MiB.`,
    );
  const found = dimensions(bytes);
  if (found === "animated") throw new UsageError(`${name} is animated. A board takes still pictures only.`);
  if (!found) throw new UsageError(`${name} isn't a PNG, JPEG or WebP picture. SVG and GIF aren't accepted.`);
  const { width, height } = found;
  if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > BOARD_ASSET_PIXELS_MAX)
    throw new UsageError(
      `${name} is ${width} by ${height}: at most 8192 on a side and ${BOARD_ASSET_PIXELS_MAX / 1_000_000} million pixels.`,
    );
  return { hash: sha256(bytes), type: found.type, bytes: bytes.length, width, height };
}

export const imageExtension = (type: BoardImage["type"]) =>
  ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" })[type];
