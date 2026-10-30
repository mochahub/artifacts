import { describe, expect, test } from "bun:test";
import { findQuote } from "./quote.ts";

const cut = (text: string, range: [number, number] | null) => (range ? text.slice(range[0], range[1]) : null);

describe("finding a quoted passage", () => {
  test("finds plain words", () => {
    const text = "Ship pairing first, then live view.";
    expect(cut(text, findQuote(text, { exact: "then live view" }))).toBe("then live view");
  });

  test("finds a passage that spans a line break in the source", () => {
    const text = "Ship pairing first,\nthen live view\n  and the rest.";
    // A selection shows the line break as one space.
    expect(cut(text, findQuote(text, { exact: "first, then live view and" }))).toBe(
      "first,\nthen live view\n  and",
    );
  });

  test("finds a passage across a non-breaking space", () => {
    const text = "Pairs in under a minute";
    expect(cut(text, findQuote(text, { exact: "Pairs in under" }))).toBe("Pairs in under");
  });

  test("picks the occurrence whose surroundings match", () => {
    const text = "Done. It works. Then more. It works. Last.";
    const second = findQuote(text, { exact: "It works.", prefix: "Then more. ", suffix: " Last." });
    expect(second).toEqual([text.lastIndexOf("It works."), text.lastIndexOf("It works.") + "It works.".length]);
    const first = findQuote(text, { exact: "It works.", prefix: "Done. ", suffix: " Then more." });
    expect(first?.[0]).toBe(text.indexOf("It works."));
  });

  test("falls back to the first occurrence when the context has changed", () => {
    const text = "It works. And it works.";
    expect(findQuote(text, { exact: "works", prefix: "gone", suffix: "gone" })?.[0]).toBe(3);
  });

  test("returns null for words that aren't there or an empty quote", () => {
    expect(findQuote("Ship pairing", { exact: "live view" })).toBeNull();
    expect(findQuote("Ship pairing", { exact: "  " })).toBeNull();
  });

  test("copes with leading whitespace in the block", () => {
    const text = "\n  Ship pairing";
    expect(cut(text, findQuote(text, { exact: "Ship", prefix: " " }))).toBe("Ship");
  });
});
