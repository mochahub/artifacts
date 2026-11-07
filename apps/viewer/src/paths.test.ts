import { describe, expect, test } from "bun:test";
import { frameFromHash, frameHash, safeNext } from "./paths.ts";

describe("the frame in an address", () => {
  test.each(["live-view", "poll", "a.b", "Welcome screen", "a/b", "100%", "x&y=z", "é"])(
    "round trips the id %p",
    (key) => {
      expect(frameFromHash(`#${frameHash(key)}`)).toBe(key);
    },
  );

  test("reads a plain link", () => {
    expect(frameFromHash("#frame=live-view")).toBe("live-view");
  });

  test("reads it among other parts", () => {
    expect(frameFromHash("#a=1&frame=poll&b=2")).toBe("poll");
  });

  test.each(["", "#", "#frame=", "#xframe=a", "#frame=%E0%A4%A", "#reframe=1"])(
    "finds no frame in %p",
    (hash) => {
      expect(frameFromHash(hash)).toBeNull();
    },
  );
});

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
