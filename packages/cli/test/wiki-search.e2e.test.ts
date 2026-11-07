import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LibraryPage, WikiSpace } from "@artifacts/schema";
import { and, eq } from "drizzle-orm";
import { artifacts, teams } from "../../../apps/server/src/db/schema.ts";
import { mcp, type TestServer } from "../../../apps/server/test/helpers.ts";
import { makePerson } from "../../../apps/server/test/publish-helper.ts";
import { cli, cliJson, hostedServer, sandbox } from "./sandbox.ts";

describe("wiki search", () => {
  let t: TestServer;
  let token: string;
  let member: string;
  let url: string;
  const box = sandbox();
  const call = async (name: string, args: object, bearer = token) => {
    const response = await mcp(t, bearer, "tools/call", { name, arguments: args });
    const body = (await response.json()) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    expect(body.result.isError).not.toBe(true);
    return JSON.parse(body.result.content.at(-1)?.text ?? "null");
  };
  const article = (slug: string, markdown: string, extra: object = {}) =>
    call("artifacts_publish_article", {
      project: "wiki-qa",
      slug,
      title: slug,
      summary: "Knowledge.",
      markdown,
      ...extra,
    });
  const search = async (q: string, more = "", bearer = token) => {
    const response = await t.api(`/api/library/search?q=${encodeURIComponent(q)}&project=wiki-qa${more}`, {
      bearer,
    });
    expect(response.status).toBe(200);
    return LibraryPage.parse(await response.json());
  };
  const space = async (bearer = token) =>
    WikiSpace.parse(await (await t.api("/api/wikis/wiki-qa", { bearer })).json());

  beforeAll(async () => {
    let orgId: string;
    ({ t, token, url, orgId } = await hostedServer());
    member = (await makePerson(t, orgId, "member")).token;
    expect(
      (
        await t.api("/api/wikis", {
          method: "POST",
          bearer: token,
          json: { slug: "wiki-qa", name: "Wiki QA" },
        })
      ).status,
    ).toBe(201);
    await article("all", "Q3 goals pricing risks");
    await article("split", "Risks", { title: "Q3 goals", summary: "Pricing" });
    await article("three", "Q3 goals pricing");
    await article("two", "Knowledge", { title: "Q3 goals" });
    await article("one", "Knowledge", { title: "Risks risks risks risks risks risks" });
    await article("unrelated", "Northwind", { title: "Unrelated" });
    await article("phrase", "Knowledge", { title: "Trailblazer e-bike" });
    await article("scattered", "Trailblazer has an electric bike", { title: "Trailblazer" });
    await article("boundary", "Knowledge", { title: "Separate" });
    await article("web", "Original clipping", {
      role: "source",
      untrusted: true,
      origin: "https://example.com/private-origin",
    });
    await article("trusted", "Internal record", { role: "source" });
    await article("handbook", "A synthesis", { sources: ["web"] });
    await article("plain", "A plain page");
    await article("ordinary", "Ordinary knowledge", { project: "ordinary" });
  }, 30_000);
  afterAll(() => t.stop());

  test("CLI creates each starting audience and accepts the legacy flag", async () => {
    const env = { ...box.env, ARTIFACTS_TOKEN: token };
    const mine = await cliJson(["wiki", "create", "cli-mine", "--only-me", "--server", url], env);
    expect(mine.audience).toEqual({ kind: "me", label: "Only you" });
    const legacy = await cliJson(["wiki", "create", "cli-legacy", "--personal", "--server", url], env);
    expect(legacy.audience).toEqual(mine.audience);
    const [org] = await t.server.db
      .select({ orgId: artifacts.orgId, publisherId: artifacts.publisherId })
      .from(artifacts)
      .limit(1);
    if (!org) throw new Error("Missing artifact");
    await t.server.db.insert(teams).values({
      id: Bun.randomUUIDv7(),
      orgId: org.orgId,
      slug: "settings",
      name: "CLI team",
      createdBy: org.publisherId,
    });
    const shared = await cliJson(
      ["wiki", "create", "cli-shared", "--team", "settings", "--server", url],
      env,
    );
    expect(shared.audience.kind).toBe("team");
    expect(shared.audience.teams).toEqual([{ slug: "settings", name: "CLI team" }]);
  });
  test("CLI explains refusals, repeats, lists wikis and drops the deprecated field", async () => {
    const env = { ...box.env, ARTIFACTS_TOKEN: token };
    const run = (...args: string[]) => cli(["wiki", ...args, "--server", url], env);
    const org = await cliJson(["wiki", "create", "cli-org", "--server", url], env);
    expect(org.created).toBe(true);
    expect("personal" in org).toBe(false);
    const again = await run("create", "cli-org");
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Already exists: cli-org");
    expect((await run("create", "cli-fresh")).stdout).not.toContain("Already exists");
    const narrower = await run("create", "cli-org", "--only-me");
    expect(narrower.code).toBe(1);
    expect(narrower.stderr).toContain("already exists with audience");
    expect(narrower.stderr).toContain("Share sheet");
    for (const [args, problem] of [
      [["create", "settings", "--only-me"], 'Wiki name "settings": this word is reserved.'],
      [["create", "Bad_Slug"], 'Wiki name "Bad_Slug": use 1–40 characters of a-z, 0-9 and -.'],
      [["create", "x".repeat(68)], "use 1–40 characters"],
      [["create", "cli-bad", "--team", ""], '--team "": use 1–40 characters'],
      [["create", "cli-bad", "--only-me", "--team", "design"], "Choose --only-me or --team, not both."],
    ] as const) {
      const refused = await run(...args);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain(problem);
      expect(refused.stderr).toContain("artifacts wiki create <slug>");
    }
    const list = await cliJson(["wiki", "list", "--server", url], env);
    expect(list).toContainEqual({
      slug: "wiki-qa",
      name: "Wiki QA",
      audience: { kind: "org", label: expect.stringContaining("Everyone in") },
      pages: (await space()).pages.length,
      sources: (await space()).sources.length,
    });
    expect(list.map((w: { slug: string }) => w.slug)).not.toContain("ordinary");
    const text = await run("list");
    expect(text.stdout).toContain("wiki-qa  Wiki QA (Everyone in");
    expect((await run("list", "extra")).code).toBe(2);
    const shown = await cliJson(["wiki", "show", "wiki-qa", "--server", url], env);
    expect("personal" in shown.project).toBe(false);
    const log = await run("show", "wiki-qa");
    expect(log.stdout).toContain("\nLog\n  ");
    const plain = await run("show", "ordinary");
    expect(plain.code).toBe(1);
    expect(plain.stderr).toContain("ordinary isn't a wiki. Make it one with artifacts wiki create ordinary.");
  });
  test("natural-language queries rank distinct matching terms across fields before source weights", async () => {
    const expected = ["split", "all", "three", "two", "one"];
    expect((await search("Q3 goals pricing risks")).cards.map((c) => c.slug)).toEqual(expected);
    // No document contains every word, and ordinary sentence words don't prevent useful results.
    expect((await search("what are Q3 goals pricing risks missingword")).cards.map((c) => c.slug)).toEqual(
      expected,
    );
    const hosted = await call("artifacts_search", {
      query: "Q3 goals pricing risks",
      project: "wiki-qa",
    });
    expect(LibraryPage.parse(hosted).cards.map((c) => c.slug)).toEqual(expected);
  });

  test("single terms, prefixes, stemming and quoted phrases keep matching", async () => {
    expect((await search("Northwind")).cards.map((c) => c.slug)).toEqual(["unrelated"]);
    expect((await search("pric")).cards.map((c) => c.slug).sort()).toEqual(["all", "split", "three"]);
    expect((await search("goal")).cards.map((c) => c.slug).sort()).toEqual(["all", "split", "three", "two"]);
    expect((await search('"Trailblazer e-bike"')).cards.map((c) => c.slug)).toEqual(["phrase"]);
    expect((await search('"absent phrase"')).cards).toEqual([]);
    expect((await search('"Separate boundary"')).cards).toEqual([]);
    expect((await search("Trailblazer e-bike")).cards.map((c) => c.slug).sort()).toEqual([
      "phrase",
      "scattered",
    ]);
  });

  test("ranked result pages are stable with no duplicates or omissions", async () => {
    const q = "Q3 goals pricing risks";
    const all = (await search(q)).cards.map((c) => c.slug);
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await search(q, `&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      paged.push(...page.cards.map((c) => c.slug));
      cursor = page.nextCursor;
    } while (cursor);
    expect(paged).toEqual(all);
    expect((await search(q)).cards.map((c) => c.slug)).toEqual(all);
  });

  test("wiki cards include source metadata and derive page trust from sources outside the result page", async () => {
    const source = (await search("clipping")).cards[0];
    expect(source).toMatchObject({
      role: "source",
      untrusted: true,
      origin: "https://example.com/private-origin",
    });
    expect((await search("Internal record")).cards[0]).toMatchObject({
      role: "source",
      untrusted: false,
      origin: null,
    });
    const page = (await search("synthesis", "&limit=1")).cards[0];
    expect(page).toMatchObject({ slug: "handbook", role: "page", untrusted: true, origin: null });
    expect(page?.untrusted).toBe((await space()).pages.find((p) => p.slug === "handbook")?.untrusted);
    expect((await search("plain")).cards[0]).toMatchObject({ role: "page", untrusted: false, origin: null });
    const result = await cliJson(["search", "synthesis", "--project", "wiki-qa"], {
      ...box.env,
      ARTIFACTS_URL: url,
      ARTIFACTS_TOKEN: token,
    });
    expect(result.cards).toEqual([page]);
    const hosted = await call("artifacts_search", { query: "synthesis", project: "wiki-qa" });
    expect(hosted.cards).toEqual([page]);
  });

  test("non-wiki cards keep their existing shape in REST, CLI JSON and MCP", async () => {
    const response = await t.api("/api/library/search?q=Ordinary&project=ordinary", { bearer: token });
    const rest = await response.json();
    const cli = await cliJson(["search", "Ordinary", "--project", "ordinary"], {
      ...box.env,
      ARTIFACTS_URL: url,
      ARTIFACTS_TOKEN: token,
    });
    const hosted = await call("artifacts_search", { query: "Ordinary", project: "ordinary" });
    for (const result of [rest, cli, hosted]) {
      expect(result.cards).toHaveLength(1);
      for (const key of ["role", "untrusted", "origin"]) expect(result.cards[0]).not.toHaveProperty(key);
    }
  });

  test("latest source trust and access checks match the wiki view without leaking hidden metadata", async () => {
    await article("web", "Original clipping", { role: "source", untrusted: false });
    expect((await search("synthesis")).cards[0]?.untrusted).toBe(false);
    await article("web", "Original clipping", {
      role: "source",
      untrusted: true,
      origin: "https://example.com/private-origin",
    });
    expect((await search("synthesis")).cards[0]?.untrusted).toBe(true);
    await t.server.db
      .update(artifacts)
      .set({ visibility: "me" })
      .where(and(eq(artifacts.slug, "web"), eq(artifacts.title, "web")));
    expect((await search("clipping", "", member)).cards).toEqual([]);
    const visible = await search("synthesis", "", member);
    expect(visible.cards[0]).toMatchObject({ role: "page", untrusted: false, origin: null });
    expect(visible.cards[0]?.untrusted).toBe(
      (await space(member)).pages.find((p) => p.slug === "handbook")?.untrusted,
    );
    const hosted = await call(
      "artifacts_search",
      { query: "synthesis clipping", project: "wiki-qa" },
      member,
    );
    expect(hosted.cards).toEqual(visible.cards);
    expect(JSON.stringify(hosted)).not.toContain("private-origin");
    expect((await search("clipping")).cards[0]?.untrusted).toBe(true);
  });
});
