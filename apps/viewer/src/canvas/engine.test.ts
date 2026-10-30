import { describe, expect, test } from "bun:test";
import { arrange, clampScale, fitScale } from "./engine.ts";

const insets = { top: 84, bottom: 96, side: 16 };

describe("scale limits", () => {
  test("stay inside 0.05 to 8", () => {
    expect(clampScale(100, 1)).toBe(8);
    expect(clampScale(0.001, 1)).toBe(0.05);
    expect(clampScale(Number.POSITIVE_INFINITY, 1)).toBe(8);
    expect(clampScale(2, 1)).toBe(2);
  });

  test("a NaN from a zero distance keeps the current scale", () => {
    // Two touches on one point: 0 * 0 / 0.
    expect(clampScale((1 * 0) / 0, 1.5)).toBe(1.5);
  });
});

describe("fitting a rectangle on screen", () => {
  test("scales to the tighter side", () => {
    expect(fitScale({ width: 393, height: 852 }, { w: 1000, h: 400 }, insets)).toBeCloseTo(361 / 1000);
  });

  test("never goes past the zoom limit for a small frame", () => {
    expect(fitScale({ width: 1440, height: 900 }, { w: 10, h: 10 }, insets)).toBe(8);
  });

  test("a box shorter than its insets doesn't flip the canvas over", () => {
    // Landscape on a phone with the keyboard up: 170 high, 180 of insets.
    const s = fitScale({ width: 600, height: 170 }, { w: 300, h: 600 }, insets);
    expect(s).toBeGreaterThan(0);
    expect(s).toBe(0.05);
  });

  test("a box narrower than its sides doesn't either", () => {
    expect(fitScale({ width: 20, height: 800 }, { w: 300, h: 600 }, insets)).toBe(0.05);
  });

  test("a rectangle with no size is finite", () => {
    expect(fitScale({ width: 393, height: 852 }, { w: 0, h: 0 }, insets)).toBe(8);
    expect(Number.isFinite(fitScale({ width: 32, height: 180 }, { w: 0, h: 0 }, insets))).toBe(true);
  });
});

describe("arranging boards", () => {
  const board = (key: string, w: number, h: number) => ({ key, title: key, x: 0, y: 0, w, h });

  test("an empty canvas has nothing to place", () => {
    expect(arrange([], [], 2)).toEqual({ boards: [], frames: [] });
    expect(arrange([], [], 1)).toEqual({ boards: [], frames: [] });
  });

  test("wraps into two columns on a tall screen", () => {
    const { boards } = arrange([board("a", 100, 50), board("b", 100, 80), board("c", 100, 40)], [], 2);
    expect(boards.map((entry) => [entry.x, entry.y])).toEqual([
      [0, 0],
      [220, 0],
      [0, 260],
    ]);
  });
});
