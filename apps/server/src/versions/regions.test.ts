import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { diffRegions } from "./regions.ts";

const image = (marks: { left: number; top: number }[], width = 400, height = 800) =>
  sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
    .composite(
      marks.map((mark) => ({
        input: { create: { width: 60, height: 60, channels: 3 as const, background: "#000000" } },
        ...mark,
      })),
    )
    .webp({ lossless: true })
    .toBuffer();

describe("diffRegions", () => {
  test("the same picture has none", async () => {
    const same = await image([{ left: 10, top: 10 }]);
    expect(await diffRegions(same, same)).toEqual([]);
  });

  test("finds each changed area, in fractions", async () => {
    const before = await image([]);
    const after = await image([
      { left: 40, top: 80 },
      { left: 300, top: 700 },
    ]);
    const regions = await diffRegions(before, after);
    expect(regions).toHaveLength(2);
    const top = regions.find((region) => region.y < 0.5);
    expect(top?.x).toBeCloseTo(0.1, 1);
    expect(top?.y).toBeCloseTo(0.1, 1);
    expect(top?.w).toBeGreaterThan(0.1);
    expect(top?.w).toBeLessThan(0.25);
  });

  test("a different shape counts as all of it", async () => {
    expect(await diffRegions(await image([]), await image([], 400, 400))).toEqual([
      { x: 0, y: 0, w: 1, h: 1 },
    ]);
  });
});
