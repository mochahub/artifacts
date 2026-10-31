import sharp from "sharp";

const WIDTH = 480;
const HEIGHT = 320;
/** The 2x render of a frame 1440 wide and 11,000 tall. Sharp's own default is four times this. */
const MAX_PIXELS = 64_000_000;
const FORMATS = new Set(["webp", "png", "jpeg"]);

/** 05, "Crops": a window around the pin, cut from the 2x render, with the pin as a yellow ring. */
export async function cropAround(
  render: Uint8Array,
  x: number,
  y: number,
  maxPixels = MAX_PIXELS,
): Promise<Uint8Array> {
  // The render is whatever the author uploaded: a small file can decode to gigabytes, or be an SVG.
  const image = sharp(render, { limitInputPixels: maxPixels });
  const { width = 0, height = 0, format } = await image.metadata();
  if (!format || !FORMATS.has(format)) throw new Error("A render must be a WebP, PNG or JPEG.");
  const w = Math.min(WIDTH, width);
  const h = Math.min(HEIGHT, height);
  const left = Math.max(0, Math.min(width - w, Math.round(x * width - w / 2)));
  const top = Math.max(0, Math.min(height - h, Math.round(y * height - h / 2)));
  const ring = Buffer.from(
    `<svg width="${w}" height="${h}"><circle cx="${x * width - left}" cy="${y * height - top}" r="16" fill="none" stroke="#ffd84d" stroke-width="6"/></svg>`,
  );
  return image
    .extract({ left, top, width: w, height: h })
    .composite([{ input: ring }])
    .webp({ quality: 82 })
    .toBuffer();
}
