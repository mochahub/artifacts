import { describe, expect, test } from "bun:test";
import { ApiFailure, isMissing } from "./api.ts";

const fail = (status: number) => new ApiFailure(status, "x", "x");

describe("which failures replace a screen", () => {
  test.each([400, 403, 404, 410])("%i means there's nothing here", (status) => {
    expect(isMissing(fail(status))).toBe(true);
  });

  test.each([401, 429, 500, 502, 503])("%i leaves what's on screen alone", (status) => {
    expect(isMissing(fail(status))).toBe(false);
  });

  test("no failure is no problem", () => {
    expect(isMissing(null)).toBe(false);
  });
});
