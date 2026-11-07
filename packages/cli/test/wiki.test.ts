import { expect, test } from "bun:test";
import { Manifest, WikiSpace } from "@artifacts/schema";
import { GUIDES, SKILL_FILES } from "../../../skill/index.ts";
import { linksSummary, wikiSummary } from "../src/commands/wiki.ts";
import { publishBody } from "../src/publish.ts";
import type { RenderResult } from "../src/render/render.ts";
import { cli, sandbox } from "./sandbox.ts";

test("wiki help lists each operation and bad arguments stop before sign-in", async () => {
  const box = sandbox();
  const help = await cli(["wiki", "--help"], box.env);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("wiki create <slug>");
  expect(help.stdout).toContain("wiki show <slug>");
  expect(help.stdout).toContain("wiki links <project/slug>");
  for (const args of [
    ["show", "../x"],
    ["links", "a/b/c"],
    ["create"],
    ["unknown", "brain"],
    ["show", "brain", "extra"],
    ["show", "brain", "--personal"],
  ]) {
    expect((await cli(["wiki", ...args], box.env)).code).toBe(2);
  }
});

test("wiki output shows summaries, trust and actionable findings", () => {
  const space = WikiSpace.parse({
    project: { slug: "brain", name: "Brain", personal: true, canPublish: true, canShare: true },
    rules: null,
    pages: [],
    sources: [
      {
        slug: "clip",
        title: "Clip",
        summary: "A web source",
        tags: [],
        role: "source",
        untrusted: true,
        sources: [],
        origin: null,
        version: 1,
        updatedAt: new Date().toISOString(),
        publishedBy: "Person",
        agent: null,
        backlinks: 0,
        open: 0,
      },
    ],
    log: [],
    garden: [{ kind: "wanted", slug: "topic", message: "Write this page.", refs: [] }],
  });
  const output = wikiSummary(space).join("\n");
  expect(output).toContain("Brain (personal)");
  expect(output).toContain("No rules page yet.");
  expect(output).toContain("clip  Clip [untrusted]: A web source");
  expect(output).toContain("wanted topic: Write this page.");
  expect(
    linksSummary({
      wiki: true,
      role: "page",
      origin: null,
      untrusted: false,
      outgoing: [
        { project: "brain", slug: "topic", title: null, summary: null, exists: false, untrusted: false },
      ],
      backlinks: [],
      sources: [],
    }).join("\n"),
  ).toContain("brain/topic [wanted]");
});

test("wiki guide ships in the skill and hosted guide registry", () => {
  expect(GUIDES.wiki).toBe(SKILL_FILES["references/wiki.md"]);
  expect(GUIDES.wiki).toContain("## GARDEN");
});

test("empty wiki sections say none", () => {
  expect(
    wikiSummary({
      project: { slug: "brain", name: "Brain", personal: false, canPublish: true, canShare: true },
      rules: null,
      pages: [],
      sources: [],
      garden: [],
      log: [],
    }),
  ).toEqual([
    "Brain",
    "Rules",
    "  No rules page yet.",
    "Pages",
    "  none",
    "Sources",
    "  none",
    "Garden",
    "  none",
  ]);
});

test("links show the artifact's role, trust and origin even with no links", () => {
  expect(
    linksSummary({
      wiki: true,
      role: "source",
      untrusted: true,
      origin: "https://example.com/report",
      outgoing: [],
      backlinks: [],
      sources: [],
    }),
  ).toEqual([
    "Role: source [untrusted] (https://example.com/report)",
    "Links",
    "  none",
    "Linked from",
    "  none",
    "Sources",
    "  none",
  ]);
});

test("links print no wiki sections for an ordinary artifact", () => {
  expect(
    linksSummary({
      wiki: false,
      role: "page",
      untrusted: false,
      origin: null,
      outgoing: [],
      backlinks: [],
      sources: [],
    }),
  ).toEqual([]);
});

test("links preserve cited sources' origins and support older servers without them", () => {
  expect(
    linksSummary({
      wiki: true,
      role: "page",
      untrusted: true,
      origin: null,
      outgoing: [],
      backlinks: [],
      sources: [
        {
          project: "brain",
          slug: "clip",
          title: "Clip",
          summary: "A web source",
          exists: true,
          untrusted: true,
          origin: "https://example.com/report",
        },
        { project: "brain", slug: "notes", title: "Notes", summary: null, exists: true, untrusted: false },
      ],
    }),
  ).toEqual([
    "Role: page [untrusted]",
    "Links",
    "  none",
    "Linked from",
    "  none",
    "Sources",
    "  brain/clip  Clip [untrusted]: A web source (https://example.com/report)",
    "  brain/notes  Notes",
  ]);
});

test("publish and pack commit metadata preserves wiki fields and clears absent metadata", () => {
  const rendered: RenderResult = {
    backendHash: null,
    files: new Map(),
    renders: new Map(),
    pages: [],
    frames: [],
    blocks: [],
    problems: [],
    contactSheet: "",
  };
  const manifest = Manifest.parse({
    project: "brain",
    slug: "topic",
    title: "Topic",
    summary: "A topic",
    pages: [{ id: "main", kind: "article", src: "doc.md" }],
    wiki: { role: "page", sources: ["notes"] },
  });
  expect(publishBody(rendered, manifest, { notes: {} }).commit.wiki).toEqual(manifest.wiki ?? null);
  delete manifest.wiki;
  expect(publishBody(rendered, manifest, { notes: {} }).commit.wiki).toBeNull();
});
