import { expect, test } from "bun:test";
import { buildArticle } from "./article.ts";
import { WIKI_LINKS_MAX } from "./constants.ts";
import { articleLinks, wikiSlug, wikiTarget } from "./wiki.ts";

test("wiki names become short ASCII slugs", () => {
  expect(wikiSlug(" Café, Pricing & Plans! ")).toBe("cafe-pricing-plans");
  expect(wikiSlug("a".repeat(50))).toBe("a".repeat(40));
  expect(wikiSlug("!? 🌱")).toBe("");
});

test("targets resolve across wikis and reject reserved names", () => {
  expect(wikiTarget("other-wiki/Café", "brain")).toEqual({ project: "other-wiki", slug: "cafe" });
  expect(wikiTarget("Rules", "brain")).toEqual({ project: "brain", slug: "rules" });
  expect(wikiTarget("api", "brain")).toBeNull();
  expect(wikiTarget("api/Page", "brain")).toBeNull();
  expect(wikiTarget("!!!", "brain")).toBeNull();
});

function article(source: string, project?: string) {
  return buildArticle({
    source,
    project,
    path: "page.md",
    readFile: () => "",
    blobHash: () => undefined,
    frameHash: () => undefined,
    mermaid: new Map(),
  }).html;
}

test("articles link names and labels, including table cells", () => {
  const html = article(
    "[[Pricing & Plans]] [[other/Team|people]]\n\n| Topic |\n| --- |\n| [[Café]] |",
    "brain",
  );
  expect(html).toContain('href="/brain/pricing-plans"');
  expect(html).toContain('href="/other/team">people</a>');
  expect(html).toContain('href="/brain/cafe"');
});

test("code and existing links stay untouched, and a project is required", () => {
  const html = article("`[[Code]]` [existing [[Name]]](/brain/existing)", "brain");
  expect(html).toContain("[[Code]]");
  expect(html).not.toContain('href="/brain/name"');
  expect(article("[[Name]]")).toContain("[[Name]]");
  expect(article("[[Name]]")).not.toContain('href="/');
});

test("article links deduplicate, ignore external and reserved routes, and cap results", () => {
  expect(
    articleLinks(
      '<a href="/brain/page">a</a><a href="/brain/page?x">b</a><a href="https://example.com/brain/page">c</a><a href="/api/page">d</a>',
    ),
  ).toEqual(["brain/page"]);
  const html = Array.from({ length: WIKI_LINKS_MAX + 5 }, (_, i) => `<a href="/brain/page-${i}">x</a>`).join(
    "",
  );
  expect(articleLinks(html)).toHaveLength(WIKI_LINKS_MAX);
});
