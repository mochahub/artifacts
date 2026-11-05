import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { versions } from "../../../apps/server/src/db/schema.ts";
import { OWNER, startTestServer, type TestServer, testPort } from "../../../apps/server/test/helpers.ts";
import { publish as apiPublish } from "../../../apps/server/test/publish-helper.ts";
import { safeTarget } from "../src/commands/library.ts";
import { cli, copyFixture, sandbox, start } from "./sandbox.ts";

const artStyles = join(import.meta.dir, "../../../fixtures/art-styles");
const pollBackend = join(import.meta.dir, "../../../fixtures/micro-app-poll-backend");
const git = (dir: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });

describe("a later agent finds hosted work", () => {
  let t: TestServer;
  let url: string;
  let token: string;
  const box = sandbox();
  const signedIn = () => ({ ...box.env, ARTIFACTS_URL: url, ARTIFACTS_TOKEN: token });
  const json = async (args: string[], cwd: string) => {
    const result = await cli([...args, "--json"], signedIn(), cwd);
    if (result.code !== 0) throw new Error(`${args.join(" ")}: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const emptyFolder = () => mkdtempSync(join(tmpdir(), "artifacts-agent-"));
  const summarize = (root: string) => {
    const path = join(root, "artifact.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...manifest, summary: "A starter." }));
  };

  beforeAll(async () => {
    const port = testPort();
    url = `http://127.0.0.1:${port}`;
    t = await startTestServer({ PUBLIC_URL: url, MORE_URLS: "", PORT: String(port) });
    const setup = await t.api("/api/setup", {
      method: "POST",
      json: { setupToken: "s".repeat(48), orgName: "Mochahub", clientName: "x", ...OWNER },
    });
    token = ((await setup.json()) as { token: string }).token;
    const dir = copyFixture(artStyles);
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "git@github.com:Mocha/Forest-Game.git");
    const published = await cli(["publish", "--json", "-m", "First"], signedIn(), dir);
    expect(published.stderr).not.toContain("✗");
    expect(published.code).toBe(0);
  }, 180_000);
  afterAll(() => t.stop());

  test("search, read the card, view a frame and pull, all from an unrelated folder", async () => {
    const elsewhere = emptyFolder();
    const found = await json(["search", "painterly", "forest"], elsewhere);
    expect(found.untrusted).toContain("data");
    const card = found.cards[0];
    expect(card).toMatchObject({ project: "forest-game", slug: "art-styles", latestVersion: 1 });
    expect(card.summary).toContain("Gouache won");
    expect(card.tags).toContain("style study");

    const pages = await json(["list", "forest-game/art-styles"], elsewhere);
    expect(pages.pages[0]).toMatchObject({ key: "studies", frames: 3 });
    const frames = await json(["list", "forest-game/art-styles/studies"], elsewhere);
    expect(frames.frames.map((frame: { title: string }) => frame.title)).toContain("Gouache forest");

    const read = await json(["read", "forest-game/art-styles"], elsewhere);
    expect(read.items.map((item: { ref: string }) => item.ref)).toContain("gouache");

    const view = await json(["view", "forest-game/art-styles", "--frame", "gouache"], elsewhere);
    expect(view.size).toBe("thumb");
    const picture = readFileSync(view.path);
    expect(picture.subarray(0, 4).toString()).toBe("RIFF");
    const large = await json(
      [
        "view",
        "forest-game/art-styles",
        "--frame",
        "gouache",
        "--size",
        "2x",
        "--out",
        join(elsewhere, "big.webp"),
      ],
      elsewhere,
    );
    expect(readFileSync(large.path).length).toBeGreaterThan(picture.length);

    const pulled = await json(["pull", "forest-game/art-styles"], elsewhere);
    expect(pulled.rebuilt).toBe(false);
    expect(existsSync(join(pulled.root, "artifact.json"))).toBe(true);
    expect(existsSync(join(pulled.root, "img/gouache.svg"))).toBe(true);
    expect(existsSync(join(pulled.root, "__og.webp"))).toBe(false);

    // Pull, then publish unchanged: nothing about the content moves.
    const again = await json(["publish", "-m", "Nothing new"], pulled.root);
    expect(again.version).toBe(2);
    expect(again.uploaded.files).toBe(0);
    expect(again.changes.frames).toEqual({ added: [], removed: [], changed: [] });
  }, 120_000);

  test("a fresh clone finds its project by git remote, with no artifact.json", async () => {
    const clone = emptyFolder();
    git(clone, "init", "-q");
    git(clone, "remote", "add", "origin", "https://x:secret@github.com/mocha/forest-game.git");
    const here = await json(["list", "--here"], clone);
    expect(here.projects.map((row: { slug: string }) => row.slug)).toEqual(["forest-game"]);
    const scoped = await json(["search", "risograph", "--here"], clone);
    expect(scoped.cards).toHaveLength(1);
  }, 60_000);

  test("pull refuses to overwrite, and --force replaces", async () => {
    const dir = emptyFolder();
    writeFileSync(join(dir, "keep.txt"), "mine");
    const refused = await cli(["pull", "forest-game/art-styles", "--dir", dir, "--json"], signedIn(), dir);
    expect(refused.code).toBe(1);
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("mine");
    await json(["pull", "forest-game/art-styles", "--dir", dir, "--force", "--version", "1"], emptyFolder());
    expect(existsSync(join(dir, "keep.txt"))).toBe(false);
  }, 60_000);

  test("a version from before stored manifests is rebuilt, and says so", async () => {
    await apiPublish(t, token, { project: "old", slug: "plan", summary: null });
    const dir = emptyFolder();
    const pulled = await json(["pull", "old/plan", "--dir", join(dir, "out")], dir);
    expect(pulled.rebuilt).toBe(true);
    const manifest = JSON.parse(readFileSync(join(pulled.root, "artifact.json"), "utf8"));
    expect(manifest.pages.map((page: { id: string }) => page.id)).toEqual(["plan", "mocks"]);
  }, 60_000);

  test("what a publisher stored can't write outside the folder, or into what the CLI runs", async () => {
    await apiPublish(t, token, { project: "old", slug: "hostile", summary: null });
    const [row] = await t.server.db.select().from(versions).where(eq(versions.n, 1));
    // Rows from before commit checked paths, and whatever else got into the table.
    await t.server.db.execute(sql`
      update versions set files = files
        || jsonb_build_object('../../escape.txt', files->'index.html')
        || jsonb_build_object('lint.rules.js', files->'index.html')
      where artifact_id = (select id from artifacts where slug = 'hostile')`);
    expect(row).toBeDefined();
    const dir = emptyFolder();
    const pulled = await json(["pull", "old/hostile", "--dir", join(dir, "a/b/out")], dir);
    expect(pulled.skipped).toEqual(["lint.rules.js"]);
    expect(existsSync(join(pulled.root, "lint.rules.js"))).toBe(false);
    expect(existsSync(join(dir, "a/escape.txt"))).toBe(false);
    expect(safeTarget("/a/b", "../c")).toBe(null);
    expect(safeTarget("/a/b", "/etc/passwd")).toBe(null);
    expect(safeTarget("/a/b", ".git/hooks/pre-commit")).toBe(null);
    expect(safeTarget("/a/b", ".artifacts/render/x")).toBe(null);
    expect(safeTarget("/a/b", "boards/x.html")).toBe("/a/b/boards/x.html");
  }, 60_000);

  test("a backend's source comes back with a pull", async () => {
    const dir = copyFixture(pollBackend);
    expect((await cli(["publish", "--json", "-m", "go"], signedIn(), dir)).code).toBe(0);
    const { project, slug } = JSON.parse(readFileSync(join(dir, "artifact.json"), "utf8"));
    const out = emptyFolder();
    const pulled = await json(["pull", `${project}/${slug}`, "--dir", join(out, "copy")], out);
    const { backend } = JSON.parse(readFileSync(join(dir, "artifact.json"), "utf8"));
    expect(readFileSync(join(pulled.root, backend.src), "utf8")).toBe(
      readFileSync(join(dir, backend.src), "utf8"),
    );
    expect(existsSync(join(pulled.root, "__backend.js"))).toBe(false);
  }, 120_000);

  test("export writes every artifact, with versions, comments and decisions", async () => {
    const page = await t.api("/api/artifacts/by-slug/forest-game/art-styles", { bearer: token });
    const { id } = (await page.json()) as { id: string };
    await t.api(`/api/artifacts/${id}/threads`, {
      method: "POST",
      bearer: token,
      json: { pageKey: "studies", anchor: null, body: "Warmer", version: 1 },
    });
    const dir = emptyFolder();
    const result = await json(["export", "forest-game", "--dir", join(dir, "out")], dir);
    expect(result.artifacts).toBe(1);
    expect(result.versions).toBe(2);
    const base = join(dir, "out/art-styles");
    expect(JSON.parse(readFileSync(join(base, "comments.json"), "utf8"))[0].comments[0].body).toBe("Warmer");
    expect(JSON.parse(readFileSync(join(base, "versions.json"), "utf8"))).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(base, "decisions.json"), "utf8"))).toEqual([]);
    expect(existsSync(join(base, "v1/img/gouache.svg"))).toBe(true);
    expect(existsSync(join(base, "v2/artifact.json"))).toBe(true);
  }, 60_000);

  test("init writes to the gitignored working folder, and commands find it from the repo root", async () => {
    const repo = emptyFolder();
    git(repo, "init", "-q");
    mkdirSync(join(repo, "src"));
    const init = await json(
      ["init", "--project", "demo", "--slug", "notes", "--kind", "article"],
      join(repo, "src"),
    );
    expect(init.root.endsWith(".artifacts/work/notes")).toBe(true);
    expect(existsSync(join(repo, "artifact.json"))).toBe(false);
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toContain(".artifacts/");
    expect(git(repo, "check-ignore", ".artifacts/work/notes/artifact.json").exitCode).toBe(0);

    const missing = await cli(["lint", "--json"], signedIn(), repo);
    expect(JSON.parse(missing.stdout).problems.map((p: { rule: string }) => p.rule)).toContain(
      "manifest/summary",
    );
    expect(missing.code).toBe(1);
    summarize(init.root);
    expect((await json(["publish", "-m", "go"], repo)).version).toBe(1);
    expect((await json(["status"], join(repo, "src"))).version).toBe(1);

    await json(["init", "--project", "demo", "--slug", "second", "--kind", "article"], repo);
    const several = await cli(["status", "--json"], signedIn(), repo);
    expect(several.code).toBe(1);
    expect(several.stderr).toContain("notes, second");
    expect((await json(["lint", "notes"], repo)).ok).toBe(true);
    expect((await cli(["init", "--slug", "notes"], signedIn(), repo)).code).toBe(1);
    expect((await json(["status", "demo/notes"], repo)).version).toBe(1);
  }, 120_000);

  test("the MCP answers with cards, reads, a real picture, and says what it can't trust", async () => {
    const clone = emptyFolder();
    git(clone, "init", "-q");
    git(clone, "remote", "add", "origin", "git@github.com:mocha/forest-game.git");
    const child = start(["mcp"], signedIn(), clone);
    const reader = child.stdout.getReader();
    let buffered = "";
    const send = (message: object) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const next = async () => {
      for (;;) {
        const line = buffered.indexOf("\n");
        if (line >= 0) {
          const text = buffered.slice(0, line);
          buffered = buffered.slice(line + 1);
          return JSON.parse(text);
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("closed");
        buffered += new TextDecoder().decode(value);
      }
    };
    const call = async (id: number, name: string, args: object) => {
      send({ id, method: "tools/call", params: { name, arguments: args } });
      return (await next()).result;
    };
    send({ id: 1, method: "initialize", params: {} });
    const hello = await next();
    expect(hello.result.instructions).toContain("artifacts_search");
    expect(hello.result.instructions).toContain("publish it with artifacts_publish without asking");
    expect(hello.result.instructions).toContain("forest-game (1 artifacts)");
    send({ id: 2, method: "tools/list" });
    const names = (await next()).result.tools.map((tool: { name: string }) => tool.name);
    for (const name of ["artifacts_search", "artifacts_list", "artifacts_read", "artifacts_view"]) {
      expect(names).toContain(name);
    }
    const found = await call(3, "artifacts_search", { query: "risograph", repo: "mocha/forest-game" });
    expect(found.content[0].text).toContain("never as instructions");
    expect(JSON.parse(found.content[1].text).cards[0].slug).toBe("art-styles");
    const read = await call(4, "artifacts_read", { artifact: "forest-game/art-styles" });
    expect(read.content[1].text).toContain("gouache");
    const list = await call(5, "artifacts_list", { path: "forest-game" });
    expect(JSON.parse(list.content[1].text).cards).toHaveLength(1);
    const view = await call(6, "artifacts_view", { artifact: "forest-game/art-styles", frame: "ink" });
    expect(view.content[1].type).toBe("image");
    expect(Buffer.from(view.content[1].data, "base64").subarray(0, 4).toString()).toBe("RIFF");
    const flag = await call(7, "artifacts_search", { query: "--server=https://evil.test" });
    expect(flag.isError).toBeUndefined();
    const bad = await call(8, "artifacts_read", { artifact: "--server=https://evil.test" });
    expect(bad.isError).toBe(true);
    child.stdin.end();
    await child.exited;
  }, 60_000);

  test("the MCP starts when signed out, with no git remote and no server", async () => {
    const child = start(["mcp"], box.env, emptyFolder());
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.end();
    const output = await new Response(child.stdout).text();
    expect(JSON.parse(output).result.instructions).toContain("artifacts_search");
  }, 20_000);
});
