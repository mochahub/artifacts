import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ArtifactLinks, PublishPrepared, PublishResult, WikiSpace } from "@artifacts/schema";
import { articleRecords, buildArticle } from "@artifacts/schema/article";
import { and, eq } from "drizzle-orm";
import { artifacts, tokens, versions } from "../../src/db/schema.ts";
import { claim, mcp, startTestServer, type TestServer } from "../helpers.ts";
import { file, makePerson, publish } from "../publish-helper.ts";

describe("wikis", () => {
  let t: TestServer;
  let token: string;
  let orgId: string;
  const call = async (name: string, args: object, bearer = token) => {
    const r = await mcp(t, bearer, "tools/call", { name, arguments: args });
    const b = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return { ...b.result, content: b.result.content.map((c) => c) };
  };
  const article = (slug: string, markdown: string, extra: object = {}) =>
    call("artifacts_publish_article", {
      project: "brain",
      slug,
      title: slug,
      summary: "Wiki knowledge.",
      markdown,
      ...extra,
    });
  const create = (slug: string, extra = {}, bearer = token) =>
    t.api("/api/wikis", { method: "POST", bearer, json: { slug, name: slug, ...extra } });
  beforeAll(async () => {
    t = await startTestServer();
    ({ token, orgId } = await claim(t));
  });
  afterAll(() => t.stop());
  test("creation is idempotent and managed projects convert", async () => {
    expect((await create("brain")).status).toBe(201);
    expect((await create("brain")).status).toBe(200);
    await publish(t, token, { project: "convert" });
    expect((await create("convert")).status).toBe(200);
    const other = await makePerson(t, orgId, "member");
    await publish(t, token, { project: "taken" });
    expect((await create("taken", {}, other.token)).status).toBe(409);
    expect((await create("private", { personal: true }, other.token)).status).toBe(201);
    const stranger = await makePerson(t, orgId, "member");
    expect((await t.api("/api/wikis/private", { bearer: stranger.token })).status).toBe(404);
    expect((await t.api("/api/wikis/private", { bearer: other.token })).status).toBe(200);
  });
  test("latest links, sources and every garden finding respect visibility", async () => {
    await article("rules", "# Rules\nFollow these rules.");
    await article("source", "# Original", { role: "source", untrusted: true, origin: "https://example.com" });
    await article("page", "[[Missing]] [[source]]", { sources: ["source"] });
    t.clock.advance(1000);
    await article("source", "# Updated", { role: "source", untrusted: true });
    await article("lonely", "# Alone");
    const space = WikiSpace.parse(await (await t.api("/api/wikis/brain", { bearer: token })).json());
    expect(space.rules?.slug).toBe("rules");
    expect(space.sources).toHaveLength(1);
    expect(new Set(space.garden.map((f: { kind: string }) => f.kind))).toEqual(
      new Set(["untrusted", "stale", "wanted", "orphan", "unsourced"]),
    );
    const [a] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "page"));
    if (!a) throw new Error("Missing page");
    const [v] = await t.server.db.select().from(versions).where(eq(versions.artifactId, a.id));
    expect(v?.links).toEqual(["brain/missing", "brain/source"]);
    const links = ArtifactLinks.parse(
      await (await t.api(`/api/artifacts/${a.id}/links`, { bearer: token })).json(),
    );
    expect(links.outgoing[0]).toMatchObject({ exists: false, title: null });
    expect(links.sources[0]?.slug).toBe("source");
    expect((await call("artifacts_wiki", { wiki: "brain" })).content[1]?.text).toContain("rulesText");
    expect((await call("artifacts_wiki", {})).content[1]?.text).toContain("brain");
    expect((await call("artifacts_wiki_links", { artifact: "brain/page" })).content[1]?.text).toContain(
      "outgoing",
    );
    expect(
      (await call("artifacts_wiki_create", { slug: "toolwiki", name: "Tool Wiki" })).content[1]?.text,
    ).toContain("toolwiki");
    expect(
      JSON.parse(
        (await call("artifacts_comment", { artifact: "brain/page", message: "Please review." })).content[0]
          ?.text as string,
      ).id,
    ).toBe(1);
    await t.server.db
      .update(artifacts)
      .set({ visibility: "me" })
      .where(and(eq(artifacts.projectId, a.projectId), eq(artifacts.slug, "source")));
    const other = await makePerson(t, orgId, "member");
    const hidden = ArtifactLinks.parse(
      await (await t.api(`/api/artifacts/${a.id}/links`, { bearer: other.token })).json(),
    );
    expect(hidden.sources[0]).toMatchObject({ exists: false, title: null, summary: null, untrusted: false });
    expect(hidden.untrusted).toBe(false);
    const clean = WikiSpace.parse(await (await t.api("/api/wikis/brain", { bearer: other.token })).json());
    expect(clean.sources).toHaveLength(0);
    expect(clean.garden.some((f: { kind: string }) => f.kind === "untrusted" || f.kind === "stale")).toBe(
      false,
    );
  });
  test("API article links survive restore and hidden backlinks never count", async () => {
    const built = buildArticle({
      project: "brain",
      path: "doc.md",
      source: "[[page]] [[source]]",
      readFile: () => "",
      blobHash: () => undefined,
      frameHash: () => undefined,
      mermaid: new Map(),
    });
    const html = file("__articles/doc.html", built.html);
    const ready = PublishPrepared.parse(
      await (
        await t.api("/api/publish/prepare", {
          method: "POST",
          bearer: token,
          json: {
            project: "brain",
            slug: "api-page",
            title: "API Page",
            files: [{ path: html.path, sha256: html.sha256, size: html.size, type: html.type }],
          },
        })
      ).json(),
    );
    for (const missing of ready.missing) {
      const uploaded = await fetch(missing.url, { method: "PUT", headers: missing.headers, body: html.body });
      expect(uploaded.ok || uploaded.status === 412).toBe(true);
    }
    const records = articleRecords(built, {
      id: "doc",
      title: "API Page",
      group: null,
      position: 0,
      htmlHash: html.sha256,
      theme: null,
    });
    const result = PublishResult.parse(
      await (
        await t.api("/api/publish/commit", {
          method: "POST",
          bearer: token,
          json: {
            uploadId: ready.uploadId,
            name: null,
            message: null,
            notes: {},
            wiki: { role: "page", sources: ["source"] },
            files: { [html.path]: { hash: html.sha256, size: html.size, type: html.type } },
            pages: [records.page],
            blocks: records.blocks,
            frames: [],
          },
        })
      ).json(),
    );
    const [a] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "api-page"));
    if (!a) throw new Error("Missing API article");
    const [v] = await t.server.db.select().from(versions).where(eq(versions.artifactId, a.id));
    expect(v?.links).toEqual(["brain/page", "brain/source"]);
    await article("api-page", "Replacement");
    expect(
      (await t.api(`/api/artifacts/${a.id}/versions/1/restore`, { method: "POST", bearer: token, json: {} }))
        .status,
    ).toBe(200);
    const [restored] = await t.server.db
      .select()
      .from(versions)
      .where(and(eq(versions.artifactId, a.id), eq(versions.n, 3)));
    expect(restored?.links).toEqual(v?.links);
    expect(restored?.wiki).toEqual(v?.wiki);
    expect(result.version).toBe(1);
    await t.server.db.update(artifacts).set({ visibility: "me" }).where(eq(artifacts.id, a.id));
    const other = await makePerson(t, orgId, "member");
    const space = WikiSpace.parse(await (await t.api("/api/wikis/brain", { bearer: other.token })).json());
    expect(space.pages.find((p) => p.slug === "page")?.backlinks).toBe(0);
    expect(JSON.stringify(space)).not.toContain("API Page");
  });
  test("new MCP tools refuse insufficient scopes", async () => {
    const other = await makePerson(t, orgId, "member");
    await t.server.db.update(tokens).set({ scopes: [] }).where(eq(tokens.personId, other.id));
    for (const name of [
      "artifacts_wiki",
      "artifacts_wiki_links",
      "artifacts_wiki_create",
      "artifacts_comment",
    ]) {
      const r = await mcp(t, other.token, "tools/call", { name, arguments: {} });
      expect(r.status).toBe(403);
    }
  });
});
