import sharp from "sharp";

const WIDTH = 480;
const HEIGHT = 320;

/** 05, "Crops": a window around the pin, cut from the 2x render, with the pin as a yellow ring. */
export async function cropAround(render: Uint8Array, x: number, y: number): Promise<Uint8Array> {
  const image = sharp(render);
  const { width = 0, height = 0 } = await image.metadata();
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
