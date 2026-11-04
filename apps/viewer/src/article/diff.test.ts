import { describe, expect, test } from "bun:test";
import { align, diff, likeness, tokens } from "./diff.ts";

const show = (a: string, b: string) => {
  const before = tokens(a);
  const after = tokens(b);
  return diff(before, after)
    .map((op) => (op.op === "same" ? after[op.b] : op.op === "add" ? `+${after[op.b]}` : `-${before[op.a]}`))
    .join("");
};

const block = (text: string, tag = "P") => ({ key: `${tag}|${text}`, tag, text });

describe("word changes", () => {
  test("marks an added word and a removed one", () => {
    expect(show("muted steel and bone", "muted steel, oxblood and bone")).toBe(
      "muted steel+,+ +oxblood and bone",
    );
    expect(show("about 44 px tall", "about px tall")).toBe("about -44- px tall");
  });

  test("a line break in the source is not a change", () => {
    expect(show("one\ntwo", "one two")).toBe("one two");
  });

  test("identical text has no changes", () => {
    expect(diff(tokens("a b c"), tokens("a b c")).every((op) => op.op === "same")).toBe(true);
  });
});

describe("lining up blocks", () => {
  test("an inserted paragraph shifts nothing after it", () => {
    const steps = align(
      [block("one"), block("two"), block("three")],
      [block("one"), block("new"), block("two"), block("three")],
    );
    expect(steps.map((s) => s.kind)).toEqual(["same", "add", "same", "same"]);
  });

  test("a reworded paragraph is an edit, a rewritten one is removed and added", () => {
    expect(
      align([block("the quick brown fox jumps")], [block("the quick red fox jumps")]).map((s) => s.kind),
    ).toEqual(["edit"]);
    expect(align([block("alpha beta gamma")], [block("something else")]).map((s) => s.kind)).toEqual([
      "remove",
      "add",
    ]);
  });

  test("a paragraph is never an edit of a heading", () => {
    expect(align([block("Colour", "H2")], [block("Colour", "P")]).map((s) => s.kind)).toEqual([
      "remove",
      "add",
    ]);
  });

  test("punctuation changes on its own", () => {
    expect(show("the pipeline.", "the pipeline: rigs")).toBe("the pipeline-.+:+ +rigs");
  });

  test("a table row that keeps its label is an edit however much it changed", () => {
    const row = (lead: string, text: string) => ({ key: text, tag: "TR", text, lead });
    expect(align([row("Edges", "Edges Black outline")], [row("Edges", "Edges No outline at all")])).toEqual([
      { kind: "edit", a: 0, b: 0 },
    ]);
  });

  test("a removed last paragraph still shows", () => {
    expect(align([block("one"), block("two")], [block("one")]).map((s) => s.kind)).toEqual([
      "same",
      "remove",
    ]);
  });

  test("likeness counts shared words", () => {
    expect(likeness("a b c d", "a b c d")).toBe(1);
    expect(likeness("a b", "c d")).toBe(0);
  });
});
