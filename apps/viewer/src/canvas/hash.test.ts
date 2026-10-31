import { describe, expect, test } from "bun:test";
import { frameFromHash, frameHash } from "./hash.ts";

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
