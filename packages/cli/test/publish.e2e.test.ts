import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { artifacts, blocks, frames, pages, versions } from "../../../apps/server/src/db/schema.ts";
import { OWNER, signIn, startTestServer, type TestServer } from "../../../apps/server/test/helpers.ts";
import { camerabuddy, cli, copyFixture, fixture, sandbox } from "./sandbox.ts";

const lint = async (name: string, env: Record<string, string>) => {
  const result = await cli(["lint", "--json"], env, fixture(name));
  return { code: result.code, ...JSON.parse(result.stdout) } as {
    code: number;
    ok: boolean;
    problems: { rule: string; severity: string; message: string }[];
  };
};

describe("lint catches seeded problems", () => {
  const { env } = sandbox();
  const cases = [
    ["overlap", "frames/overlap"],
    ["clipped", "frames/clipped"],
    ["random", "frames/deterministic"],
    ["home", "frames/home-indicator"],
    ["offscreen", "frames/offscreen"],
  ] as const;

  for (const [name, rule] of cases) {
    test(name, async () => {
      const result = await lint(name, env);
      expect(result.code).toBe(1);
      expect(result.problems.map((problem) => problem.rule)).toContain(rule);
    }, 60_000);
  }

  test("low contrast is a warning, not a failure", async () => {
    const result = await lint("contrast", env);
    expect(result.code).toBe(0);
    expect(result.problems).toContainEqual(
      expect.objectContaining({ rule: "contrast/text", severity: "warning" }),
    );
  }, 60_000);

  test("data rules: storage outside the kit, and fixtures for data", async () => {
    const dir = copyFixture(fixture("small"));
    writeFileSync(
      join(dir, "boards/main.html"),
      `${readFileSync(join(dir, "boards/main.html"), "utf8")}<script>localStorage.setItem("a","1");fetch("https://x.test/y")</script>`,
    );
    const bad = await cli(["lint", "--json"], env, dir);
    const rules = JSON.parse(bad.stdout).problems.map((problem: { rule: string }) => problem.rule);
    expect(rules.filter((rule: string) => rule === "data/api")).toHaveLength(2);
    expect(bad.code).toBe(1);
  }, 60_000);

  test("files and ids", async () => {
    const result = await lint("refs", env);
    const rules = result.problems.map((problem) => problem.rule);
    for (const rule of ["files/missing", "files/absolute", "files/outside", "frames/ids"]) {
      expect(rules).toContain(rule);
    }
    expect(result.code).toBe(1);
  }, 60_000);

  test("a broken manifest reports its path", async () => {
    const dir = copyFixture(fixture("small"));
    writeFileSync(join(dir, "artifact.json"), '{ "project": "API", "slug": "x", "pages": [] }');
    const result = await cli(["lint", "--json"], env, dir);
    const body = JSON.parse(result.stdout);
    expect(body.problems[0].rule).toBe("manifest/schema");
    expect(result.code).toBe(1);
  });
});

describe("publishing with the real CLI", () => {
  let t: TestServer;
  let url: string;
  const box = sandbox();
  const signedIn = () => ({ ...box.env, ARTIFACTS_URL: url, ARTIFACTS_TOKEN: token });
  let token: string;

  beforeAll(async () => {
    const port = 47500 + Math.floor(Math.random() * 2000);
    url = `http://127.0.0.1:${port}`;
    t = await startTestServer({ PUBLIC_URL: url, MORE_URLS: "", PORT: String(port) });
    const setup = await t.api("/api/setup", {
      method: "POST",
      json: { setupToken: "s".repeat(48), orgName: "Mochahub", clientName: "x", ...OWNER },
    });
    token = ((await setup.json()) as { token: string }).token;
  });
  afterAll(() => t.stop());

  test("publish, republish uploads nothing, and a CSS change reports the right frames", async () => {
    const dir = copyFixture(fixture("small"));
    const publish = async (...args: string[]) => {
      const result = await cli(["publish", "--json", "-m", "go", ...args], signedIn(), dir);
      expect(result.stderr).not.toContain("✗");
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout);
    };

    const first = await publish("--note", "one=Hello");
    expect(first.version).toBe(1);
    expect(first.changes.frames.added.sort()).toEqual(["one", "two"]);

    const second = await publish();
    expect(second.version).toBe(2);
    expect(second.uploaded.files).toBe(0);
    expect(second.changes.frames.changed).toEqual([]);
    expect(second.changes.blocks.changed).toEqual([]);

    // A change in shared CSS that only touches one frame's pixels.
    const css = join(dir, "style.css");
    writeFileSync(css, `${readFileSync(css, "utf8")}\n.b { color: #c00; }\n`);
    const third = await publish();
    expect(third.version).toBe(3);
    expect(third.changes.frames.changed).toEqual(["two"]);

    const edited = join(dir, "README.md");
    writeFileSync(edited, readFileSync(edited, "utf8").replace("Second paragraph", "Changed paragraph"));
    const fourth = await publish();
    expect(fourth.changes.frames.changed).toEqual([]);
    expect(fourth.changes.blocks.changed).toEqual(["plan/next/p1"]);
  }, 120_000);

  test("the CameraBuddy fixture publishes whole", async () => {
    const dir = copyFixture(camerabuddy);
    const result = await cli(["publish", "--json", "-m", "First"], signedIn(), dir);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.changes.frames.added).toHaveLength(26);
    expect(existsSync(join(dir, ".artifacts/contact-sheet.png"))).toBe(true);

    const [artifact] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "roadmap"));
    const [version] = await t.server.db
      .select()
      .from(versions)
      .where(eq(versions.artifactId, artifact?.id as string));
    const id = version?.id as string;
    expect(await t.server.db.select().from(pages).where(eq(pages.versionId, id))).toHaveLength(9);
    expect(await t.server.db.select().from(frames).where(eq(frames.versionId, id))).toHaveLength(26);
    expect((await t.server.db.select().from(blocks).where(eq(blocks.versionId, id))).length).toBeGreaterThan(
      30,
    );

    const article = await t.api(`/api/artifacts/${artifact?.id}/v/1/article/plan`, { bearer: token });
    const html = await article.text();
    expect(html).toContain('data-block="phase-1"');
    expect(html).toContain('data-verdict="verified"');
    expect(html).toContain('data-callout="note"');
    expect(html).toContain("artifacts:blob/");
    expect(html).toContain("<svg");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("foreignObject");
  }, 120_000);

  test("a backend publishes, runs, keeps logs, and its data exports with names", async () => {
    const dir = copyFixture(join(import.meta.dir, "../../../fixtures/micro-app-poll-backend"));
    const published = await cli(["publish", "--json"], signedIn(), dir);
    expect(published.stderr).not.toContain("✗");
    expect(published.code).toBe(0);
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "poll-backend"));
    expect(row?.hasBackend).toBe(true);
    const [version] = await t.server.db
      .select()
      .from(versions)
      .where(eq(versions.artifactId, row?.id as string));
    expect(version?.backendHash).toMatch(/^[0-9a-f]{64}$/);

    const cookie = await signIn(t, OWNER.email, OWNER.password);
    const headers = { Host: new URL(url).host, Origin: url };
    const mint = await t.api(`/api/artifacts/${row?.id}/content-token`, {
      method: "POST",
      cookie,
      json: { version: 1 },
      headers,
    });
    const { base } = (await mint.json()) as { base: string };
    const response = await fetch(
      `http://127.0.0.1:${t.server.ports.content}${new URL(base).pathname}api/votes`,
      {
        method: "POST",
        headers: {
          Host: new URL(t.server.deps.env.contentUrl as string).host,
          "Sec-Fetch-Dest": "empty",
          "Content-Type": "application/json",
        },
        body: '{"choice":"a"}',
      },
    );
    expect(await response.json()).toMatchObject({ totals: { a: 1, b: 0 }, mine: "a", name: "Zahin" });

    const logs = JSON.parse((await cli(["logs", "--json"], signedIn(), dir)).stdout);
    expect(logs[0].message).toBe("vote from Zahin");
    const exported = JSON.parse((await cli(["data", "export"], signedIn(), dir)).stdout);
    expect(Object.keys(exported.shared.votes.by)).toHaveLength(1);
    const listed = JSON.parse((await cli(["data", "ls", "--json"], signedIn(), dir)).stdout);
    expect(listed[0].key).toBe("votes");
    const got = JSON.parse((await cli(["data", "get", "votes", "--json"], signedIn(), dir)).stdout);
    expect(got.schema).toBe(1);
    expect((await cli(["data", "clear", "--json"], signedIn(), dir)).code).toBe(0);
    expect(JSON.parse((await cli(["data", "ls", "--json"], signedIn(), dir)).stdout)).toEqual([]);
  }, 120_000);

  test("backend lint: network calls and anything unbundled are refused", async () => {
    const dir = copyFixture(join(import.meta.dir, "../../../fixtures/micro-app-poll-backend"));
    writeFileSync(
      join(dir, "api/index.js"),
      'export default { async fetch() { await fetch("https://x.test"); setTimeout(() => {}, 1); return new Response(""); } };',
    );
    const result = await cli(["lint", "--json"], box.env, dir);
    const body = JSON.parse(result.stdout);
    expect(
      body.problems.filter((p: { rule: string }) => p.rule === "backend/network").length,
    ).toBeGreaterThanOrEqual(2);
    expect(result.code).toBe(1);
  }, 60_000);

  test("init makes something that renders", async () => {
    const dir = copyFixture(fixture("refs"));
    for (const file of ["artifact.json", "board.html"]) Bun.spawnSync(["rm", join(dir, file)]);
    expect((await cli(["init", "--project", "demo", "--slug", "fresh"], box.env, dir)).code).toBe(0);
    expect((await cli(["init"], box.env, dir)).code).toBe(1);
    const result = await cli(["lint", "--json"], box.env, dir);
    expect(JSON.parse(result.stdout).problems).toEqual([]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".artifacts/");
    expect(existsSync(join(dir, "vendor/artifacts-kit/frames.js"))).toBe(true);
  }, 60_000);

  test("a lint error stops a publish", async () => {
    const dir = copyFixture(fixture("overlap"));
    const result = await cli(["publish"], signedIn(), dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nothing was published");
  }, 60_000);
});
