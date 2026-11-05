import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq } from "drizzle-orm";
import { pages, versions } from "../../../apps/server/src/db/schema.ts";
import {
  OWNER,
  signIn,
  startTestServer,
  type TestServer,
  testPort,
} from "../../../apps/server/test/helpers.ts";
import { makePerson } from "../../../apps/server/test/publish-helper.ts";
import { cli, sandbox } from "./sandbox.ts";

const ACCENT = "#00a36c";

describe("brand", () => {
  let t: TestServer;
  let url: string;
  let token: string;
  let cookie: string;
  let reviewer: string;
  let member: string;
  let stopped = false;
  const box = sandbox();
  const env = () => ({ ...box.env, ARTIFACTS_URL: url, ARTIFACTS_TOKEN: token });
  const folder = mkdtempSync(join(tmpdir(), "artifacts-brand-guide-"));
  const json = async (args: string[], cwd = folder) => {
    const result = await cli([...args, "--json"], env(), cwd);
    if (result.code !== 0) throw new Error(`${args.join(" ")}: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const articleTheme = async () => {
    const [row] = await t.server.db
      .select({ meta: pages.meta })
      .from(pages)
      .innerJoin(versions, eq(versions.id, pages.versionId))
      .where(eq(pages.pageKey, "doc"))
      .orderBy(desc(versions.id))
      .limit(1);
    return (row?.meta as { theme?: { accent?: string } } | undefined)?.theme;
  };
  const template = async (slug: string, extra: object = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "artifacts-brand-use-"));
    await json(["init", "--template", "rfc", "--project", "use", "--slug", slug, "--in-repo"], dir);
    const path = join(dir, "artifact.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...manifest, summary: "Mine.", ...extra }));
    return dir;
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
    cookie = await signIn(t, OWNER.email, OWNER.password);
    const [org] = await t.server.db.query.org.findMany();
    reviewer = await makePerson(t, (org as { id: string }).id, "reviewer");
    member = await makePerson(t, (org as { id: string }).id, "member");
    mkdirSync(join(folder, "fonts"));
    writeFileSync(join(folder, "fonts/acme.woff2"), "a stand-in for a font file");
    writeFileSync(
      join(folder, "brand.json"),
      JSON.stringify({
        name: "Acme",
        theme: { accent: ACCENT, font: "Acme Sans", display: "serif", radius: 6 },
        fonts: [{ family: "Acme Sans", weight: "400", src: "fonts/acme.woff2" }],
      }),
    );
  }, 60_000);
  afterAll(async () => {
    if (!stopped) await t.stop();
  });

  test("the prompt mentions the licence, and points at the guide", async () => {
    const { prompt } = await json(["brand", "prompt"]);
    expect(prompt).toContain("licensed");
    expect(prompt).toContain("references/brand.md");
  });

  test("a bad brand file is refused before anything leaves the machine", async () => {
    writeFileSync(join(folder, "bad.json"), JSON.stringify({ name: "x", theme: { accent: "red;}" } }));
    expect((await cli(["brand", "preview", "bad.json"], env(), folder)).code).toBe(1);
    writeFileSync(
      join(folder, "escape.json"),
      JSON.stringify({ name: "x", theme: {}, fonts: [{ family: "A", weight: "400", src: "../secret" }] }),
    );
    const outside = await cli(["brand", "preview", "escape.json"], env(), folder);
    expect(outside.stderr).toContain("Keep fonts beside");
  });

  test("an agent goes from a design guide to a reviewed sample; a person applies it", async () => {
    const preview = await json(["brand", "preview", "brand.json"]);
    expect(preview.frames).toBeGreaterThan(10);
    expect(existsSync(preview.contactSheet)).toBe(true);

    const proposed = await json(["brand", "propose", "brand.json"]);
    expect(proposed.url).toContain("/brand/sample-");
    // Nothing changes yet, and a reviewer can read the sample and comment.
    expect((await json(["brand", "show"])).brand).toBe(null);
    const slug = proposed.url.split("/").pop();
    const artifact = (await (
      await t.api(`/api/artifacts/by-slug/brand/${slug}`, { bearer: reviewer })
    ).json()) as {
      id: string;
      pages: { key: string }[];
    };
    expect(artifact.pages.length).toBeGreaterThan(10);
    const comment = await t.api(`/api/artifacts/${artifact.id}/threads`, {
      method: "POST",
      bearer: reviewer,
      json: { pageKey: artifact.pages[0]?.key, anchor: null, body: "Looks like us", version: 1 },
    });
    expect(comment.status).toBe(200);

    const apply = `/api/brand/proposals/${proposed.id}/apply`;
    for (const bearer of [token, member, reviewer]) {
      expect((await t.api(apply, { method: "POST", bearer })).status).toBe(403);
    }
    expect((await t.api("/api/brand", { method: "DELETE", bearer: token })).status).toBe(403);
    expect((await json(["brand", "show"])).brand).toBe(null);
    expect((await t.api(apply, { method: "POST", cookie })).status).toBe(200);
    expect((await json(["brand", "show"])).brand.name).toBe("Acme");
    const list = (await json(["brand", "show"])).proposals;
    expect(list[0].appliedAt).not.toBe(null);
    expect(list[0].sample.slug).toBe(slug);
  }, 180_000);

  test("who may propose, and a font that isn't in the sample", async () => {
    const bad = {
      brand: {
        name: "x",
        theme: {},
        fonts: [{ family: "A", weight: "400", format: "woff2", hash: "a".repeat(64) }],
      },
      project: "brand",
    };
    const [, slug] = (await json(["brand", "show"])).proposals[0].sample
      ? [0, (await json(["brand", "show"])).proposals[0].sample.slug]
      : [];
    const post = (bearer: string) =>
      t.api("/api/brand/proposals", { method: "POST", bearer, json: { ...bad, slug } });
    expect((await post(token)).status).toBe(400);
    expect((await post(reviewer)).status).toBe(403);
    expect((await t.api("/api/brand/proposals/nonsense/apply", { method: "POST", cookie })).status).toBe(404);
  }, 30_000);

  test("precedence: a template gives way to the brand, and the brand to a project's theme", async () => {
    const plain = await template("branded");
    await json(["publish", "-m", "go"], plain);
    expect((await articleTheme())?.accent).toBe(ACCENT);
    const own = await template("own-theme", { theme: { accent: "#123456" } });
    await json(["publish", "-m", "go"], own);
    expect((await articleTheme())?.accent).toBe("#123456");
    expect(existsSync(join(plain, ".artifacts/brand-fonts"))).toBe(true);
    const [version] = await t.server.db.select().from(versions).orderBy(desc(versions.id)).limit(1);
    const paths = Object.keys(version?.files as object);
    expect(paths.some((path) => path.startsWith(".artifacts/brand-fonts/"))).toBe(true);
  }, 120_000);

  test("taking a brand off reaches the next render, and a pull leaves its fonts out", async () => {
    const dir = await template("pulled");
    await json(["publish", "-m", "go"], dir);
    const out = mkdtempSync(join(tmpdir(), "artifacts-brand-pull-"));
    const pulled = await json(["pull", "use/pulled", "--dir", join(out, "copy")], out);
    expect(existsSync(join(pulled.root, ".artifacts"))).toBe(false);
    expect((await t.api("/api/brand", { method: "DELETE", cookie })).status).toBe(200);
    await json(["publish", "-m", "again"], dir);
    expect((await articleTheme())?.accent).toBe("#8a1c2b");
    const proposals = (await json(["brand", "show"])).proposals;
    await t.api(`/api/brand/proposals/${proposals[0].id}/apply`, { method: "POST", cookie });
    await json(["render"], dir);
  }, 120_000);

  test("offline, a render uses the cached brand and says so", async () => {
    const dir = await template("offline");
    await t.stop();
    stopped = true;
    const started = Date.now();
    const result = await cli(["render", "--json"], env(), dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("cached on");
    expect(existsSync(join(dir, ".artifacts/brand-fonts"))).toBe(true);
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 90_000);
});
