import { expect, test } from "bun:test";
import { ApiFailure } from "../api.ts";
import { safeError, statusLabel, usd } from "./common.ts";

// Exhaustive error/status formatting belongs here; the browser retains the wiring check.
test.each([
  [401, "This is unavailable or you no longer have access."],
  [403, "This is unavailable or you no longer have access."],
  [404, "This is unavailable or you no longer have access."],
  [409, "This changed elsewhere. Refresh before trying again."],
  [429, "Too many requests. Try again later."],
  [500, "The request could not be completed. Check your settings and try again."],
])("safeError hides upstream bodies for HTTP %i", (status, expected) => {
  expect(safeError(new ApiFailure(status, "private-code", "provider-secret", { key: "source-secret" }))).toBe(
    expected,
  );
});

test("unexpected failures cannot expose provider messages", () => {
  for (const error of [new Error("provider-secret"), "provider-secret", null, { message: "source-secret" }]) {
    expect(safeError(error)).toBe("The request could not be completed. Check your settings and try again.");
  }
});

test("run labels and microdollar amounts use reader-facing units", () => {
  expect(statusLabel("waiting_human")).toBe("Needs human review");
  expect(statusLabel("budget_exhausted")).toBe("Budget exhausted");
  expect(statusLabel("done")).toBe("Processed");
  expect(statusLabel("succeeded")).toBe("Completed");
  expect(statusLabel("new_state")).toBe("new state");
  expect(usd(0)).toBe("$0.00");
  expect(usd(1)).toBe("$0.000001");
  expect(usd(25000000)).toBe("$25.00");
});
