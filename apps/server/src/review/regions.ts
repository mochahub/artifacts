import sharp from "sharp";

export type Region = { x: number; y: number; w: number; h: number };

const WIDTH = 320;
const CELL = 8;
const MAX_REGIONS = 12;
/** Per channel, out of 255: smaller differences are compression, not a change. */
const THRESHOLD = 24;

/** Cells that differ, grouped with any cell within two cells of them, as 0–1 boxes (03). */
export async function diffRegions(before: Uint8Array, after: Uint8Array): Promise<Region[]> {
  const size = await sharp(before).metadata();
  const other = await sharp(after).metadata();
  const ratio = (a: typeof size) => (a.height ?? 1) / (a.width ?? 1);
  if (Math.abs(ratio(size) - ratio(other)) > 0.01) return [{ x: 0, y: 0, w: 1, h: 1 }];
  const height = Math.max(CELL, Math.round(WIDTH * ratio(size)));
  const pixels = (image: Uint8Array) =>
    sharp(image).resize(WIDTH, height, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const [a, b] = await Promise.all([pixels(before), pixels(after)]);

  const cols = Math.ceil(WIDTH / CELL);
  const rows = Math.ceil(height / CELL);
  const changed = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const at = (y * WIDTH + x) * 3;
      const delta = Math.max(
        Math.abs((a[at] as number) - (b[at] as number)),
        Math.abs((a[at + 1] as number) - (b[at + 1] as number)),
        Math.abs((a[at + 2] as number) - (b[at + 2] as number)),
      );
      if (delta > THRESHOLD) changed[Math.floor(y / CELL) * cols + Math.floor(x / CELL)] = 1;
    }
  }

  const seen = new Uint8Array(cols * rows);
  const boxes: { left: number; top: number; right: number; bottom: number; cells: number }[] = [];
  for (let start = 0; start < changed.length; start++) {
    if (!changed[start] || seen[start]) continue;
    const box = { left: cols, top: rows, right: 0, bottom: 0, cells: 0 };
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const cell = stack.pop() as number;
      const cx = cell % cols;
      const cy = Math.floor(cell / cols);
      box.left = Math.min(box.left, cx);
      box.top = Math.min(box.top, cy);
      box.right = Math.max(box.right, cx + 1);
      box.bottom = Math.max(box.bottom, cy + 1);
      box.cells += 1;
      for (let ny = Math.max(0, cy - 2); ny <= Math.min(rows - 1, cy + 2); ny++) {
        for (let nx = Math.max(0, cx - 2); nx <= Math.min(cols - 1, cx + 2); nx++) {
          const next = ny * cols + nx;
          if (changed[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    boxes.push(box);
  }
  return boxes
    .sort((p, q) => q.cells - p.cells)
    .slice(0, MAX_REGIONS)
    .map((box) => ({
      x: box.left / cols,
      y: box.top / rows,
      w: (box.right - box.left) / cols,
      h: (box.bottom - box.top) / rows,
    }));
}
