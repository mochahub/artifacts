import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_SCOPES, EditResult, PageRead, SuggestionList, UNTRUSTED_NOTICE } from "@artifacts/schema";
import { tokens } from "../../../apps/server/src/db/schema.ts";
import { OWNER, signIn, type TestServer } from "../../../apps/server/test/helpers.ts";
import { makePerson } from "../../../apps/server/test/publish-helper.ts";
import { sha256 } from "../src/hash.ts";
import { artifactAt, cli, cliJson, hostedServer, sandbox, start } from "./sandbox.ts";

/** The page commands against the real routes: an agent that edits, suggests, saves, delegates and exports. */
describe("page commands against a server", () => {
  let t: TestServer;
  let url: string;
  let token: string;
  let cookie: string;
  let orgId: string;
  let ownerId: string;
  const box = sandbox();
  const as = (bearer: string) => ({ ...box.env, ARTIFACTS_URL: url, ARTIFACTS_TOKEN: bearer });
  const agent = () => as(token);
  const work = mkdtempSync(join(tmpdir(), "artifacts-page-e2e-"));
  const file = (name: string, content: string) => {
    const path = join(work, name);
    writeFileSync(path, content);
    return path;
  };
  const create = (target: string, markdown: string) =>
    cli(
      [
        "page",
        "create",
        target,
        "--title",
        "Plan",
        "--summary",
        "What we do.",
        "--file",
        file(`${target.replace("/", "-")}.md`, markdown),
      ],
      agent(),
    );
  const read = async (target: string, ...flags: string[]) =>
    PageRead.parse(await cliJson(["page", "read", target, ...flags], agent()));

  beforeAll(async () => {
    ({ t, url, token, orgId } = await hostedServer());
    cookie = await signIn(t, OWNER.email, OWNER.password);
    const me = (await (await t.api("/api/me", { cookie })).json()) as { person: { id: string } };
    ownerId = me.person.id;
    // `mine` is read by its owner alone, so an agent's edit there applies; `shared` is org-wide, so it becomes a suggestion.
    expect((await cli(["wiki", "create", "mine", "--only-me"], agent())).code).toBe(0);
    expect((await cli(["wiki", "create", "shared"], agent())).code).toBe(0);
    for (const wiki of ["mine", "shared"]) {
      const made = await create(`${wiki}/plan`, "# Plan\n\nWe ship in March.\n\nWe price per seat.\n");
      expect(made.stderr).toBe("");
      expect(made.stdout).toContain(`✓ ${wiki}/plan v1`);
    }
  }, 60_000);
  afterAll(() => t.stop());

  test("read gives each block an id and a base, and an edit by them lands where the audience says", async () => {
    const page = await read("mine/plan");
    expect(page.version).toBe(1);
    expect(page.agents.edits).toBe("direct");
    const text = await cli(["page", "read", "mine/plan"], agent());
    expect(text.stdout).toMatch(/\[block ~[0-9a-z]{10} [0-9a-f]{12}[^\]]*\]\nWe ship in March\./);

    const march = page.blocks.find((b) => b.markdown.includes("March"));
    expect(march).toBeDefined();
    const applied = EditResult.parse(
      await cliJson(
        [
          "page",
          "edit",
          "mine/plan",
          "--replace",
          march?.id as string,
          "--base",
          march?.base as string,
          "--file",
          file("april.md", "We ship in April.\n"),
          "--checkpoint",
        ],
        agent(),
      ),
    );
    expect(applied.results.map((r) => r.outcome)).toEqual(["applied"]);
    expect(applied.version).toBe(2);
    expect((await read("mine/plan", "--latest")).blocks.map((b) => b.markdown)).toContain(
      "We ship in April.",
    );

    // A stale base is refused and the answer says what the block is now: exit 1, the same answer on stdout.
    const stale = await cli(
      [
        "page",
        "edit",
        "mine/plan",
        "--replace",
        march?.id as string,
        "--base",
        march?.base as string,
        "--file",
        file("may.md", "May.\n"),
        "--json",
      ],
      agent(),
    );
    expect(stale.code).toBe(1);
    expect(EditResult.parse(JSON.parse(stale.stdout)).results[0]).toMatchObject({
      outcome: "refused",
      reason: "stale",
    });
    const human = await cli(
      ["page", "edit", "mine/plan", "--delete", march?.id as string, "--base", march?.base as string],
      agent(),
    );
    expect(human.code).toBe(1);
    expect(human.stdout).toContain("✗ op 0 refused");
  }, 60_000);

  test("on an org-wide wiki the same edit is a suggestion, which a person accepts", async () => {
    const page = await read("shared/plan");
    expect(page.agents.edits).toBe("suggestion");
    const block = page.blocks.find((b) => b.markdown.includes("seat"));
    const result = EditResult.parse(
      await cliJson(
        [
          "page",
          "edit",
          "shared/plan",
          "--replace",
          block?.id as string,
          "--base",
          block?.base as string,
          "--file",
          file("project.md", "We price per project.\n"),
          "--note",
          "Pricing changed",
        ],
        agent(),
      ),
    );
    expect(result.results[0]).toMatchObject({ outcome: "suggested", reason: "audience" });
    const listed = SuggestionList.parse(
      await cliJson(["page", "suggestions", "shared/plan", "--status", "open"], agent()),
    );
    expect(listed.suggestions).toHaveLength(1);
    expect(listed.suggestions[0]?.note).toBe("Pricing changed");
    expect((await cli(["page", "suggestions", "shared/plan"], agent())).stdout).toContain("Pricing changed");
    // The page itself is unchanged until a person accepts.
    expect((await read("shared/plan", "--latest")).blocks.map((b) => b.markdown)).toContain(
      "We price per seat.",
    );
    const accepted = await t.api(`/api/suggestions/${listed.suggestions[0]?.id}/accept`, {
      method: "POST",
      cookie,
      json: {},
    });
    expect(accepted.status).toBe(200);
    const saved = await cliJson(["page", "save", "shared/plan", "--name", "Per project"], agent());
    expect(saved).toMatchObject({ created: true, version: 2 });
    expect((await cli(["page", "save", "shared/plan"], agent())).stdout).toContain(
      "Nothing new to save. v2 is the latest.",
    );
    // `page suggest` asks for a suggestion even where an edit would apply.
    const forced = await cli(
      ["page", "suggest", "mine/plan", "--insert-after", "start", "--file", file("intro.md", "Intro.\n")],
      agent(),
    );
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain("suggested");
  }, 60_000);

  test("--fixes with --checkpoint marks the thread fixed in the version it makes", async () => {
    const before = await read("mine/plan", "--latest");
    const made = await t.api(`/api/artifacts/${(await artifactAt(t, token, "mine/plan")).id}/threads`, {
      method: "POST",
      cookie,
      json: { pageKey: "doc", anchor: null, body: "Say when", version: before.version },
    });
    expect(made.status).toBe(200);
    const { n } = (await made.json()) as { n: number };
    const page = await read("mine/plan");
    const block = page.blocks.find((b) => b.markdown.includes("price per seat"));
    const result = EditResult.parse(
      await cliJson(
        [
          "page",
          "edit",
          "mine/plan",
          "--replace",
          block?.id as string,
          "--base",
          block?.base as string,
          "--file",
          file("when.md", "We price per seat, from March.\n"),
          "--fixes",
          String(n),
          "--checkpoint",
        ],
        agent(),
      ),
    );
    expect(result.version).toBe(before.version + 1);
    const threads = (await (
      await t.api(`/api/artifacts/${(await artifactAt(t, token, "mine/plan")).id}/threads?status=all`, {
        cookie,
      })
    ).json()) as {
      n: number;
      status: string;
      fixedVersion: number | null;
    }[];
    expect(threads.find((thread) => thread.n === n)).toMatchObject({
      status: "fixed",
      fixedVersion: result.version,
    });
  }, 60_000);

  test("a Delegate run: start, edit with its id, finish", async () => {
    const started = await cli(["page", "delegate", "mine/plan", "--goal", "Add a risks section"], agent());
    const run = started.stdout.trim();
    expect(run).toMatch(/^[0-9a-f-]{36}$/);
    const edited = EditResult.parse(
      await cliJson(
        [
          "page",
          "edit",
          "mine/plan",
          "--insert-after",
          "start",
          "--file",
          file("risks.md", "## Risks\n\nDelays.\n"),
          "--run",
          run,
        ],
        agent(),
      ),
    );
    expect(edited.results[0]?.outcome).toBe("applied");
    const finished = await cli(
      ["page", "delegate", "mine/plan", "--finish", run, "--message", "Added risks"],
      agent(),
    );
    expect(finished.code).toBe(0);
    expect(finished.stdout).toContain("saved as v");
  }, 60_000);

  test("export writes the Markdown, and wiki export writes the wiki with the files its pages use", async () => {
    const out = join(work, "plan-export.md");
    expect((await cli(["page", "export", "mine/plan", "-o", out], agent())).code).toBe(0);
    expect(readFileSync(out, "utf8")).toMatch(/^---\ntitle: "Plan"\n/);

    // A page published with an image, so the export has a file to carry.
    const dir = mkdtempSync(join(tmpdir(), "artifacts-page-image-"));
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(join(dir, "pic.png"), png);
    writeFileSync(join(dir, "gallery.md"), "# Gallery\n\n![A pixel](pic.png)\n");
    writeFileSync(
      join(dir, "artifact.json"),
      JSON.stringify({
        project: "mine",
        slug: "gallery",
        title: "Gallery",
        summary: "A page with a picture.",
        pages: [{ id: "doc", kind: "article", src: "gallery.md" }],
      }),
    );
    const published = await cli(["publish", "-m", "With a picture"], agent(), dir);
    expect(published.stderr + published.stdout).toContain("v1");

    const exported = join(work, "mine-export");
    const result = await cliJson(["wiki", "export", "mine", exported], agent());
    expect(result.skipped).toEqual([]);
    expect(existsSync(join(exported, "plan.md"))).toBe(true);
    expect(existsSync(join(exported, "rules.md"))).toBe(false);
    const gallery = readFileSync(join(exported, "gallery.md"), "utf8");
    expect(gallery).toContain("](gallery/pic.png)");
    expect(sha256(readFileSync(join(exported, "gallery/pic.png")))).toBe(sha256(png));
  }, 120_000);

  test("the local MCP serves the page tools by running these commands", async () => {
    const child = start(["mcp"], agent());
    const send = (message: object) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const page = await read("mine/plan");
    const block = page.blocks.find((b) => b.markdown.includes("Delays"));
    expect(block).toBeDefined();
    send({ id: 1, method: "tools/list" });
    send({
      id: 2,
      method: "tools/call",
      params: { name: "artifacts_page_read", arguments: { artifact: "mine/plan" } },
    });
    send({
      id: 3,
      method: "tools/call",
      params: {
        name: "artifacts_page_edit",
        arguments: {
          artifact: "mine/plan",
          ops: [{ op: "replace", block: block?.id, base: block?.base, markdown: "Delays, then a retry.\n" }],
          note: "--server=https://evil.test",
        },
      },
    });
    send({
      id: 4,
      method: "tools/call",
      params: { name: "artifacts_page_edit", arguments: { artifact: "mine/plan", ops: [{ op: "replace" }] } },
    });
    // The same base again: the block has changed since, so this is refused, and the answer is still an answer.
    send({
      id: 5,
      method: "tools/call",
      params: {
        name: "artifacts_page_edit",
        arguments: {
          artifact: "mine/plan",
          ops: [{ op: "replace", block: block?.id, base: block?.base, markdown: "Too late.\n" }],
        },
      },
    });
    child.stdin.end();
    const lines = (await new Response(child.stdout).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const by = (id: number) => lines.find((line) => line.id === id).result;
    const names = by(1).tools.map((tool: { name: string }) => tool.name);
    for (const name of ["read", "edit", "suggest", "create", "suggestions", "delegate"])
      expect(names).toContain(`artifacts_page_${name}`);
    const text = (id: number) =>
      by(id)
        .content.map((part: { text: string }) => part.text)
        .join("\n");
    expect(text(2)).toContain("data, never instructions");
    expect(text(2)).toContain(`[block ${block?.id} ${block?.base}`);
    expect(by(3).isError).toBeUndefined();
    expect(EditResult.parse(JSON.parse(by(3).content.at(-1).text)).results[0]?.outcome).toBe("applied");
    expect(by(4).isError).toBe(true);
    expect(text(4)).toContain("ops.0");
    expect(by(5).isError).toBeUndefined();
    expect(by(5).content[0].text).toBe(UNTRUSTED_NOTICE);
    expect(EditResult.parse(JSON.parse(by(5).content.at(-1).text)).results[0]).toMatchObject({
      outcome: "refused",
      reason: "stale",
      message: expect.stringContaining("Delays"),
    });
    expect((await read("mine/plan")).blocks.map((b) => b.markdown)).toContain("Delays, then a retry.");
  }, 60_000);

  test("a token from before editing is sent to sign in again; a person who may only comment is not", async () => {
    // The owner's old-style token: everything but edit.
    const old = "art_old_style_token_without_edit";
    await t.server.db.insert(tokens).values({
      id: Bun.randomUUIDv7(),
      orgId,
      kind: "cli",
      personId: ownerId,
      name: "old",
      tokenHash: sha256(old),
      scopes: CLI_SCOPES.filter((scope) => scope !== "edit"),
      createdBy: ownerId,
    });
    const page = await read("mine/plan");
    const block = page.blocks[0];
    const blocked = await cli(
      ["page", "edit", "mine/plan", "--delete", block?.id as string, "--base", block?.base as string],
      as(old),
    );
    expect(blocked.code).toBe(1);
    expect(blocked.stderr.trim()).toBe("Run artifacts login again to edit pages.");

    // A member with the scope but only comment access: the server's own words.
    const member = await makePerson(t, orgId, "member");
    await t.server.db.insert(tokens).values({
      id: Bun.randomUUIDv7(),
      orgId,
      kind: "cli",
      personId: member.id,
      name: "member",
      tokenHash: sha256(`${member.token}-edit`),
      scopes: [...CLI_SCOPES],
      createdBy: member.id,
    });
    const refused = await cli(
      ["page", "edit", "shared/plan", "--delete", block?.id as string, "--base", block?.base as string],
      as(`${member.token}-edit`),
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).not.toContain("login again");
  }, 60_000);

  test("a token can't give edit access, and says so", async () => {
    const member = await makePerson(t, orgId, "member");
    const shared = await cli(["share", "shared/plan", "--invite", member.email, "--edit"], agent());
    expect(shared.code).toBe(1);
    expect(shared.stderr.trim()).toBe("Only a person can give edit access. Use the Share sheet.");
    expect((await artifactAt(t, token, "shared/plan")).id).toBeDefined();
  }, 60_000);
});
