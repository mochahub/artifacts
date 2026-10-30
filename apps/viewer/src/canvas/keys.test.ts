import { describe, expect, test } from "bun:test";
import { canvasCommand } from "./keys.ts";

const press = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  target: { tagName: "BODY" },
  ...extra,
});

describe("canvas keys", () => {
  test("move around", () => {
    expect(canvasCommand(press("0"))).toBe("fit");
    expect(canvasCommand(press("1"))).toBe("actual");
    expect(canvasCommand(press("n"))).toBe("next");
    expect(canvasCommand(press("p"))).toBe("previous");
    expect(canvasCommand(press("x"))).toBeNull();
  });

  test.each(["metaKey", "ctrlKey", "altKey"])("leave %s shortcuts to the browser", (modifier) => {
    for (const key of ["0", "1", "n", "p"])
      expect(canvasCommand(press(key, { [modifier]: true }))).toBeNull();
  });

  test.each([
    ["a field", { tagName: "INPUT" }],
    ["a text area", { tagName: "TEXTAREA" }],
    ["a select", { tagName: "SELECT" }],
    ["editable text", { tagName: "DIV", isContentEditable: true }],
  ])("stay quiet in %s", (_, target) => {
    expect(canvasCommand(press("n", { target }))).toBeNull();
  });

  test("cope with no target", () => {
    expect(canvasCommand(press("n", { target: null }))).toBe("next");
  });
});
