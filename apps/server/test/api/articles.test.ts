import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { VersionBundle } from "@artifacts/schema";
import { claim, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { makePerson, publish } from "../publish-helper.ts";

const XSS = `# Report

Hello <script>alert(1)</script> there.

<img src=x onerror=alert(2)>

[click](javascript:alert(3))

![remote](https://evil.test/track.png)
`;

describe("articles with no CLI", () => {
  let t: TestServer;
  let token: string;
  let cookie: string;
  let id = 1;
  const call = async (name: string, args: object, bearer = token) => {
    const response = await t.api("/api/mcp", {
      method: "POST",
      bearer,
      json: { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } },
    });
    const body = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return body.result;
  };
  const article = (slug: string, markdown: string, extra: object = {}) =>
    call("artifacts_publish_article", {
      project: "notes",
      slug,
      title: "A note",
      summary: "What this holds, and why it mattered.",
      markdown,
      ...extra,
    });

  beforeAll(async () => {
    t = await startTestServer();
    token = (await claim(t)).token;
    cookie = await signIn(t, OWNER.email, OWNER.password);
  });
  afterAll(() => t.stop());

  test("Markdown becomes an article: in the viewer, in read, in search and in pull", async () => {
    const result = await article(
      "plan",
      "# The plan\n\nWe light the path with lanterns.\n\n:::stats\n- **41%** fewer steps\n:::\n",
      { tags: ["plan"], message: "First", repo: "git@github.com:Mocha/Notes.git" },
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text as string).version).toBe(1);

    const artifact = (await (await t.api("/api/artifacts/by-slug/notes/plan", { cookie })).json()) as {
      id: string;
      pages: { key: string; kind: string }[];
    };
    expect(artifact.pages).toMatchObject([{ key: "doc", kind: "article" }]);
    const html = await (await t.api(`/api/artifacts/${artifact.id}/v/1/article/doc`, { cookie })).text();
    expect(html).toContain("lanterns");
    expect(html).toContain('data-component="stats"');

    const read = await call("artifacts_read", { artifact: "notes/plan" });
    expect(read.content[1]?.text).toContain("lanterns");
    const found = await call("artifacts_search", { query: "lanterns", repo: "mocha/notes" });
    const card = JSON.parse(found.content[1]?.text as string).cards[0];
    expect(card).toMatchObject({
      slug: "plan",
      summary: "What this holds, and why it mattered.",
      tags: ["plan"],
    });

    const bundle = VersionBundle.parse(
      await (await t.api("/api/library/projects/notes/plan/bundle", { bearer: token })).json(),
    );
    expect(bundle.rebuilt).toBe(false);
    expect(bundle.files.map((file) => file.path)).toContain("doc.md");
  });

  test("an XSS payload is sanitized the same way as a CLI publish", async () => {
    expect((await article("xss", XSS)).isError).toBeUndefined();
    const { id: artifact } = (await (await t.api("/api/artifacts/by-slug/notes/xss", { cookie })).json()) as {
      id: string;
    };
    const html = await (await t.api(`/api/artifacts/${artifact}/v/1/article/doc`, { cookie })).text();
    for (const bad of ["<script", "onerror", "javascript:", "evil.test"]) expect(html).not.toContain(bad);
    expect(html).toContain("Hello");
    // The stored Markdown keeps what was typed: it's source, and the viewer never renders it.
    const { sanitizeArticle } = await import("@artifacts/schema/sanitize");
    expect(sanitizeArticle(html)).toBe(html);
  });

  test("a new version re-anchors comments, like any publish", async () => {
    await article("anchored", "# Title\n\nThe first paragraph here.\n");
    const { id: artifact } = (await (
      await t.api("/api/artifacts/by-slug/notes/anchored", { cookie })
    ).json()) as { id: string };
    const thread = await t.api(`/api/artifacts/${artifact}/threads`, {
      method: "POST",
      cookie,
      json: {
        pageKey: "doc",
        anchor: { type: "block", blockKey: "title/p1" },
        body: "Change this",
        version: 1,
      },
    });
    expect(thread.status).toBe(200);
    const next = await article("anchored", "# Title\n\nThe first paragraph, changed.\n");
    expect(JSON.parse(next.content[0]?.text as string).threadsOnChanged).toEqual([1]);
  });

  test("what needs files is refused, and says what to use", async () => {
    for (const markdown of [
      "# T\n\n![a](local.png)\n",
      "# T\n\n```mermaid\ngraph TD\n```\n",
      "# T\n\n::chart{src=c.json}\n",
      '# T\n\n::frame{ref="a/b/c"}\n',
    ]) {
      const result = await article("refused", markdown);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("artifacts pack");
    }
    expect((await t.api("/api/artifacts/by-slug/notes/refused", { cookie })).status).toBe(404);
  });

  test("a summary is required and capped, tags too, and a long article is refused", async () => {
    expect((await article("rules", "# T\n", { summary: "" })).isError).toBe(true);
    expect((await article("rules", "# T\n", { summary: "x".repeat(281) })).isError).toBe(true);
    expect((await article("rules", "# T\n", { tags: Array(9).fill("x") })).isError).toBe(true);
    expect((await article("rules", "   ")).isError).toBe(true);
    expect((await article("rules", `# T\n\n${"x".repeat(1024 * 1024)}`)).isError).toBe(true);
    expect((await article("rules", "# T\n", { title: "" })).isError).toBe(true);
  });

  test("it won't replace an artifact that has other pages", async () => {
    await publish(t, token, { project: "notes", slug: "mixed", summary: "Has a canvas." });
    const result = await article("mixed", "# Over the top\n");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("other pages");
  });

  test("the usual permission applies", async () => {
    const [org] = await t.server.db.query.org.findMany();
    const orgId = (org as { id: string }).id;
    const reviewer = await makePerson(t, orgId, "reviewer");
    const other = await makePerson(t, orgId, "member");
    const args = { project: "notes", title: "T", summary: "S", markdown: "# T\n" };
    expect(
      (await call("artifacts_publish_article", { ...args, slug: "by-reviewer" }, reviewer)).isError,
    ).toBe(true);
    expect((await call("artifacts_publish_article", { ...args, slug: "plan" }, other)).isError).toBe(true);
    expect((await t.api("/api/artifacts/by-slug/notes/by-reviewer", { cookie })).status).toBe(404);
  });
});
