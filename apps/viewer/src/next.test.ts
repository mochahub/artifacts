import { describe, expect, test } from "bun:test";
import { safeNext } from "./next.ts";

describe("where sign-in sends you next", () => {
  test.each(["/", "/camerabuddy/roadmap/plan", "/camerabuddy/roadmap/plan?c=2", "/settings/sign-in"])(
    "follows the path %p",
    (value) => {
      expect(safeNext(value)).toBe(value);
    },
  );

  test.each([
    undefined,
    "",
    "https://evil.test/",
    "//evil.test",
    "/\\evil.test",
    "/\t/evil.test",
    "/\n/evil.test",
    "/\r/evil.test",
    "/ /evil.test",
    "javascript:alert(1)",
    "evil.test",
    "@evil.test",
  ])("goes home instead of %p", (value) => {
    expect(safeNext(value)).toBe("/");
  });
});
