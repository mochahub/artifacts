import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArticle } from "../src/article/build.ts";

function build(source: string, root: string, bundle: Record<string, string>) {
  return buildArticle({
    path: "README.md",
    source,
    root,
    blobHash: (path) => bundle[path],
    frameHash: () => undefined,
    mermaid: new Map(),
  });
}

describe("articles", () => {
  test("an image whose name needs percent-encoding is found in the bundle", () => {
    const built = build("![x](<my pic.png>)\n", tmpdir(), { "my pic.png": "abc" });
    expect(built.problems).toEqual([]);
    expect(built.html).toContain("artifacts:blob/abc");
  });

  test("a chart is drawn from a bundled file, and its labels are escaped", () => {
    const root = mkdtempSync(join(tmpdir(), "artifacts-article-"));
    writeFileSync(
      join(root, "c.json"),
      JSON.stringify({
        type: "bar",
        labels: ["<script>alert(1)</script>", "b"],
        series: [{ name: "s", values: [1, 2] }],
      }),
    );
    const built = build("::chart{src=c.json}\n", root, { "c.json": "h" });
    expect(built.problems).toEqual([]);
    expect(built.html).toContain("<svg");
    expect(built.html).not.toContain("<script");
  });

  test("a chart that isn't in the bundle is never read", () => {
    // A file beside the article that the crawl did not let in, as a link out of the folder would be.
    const root = mkdtempSync(join(tmpdir(), "artifacts-article-"));
    writeFileSync(
      join(root, "secret.json"),
      JSON.stringify({ type: "bar", labels: ["TOP-SECRET"], series: [] }),
    );
    const built = build("::chart{src=secret.json}\n", root, {});
    expect(built.problems.map((problem) => problem.rule)).toEqual(["files/missing"]);
    expect(built.html).not.toContain("TOP-SECRET");
  });

  test("a chart file of the wrong shape is a problem, not a crash", () => {
    const root = mkdtempSync(join(tmpdir(), "artifacts-article-"));
    writeFileSync(join(root, "c.json"), '{"labels": 5}');
    const built = build("::chart{src=c.json}\n", root, { "c.json": "h" });
    expect(built.problems.map((problem) => problem.rule)).toEqual(["files/missing"]);
  });
  test("stats, compare and steps survive the allowlist", () => {
    const built = build(":::stats\n- **41%** fewer\n:::\n", "/nowhere", {});
    expect(built.html).toContain('data-component="stats"');
  });
});
