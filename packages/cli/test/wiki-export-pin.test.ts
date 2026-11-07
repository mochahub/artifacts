import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/hash.ts";
import { cli, sandbox } from "./run.ts";

/**
 * A quiet checkpoint can land between `artifacts wiki export`'s two requests for a page. Both ask for the
 * version the artifact answer named, so the Markdown and its files come from one version.
 */
const NOW = "2026-11-07T10:00:00.000Z";
const ID = "6f1c7c9e-3a52-4d4e-9d0a-2b7d6c5a1e10";
const PNG = new Uint8Array([137, 80, 78, 71, 3]);
const asked: string[] = [];
const page = {
  slug: "pricing",
  title: "pricing",
  summary: "About",
  tags: [],
  role: "page",
  untrusted: false,
  sources: [],
  origin: null,
  version: 3,
  updatedAt: NOW,
  publishedBy: "Sam",
  agent: null,
  backlinks: 0,
  open: 0,
};

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    asked.push(`${url.pathname}${url.search}`);
    // Unpinned, these answer the newer version 4: what a checkpoint in between would give.
    const version = url.searchParams.get("version") ?? "4";
    if (url.pathname === "/api/wikis/brain")
      return Response.json({
        project: {
          slug: "brain",
          name: "Brain",
          audience: { kind: "org", label: "Everyone" },
          guidance: { edits: "suggestion", text: "" },
          canPublish: true,
          canShare: true,
        },
        rules: null,
        pages: [page],
        sources: [],
        log: [],
        garden: [],
      });
    if (url.pathname === "/api/artifacts/by-slug/brain/pricing")
      return Response.json({
        id: ID,
        project: "brain",
        slug: "pricing",
        title: "pricing",
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
        publisherId: ID,
        hasBackend: false,
        pages: [],
        decision: null,
        permissions: { comment: true, manage: true, share: true, delete: true, purge: true },
      });
    if (url.pathname === `/api/artifacts/${ID}/export.md`)
      return new Response(`---\ntitle: pricing\n---\nVersion ${version}. ![Plan](v${version}.png)\n`, {
        headers: { "Content-Type": "text/markdown" },
      });
    if (url.pathname === "/api/library/projects/brain/pricing/bundle")
      return Response.json({
        project: "brain",
        slug: "pricing",
        version: Number(version),
        manifest: { pages: [{ key: "doc", kind: "article", src: "doc.md" }] },
        rebuilt: false,
        files: [
          {
            path: `v${version}.png`,
            hash: sha256(PNG),
            size: PNG.length,
            type: "image/png",
            url: `${url.origin}/blob`,
          },
        ],
      });
    if (url.pathname === "/blob") return new Response(PNG);
    return new Response("no", { status: 404 });
  },
});
afterAll(() => server.stop(true));

const box = sandbox();

test("wiki export pins a page's Markdown and bundle to one version", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "artifacts-wiki-pin-")), "brain");
  const env = { ...box.env, ARTIFACTS_URL: `http://127.0.0.1:${server.port}`, ARTIFACTS_TOKEN: "art_test" };
  const result = await cli(["wiki", "export", "brain", out, "--json"], env);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ pages: 1, files: 1, left: [] });
  expect(readFileSync(join(out, "pricing.md"), "utf8")).toContain("Version 3. ![Plan](pricing/v3.png)");
  expect(readFileSync(join(out, "pricing/v3.png"))).toEqual(Buffer.from(PNG));
  expect(asked).toContain(`/api/artifacts/${ID}/export.md?version=3`);
  expect(asked).toContain("/api/library/projects/brain/pricing/bundle?version=3");
});
