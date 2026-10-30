import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { cropAround } from "../src/review/crop.ts";

const image = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#123456" } })
    .png()
    .toBuffer();

describe("crops", () => {
  test("cut a window around the pin from an ordinary render", async () => {
    const out = await cropAround(await image(1000, 800), 0.5, 0.5);
    expect(await sharp(out).metadata()).toMatchObject({ format: "webp", width: 480, height: 320 });
  });

  test("refuse an image with more pixels than a render can have", async () => {
    // A solid colour is a few hundred bytes on disk and gigabytes once decoded.
    await expect(cropAround(await image(300, 300), 0.5, 0.5, 50_000)).rejects.toThrow();
    expect((await cropAround(await image(200, 200), 0.5, 0.5, 50_000)).length).toBeGreaterThan(0);
  });

  test("refuse anything but PNG, WebP and JPEG, such as an SVG", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"/>');
    await expect(cropAround(svg, 0.5, 0.5)).rejects.toThrow();
  });
});
