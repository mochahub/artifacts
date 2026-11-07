import { describe, expect, test } from "bun:test";
import { buildArticle } from "./article.ts";

const build = (source: string, blockIds?: string[]) =>
  buildArticle({
    path: "doc.md",
    source,
    readFile: () => "",
    blobHash: (path) => (path === "a.png" ? "h".repeat(64) : undefined),
    frameHash: () => undefined,
    mermaid: new Map(),
    blockIds,
  });

const SOURCE =
  "# Pricing\n\nOne.\n\n![A chart](a.png)\n\n*The caption*\n\n## Later\n\nTwo.[^1]\n\n[^1]: A note.\n";
const IDS = ["~aaaaaaaaa1", "~aaaaaaaaa2", "~aaaaaaaaa3", "~aaaaaaaaa4", "~aaaaaaaaa5", "~aaaaaaaaa6"];

describe("buildArticle with blockIds (13)", () => {
  test("sets data-block from the ids, keeps heading slugs and the outline", () => {
    const built = build(SOURCE, IDS);
    expect(built.problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(built.html).toContain('<h1 data-block="~aaaaaaaaa1" id="pricing">');
    expect(built.html).toContain('data-block="~aaaaaaaaa3"><img');
    expect(built.outline.map((entry) => entry.id)).toEqual(["pricing", "later"]);
    const keys = built.blocks.map((block) => block.blockKey);
    expect(keys.slice(0, 5)).toEqual(IDS.slice(0, 5));
    // The footnote definition draws nothing in place; GFM's footnotes section gets a per-version key.
    expect(keys.at(-1)).toBe("~aaaaaaaaa5/x1");
  });

  test("without ids, the legacy keys are unchanged", () => {
    expect(
      build(SOURCE)
        .blocks.map((block) => block.blockKey)
        .slice(0, 3),
    ).toEqual(["pricing", "pricing/p1", "pricing/p2"]);
  });

  test("too many, duplicate or malformed ids are article/blocks errors", () => {
    const rule = (ids: string[]) => build("One.\n\nTwo.\n", ids).problems.map((p) => p.rule);
    expect(rule(["~aaaaaaaaa1", "~aaaaaaaaa2", "~aaaaaaaaa3"])).toContain("article/blocks");
    expect(rule(["~aaaaaaaaa1", "~aaaaaaaaa1"])).toContain("article/blocks");
    expect(rule(["~aaaaaaaaa1", "p1"])).toContain("article/blocks");
    expect(rule(["~aaaaaaaaa1", "~aaaaaaaaa2"])).toEqual([]);
  });
});
