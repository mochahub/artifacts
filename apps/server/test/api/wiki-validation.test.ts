import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ArtifactLinks, PublishPrepared, WikiSpace } from "@artifacts/schema";
import { and, eq } from "drizzle-orm";
import { artifacts, versions } from "../../src/db/schema.ts";
import { putBlob } from "../../src/publish/blobs.ts";
import { claim, mcp, startTestServer, type TestServer } from "../helpers.ts";
import { makePerson } from "../publish-helper.ts";

describe("wiki validation", () => {
  let t: TestServer;
  let token: string;
  let orgId: string;
  const call = async (name: string, args: object, bearer = token) => {
    const response = await mcp(t, bearer, "tools/call", { name, arguments: args });
    const body = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return body.result;
  };
  const article = (slug: string, extra: object = {}, bearer = token) =>
    call(
      "artifacts_publish_article",
      { project: "brain", slug, title: slug, summary: "Wiki knowledge.", markdown: "# Note", ...extra },
      bearer,
    );
  const space = async () =>
    WikiSpace.parse(await (await t.api("/api/wikis/brain", { bearer: token })).json());
  beforeAll(async () => {
    t = await startTestServer();
    ({ token, orgId } = await claim(t));
    expect(
      (await t.api("/api/wikis", { method: "POST", bearer: token, json: { slug: "brain", name: "Brain" } }))
        .status,
    ).toBe(201);
    expect((await article("source", { role: "source" })).isError).toBeUndefined();
    expect((await article("page")).isError).toBeUndefined();
  });
  afterAll(() => t.stop());

  test.each([
    [{ origin: "ftp://x" }, "wiki.origin: use an http or https address"],
    [{ role: "invalid" }, "wiki.role: Invalid option: expected one of"],
    [{ sources: Array(51).fill("source") }, "wiki.sources: Too big: expected array to have <=50 items"],
    [{ sources: ["Bad Slug"] }, "wiki.sources.0: use a source's slug"],
    [{ sources: "source" }, "wiki.sources: Invalid input: expected array"],
    [{ origin: 1 }, "wiki.origin: Invalid input: expected string"],
    [{ untrusted: "yes" }, "wiki.untrusted: Invalid input: expected boolean"],
  ])("MCP names the field and reason for invalid metadata %j", async (extra, message) => {
    const result = await article("invalid-meta", extra);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(message);
  });

  test("MCP reports every invalid metadata field in one response", async () => {
    const result = await article("invalid-meta", { origin: "ftp://x", sources: ["Bad Slug"] });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("wiki.origin: use an http or https address");
    expect(result.content[0]?.text).toContain("wiki.sources.0: use a source's slug");
  });

  test("MCP payload prepare and commit also report wiki validation details", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        declared: [],
        files: {},
        pages: [],
        frames: [],
        blocks: [],
        wiki: { role: "source", origin: "ftp://x" },
      }),
    );
    const hash = await putBlob(t.server.deps, orgId, bytes, "application/json");
    for (const [name, args] of [
      [
        "artifacts_publish_prepare",
        {
          project: "brain",
          slug: "bad-payload",
          title: "Bad payload",
          payload: { sha256: hash, size: bytes.length },
        },
      ],
      ["artifacts_publish_commit", { uploadId: "unused", payload: hash }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("wiki.origin: use an http or https address");
    }
  });

  test.each([
    ["missing-citation", ["no-such-source"], '"no-such-source" must name an existing source'],
    ["page-citation", ["page"], '"page" has role page; cite a source'],
    ["self-citation", ["self-citation"], "cannot cite itself"],
    ["source-self-citation", ["source-self-citation"], "cannot cite itself"],
  ])("refuses invalid citations before publishing %s", async (slug, sources, message) => {
    const result = await article(slug, {
      sources,
      role: slug === "source-self-citation" ? "source" : "page",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("wiki.sources:");
    expect(result.content[0]?.text).toContain(message);
    expect((await t.api(`/api/artifacts/by-slug/brain/${slug}`, { bearer: token })).status).toBe(404);
  });

  test("API commits enforce citations too, and a failed republish keeps the last version", async () => {
    expect((await article("valid", { sources: ["source"] })).isError).toBeUndefined();
    const prepared = await t.api("/api/publish/prepare", {
      method: "POST",
      bearer: token,
      json: { project: "brain", slug: "valid", title: "Valid", files: [] },
    });
    const { uploadId } = PublishPrepared.parse(await prepared.json());
    const refused = await t.api("/api/publish/commit", {
      method: "POST",
      bearer: token,
      json: { uploadId, wiki: { sources: ["missing"] }, files: {}, pages: [], frames: [], blocks: [] },
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("wiki.sources");
    const page = (await space()).pages.find((p) => p.slug === "valid");
    expect(page).toMatchObject({ version: 1, sources: ["source"] });
    const result = await article("valid", { sources: ["valid"] });
    expect(result.isError).toBe(true);
    expect((await space()).pages.find((p) => p.slug === "valid")?.version).toBe(1);
  });

  test("valid citations agree in both views and legacy broken citations stay visible", async () => {
    expect((await article("legacy", { sources: ["source"] })).isError).toBeUndefined();
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "legacy"));
    if (!row) throw new Error("Missing legacy article");
    const links = async () =>
      ArtifactLinks.parse(await (await t.api(`/api/artifacts/${row.id}/links`, { bearer: token })).json());
    expect((await links()).sources).toMatchObject([{ slug: "source", exists: true }]);
    expect((await space()).pages.find((p) => p.slug === "legacy")?.sources).toEqual(["source"]);
    // Simulate metadata accepted before source validation was added.
    await t.server.db
      .update(versions)
      .set({ wiki: { role: "page", sources: ["no-such-source"] } })
      .where(and(eq(versions.artifactId, row.id), eq(versions.n, 1)));
    const wiki = await space();
    expect(wiki.pages.find((p) => p.slug === "legacy")?.sources).toEqual(["no-such-source"]);
    expect((await links()).sources).toMatchObject([{ slug: "no-such-source", exists: false, title: null }]);
    expect(wiki.garden).toContainEqual({
      kind: "wanted",
      slug: "no-such-source",
      refs: ["legacy"],
      message: "A cited source is missing or unavailable.",
    });
    expect(wiki.garden.find((f) => f.kind === "unsourced" && f.slug === "legacy")?.message).toBe(
      "None of this page's citations resolve to a source.",
    );
  });

  test("hidden sources are refused like missing ones and their metadata stays private", async () => {
    const other = await makePerson(t, orgId, "member");
    expect(
      (await article("private-source", { role: "source", title: "Private title" })).isError,
    ).toBeUndefined();
    // Set visibility directly: the article tool uses the organization's publishing default.
    await t.server.db.update(artifacts).set({ visibility: "me" }).where(eq(artifacts.slug, "private-source"));
    const hidden = await article("hidden-citation", { sources: ["private-source"] }, other.token);
    const missing = await article("hidden-citation", { sources: ["absent"] }, other.token);
    expect(hidden.isError).toBe(true);
    expect(missing.isError).toBe(true);
    expect(hidden.content[0]?.text?.replace("private-source", "absent")).toBe(missing.content[0]?.text);
    expect(JSON.stringify(hidden)).not.toContain("Private title");
  });
});
