import { describe, expect, test } from "bun:test";
import { brightnessUnder, nextReading, nextTone } from "./liquid.ts";

describe("the chrome on scroll", () => {
  test("draws back going down and returns going up", () => {
    expect(nextReading(false, 400, 300, false)).toBe(true);
    expect(nextReading(true, 300, 400, false)).toBe(false);
  });

  test("a small movement changes nothing", () => {
    expect(nextReading(true, 402, 400, false)).toBe(true);
    expect(nextReading(false, 398, 400, false)).toBe(false);
  });

  test("stays out at the top of the page and on the last screen", () => {
    expect(nextReading(true, 40, 20, false)).toBe(false);
    expect(nextReading(true, 900, 800, true)).toBe(false);
  });
});

describe("ink over a picture", () => {
  test("follows the brightness, and paper leaves it to the theme", () => {
    expect(nextTone(null, 0.2)).toBe("dark");
    expect(nextTone(null, 0.8)).toBe("light");
    expect(nextTone("dark", null)).toBeNull();
  });

  test("holds its tone between the thresholds", () => {
    expect(nextTone("dark", 0.5)).toBe("dark");
    expect(nextTone("light", 0.5)).toBe("light");
    expect(nextTone(null, 0.5)).toBeNull();
  });
});

describe("brightness under a bar", () => {
  const half = Float32Array.from({ length: 32 * 15 }, (_, i) => (i < 32 * 7 ? 1 : 0));
  const picture = { top: 100, bottom: 250, height: 150 };

  test("averages only the rows the bar covers", () => {
    expect(brightnessUnder(half, picture, { top: 100, bottom: 160, height: 60 })).toBe(1);
    expect(brightnessUnder(half, picture, { top: 190, bottom: 250, height: 60 })).toBe(0);
  });

  test("ignores a bar that's mostly over paper", () => {
    expect(brightnessUnder(half, picture, { top: 40, bottom: 110, height: 70 })).toBeNull();
    expect(brightnessUnder(half, picture, { top: 300, bottom: 360, height: 60 })).toBeNull();
  });
});
