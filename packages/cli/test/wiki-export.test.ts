import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { rewriteLocalFiles } from "../src/commands/wiki.ts";
import { sha256 } from "../src/hash.ts";
import { cli, sandbox } from "./run.ts";

const NOW = "2026-11-07T10:00:00.000Z";
const id = (n: number) => `6f1c7c9e-3a52-4d4e-9d0a-2b7d6c5a1e1${n}`;

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const CHART = new TextEncoder().encode('{"type":"bar","labels":["a"],"series":[{"name":"s","values":[1]}]}');
const SPACED = new Uint8Array([9, 9, 9]);

const entry = (slug: string, role: "page" | "source" = "page") => ({
  slug,
  title: slug,
  summary: `About ${slug}`,
  tags: [],
  role,
  untrusted: false,
  sources: [],
  origin: null,
  version: 3,
  updatedAt: NOW,
  publishedBy: "Sam",
  agent: null,
  backlinks: 0,
  open: 0,
});
const space = {
  project: {
    slug: "brain",
    name: "Brain",
    audience: { kind: "org", label: "Everyone" },
    guidance: { edits: "suggestion", text: "" },
    canPublish: true,
    canShare: true,
  },
  rules: entry("rules"),
  pages: [entry("pricing"), entry("canvas")],
  sources: [entry("interview", "source")],
  log: [],
  garden: [],
};

/** The files each page's bundle holds, with the page's own Markdown source at `src`. */
const bundles: Record<string, { src: string; files: Record<string, Uint8Array> }> = {
  rules: { src: "README.md", files: {} },
  pricing: {
    src: "docs/page.md",
    files: { "docs/img/plan.png": PNG, "docs/data/chart.json": CHART, "docs/my pic.png": SPACED },
  },
  canvas: { src: "README.md", files: {} },
  interview: { src: "README.md", files: { "notes.png": PNG } },
};
const markdown: Record<string, string> = {
  rules: "---\ntitle: rules\n---\nBe kind. See [[pricing]].\n",
  pricing: [
    "---\ntitle: pricing\nsummary: About pricing\n---",
    "![Plan](img/plan.png)",
    "![Spaced](<my pic.png>)",
    "See [the site](https://example.com/img/plan.png) and [top](#top) and [rules](rules.md).",
    "::chart{src=data/chart.json}",
    "![Missing](img/nope.png)",
    "",
  ].join("\n\n"),
  interview: "---\ntitle: interview\n---\n![Notes](notes.png)\n",
};

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const base = url.origin;
    if (url.pathname === "/api/wikis/brain") return Response.json(space);
    const by = url.pathname.match(/^\/api\/artifacts\/by-slug\/brain\/([a-z-]+)$/);
    if (by) {
      const n = ["rules", "pricing", "canvas", "interview"].indexOf(by[1] as string);
      return Response.json({
        id: id(n),
        project: "brain",
        slug: by[1],
        title: by[1],
        cover: { title: "x" },
        pageCount: 1,
        latestVersion: 3,
        status: { kind: "not_reviewed" },
        counts: { open: 0, repliesToYou: 0, changedFrames: 0 },
        publishedBy: "Sam",
        agent: null,
        publishedAt: NOW,
        archivedAt: null,
        visibility: "org",
        publisherId: id(0),
        hasBackend: false,
        pages: [],
        decision: null,
        permissions: { comment: true, manage: true, share: true, delete: true, purge: true },
      });
    }
    const exp = url.pathname.match(/^\/api\/artifacts\/(.+)\/export\.md$/);
    if (exp) {
      const slug = ["rules", "pricing", "canvas", "interview"][Number(exp[1]?.slice(-1))] as string;
      // A canvas has no Markdown to give.
      if (slug === "canvas")
        return Response.json(
          {
            error: {
              code: "conflict",
              message: "Only articles have Markdown.",
              details: { reason: "not_article" },
            },
          },
          { status: 409 },
        );
      return new Response(markdown[slug], { headers: { "Content-Type": "text/markdown" } });
    }
    const bundle = url.pathname.match(/^\/api\/library\/projects\/brain\/([a-z-]+)\/bundle$/);
    if (bundle) {
      const { src, files } = bundles[bundle[1] as string] as (typeof bundles)[string];
      return Response.json({
        project: "brain",
        slug: bundle[1],
        version: 3,
        manifest: { pages: [{ key: "doc", kind: "article", src }] },
        rebuilt: false,
        files: [
          {
            path: src,
            hash: sha256(new TextEncoder().encode(src)),
            size: 1,
            type: "text/markdown",
            url: `${base}/blob/none`,
          },
          ...Object.entries(files).map(([path, body]) => ({
            path,
            hash: sha256(body),
            size: body.length,
            type: "application/octet-stream",
            url: `${base}/blob/${sha256(body)}`,
          })),
        ],
      });
    }
    const blob = url.pathname.match(/^\/blob\/([0-9a-f]+)$/);
    if (blob) {
      const body = [PNG, CHART, SPACED].find((b) => sha256(b) === blob[1]);
      return body ? new Response(body) : new Response("gone", { status: 404 });
    }
    return new Response("no", { status: 404 });
  },
});
afterAll(() => server.stop(true));

const box = sandbox();
const env = { ...box.env, ARTIFACTS_URL: `http://127.0.0.1:${server.port}`, ARTIFACTS_TOKEN: "art_test" };

function tree(root: string, at = ""): string[] {
  return readdirSync(join(root, at)).flatMap((name) => {
    const path = at ? `${at}/${name}` : name;
    return statSync(join(root, path)).isDirectory() ? tree(root, path) : [path];
  });
}

describe("wiki export", () => {
  test("writes every page and source as Markdown, with the files its links need beside it", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "artifacts-wiki-export-")), "brain-md");
    const result = await cli(["wiki", "export", "brain", out, "--json"], env);
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({ wiki: "brain", pages: 3, files: 4 });
    expect(summary.skipped).toEqual([{ slug: "canvas", reason: "Only articles have Markdown." }]);

    expect(tree(out).sort()).toEqual([
      "interview.md",
      "interview/notes.png",
      "pricing.md",
      "pricing/docs/data/chart.json",
      "pricing/docs/img/plan.png",
      "pricing/docs/my pic.png",
      "rules.md",
    ]);
    expect(readFileSync(join(out, "rules.md"), "utf8")).toBe(markdown.rules as string);
    expect(readFileSync(join(out, "pricing/docs/img/plan.png"))).toEqual(Buffer.from(PNG));

    // Every relative link in every exported page resolves to a file in the tree, except the one that was dead before.
    const dead: string[] = [];
    for (const name of tree(out).filter((p) => p.endsWith(".md"))) {
      const text = readFileSync(join(out, name), "utf8");
      const dests = [
        ...text.matchAll(/\]\((<[^>]+>|[^)\s]+)\)/g),
        ...text.matchAll(/src=("[^"]+"|[^\s}]+)/g),
      ].map((m) => (m[1] as string).replace(/^[<"]|[>"]$/g, ""));
      for (const dest of dests) {
        if (/^([a-z]+:|#)/.test(dest)) continue;
        if (!existsSync(join(out, posix.normalize(posix.join(dirname(name), dest)))))
          dead.push(`${name} -> ${dest}`);
      }
    }
    expect(dead).toEqual(["pricing.md -> img/nope.png"]);
  });

  test("refuses a folder that isn't empty, and wrong arguments exit 2", async () => {
    const full = mkdtempSync(join(tmpdir(), "artifacts-wiki-export-"));
    await Bun.write(join(full, "keep.txt"), "x");
    const refused = await cli(["wiki", "export", "brain", full], env);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("isn't empty");
    for (const args of [
      ["export", "brain"],
      ["export", "../x", full],
      ["export", "brain", full, "extra"],
      ["show", "brain", full],
    ])
      expect((await cli(["wiki", ...args], env)).code).toBe(2);
  });
});

describe("rewriteLocalFiles", () => {
  const files = new Set(["docs/img/a.png", "docs/b c.png", "docs/data/c.json", "top.png"]);
  const rewrite = (md: string) => rewriteLocalFiles(md, "p", "docs", files);

  test("points links, images and chart sources at the copies, resolved from the page's folder", () => {
    const { markdown: md, used } = rewrite(
      '![a](img/a.png "t") [b](<b c.png>) ::chart{src=data/c.json} ::chart{src="data/c.json"} ![up](../top.png)',
    );
    expect(md).toBe(
      '![a](p/docs/img/a.png "t") [b](<p/docs/b c.png>) ::chart{src=p/docs/data/c.json} ::chart{src="p/docs/data/c.json"} ![up](p/top.png)',
    );
    expect([...used].sort()).toEqual(["docs/b c.png", "docs/data/c.json", "docs/img/a.png", "top.png"]);
  });

  test("leaves addresses, fragments, absolute paths, escapes and unknown files alone", () => {
    const md =
      "[x](https://e.com/img/a.png) [y](#img/a.png) [z](/img/a.png) [w](../../etc/passwd) [v](img/zzz.png) [u](mailto:a@b.c)";
    expect(rewrite(md)).toEqual({ markdown: md, used: new Set() });
  });

  test("keeps a query or fragment out of the lookup and percent-encoding decoded", () => {
    expect(rewrite("[a](img/a.png#x) [b](b%20c.png)").used).toEqual(
      new Set(["docs/img/a.png", "docs/b c.png"]),
    );
  });
});
