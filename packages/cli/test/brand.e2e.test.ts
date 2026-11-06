import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VersionBundle } from "@artifacts/schema";
import { OWNER, signIn, type TestServer } from "../../../apps/server/test/helpers.ts";
import { makePerson } from "../../../apps/server/test/publish-helper.ts";
import { cli, cliJson, hostedServer, sandbox, versionOf } from "./sandbox.ts";

const ACCENT = "#00a36c";

describe("brand", () => {
  let t: TestServer;
  let url: string;
  let token: string;
  let cookie: string;
  let reviewer: string;
  let stopped = false;
  const box = sandbox();
  const env = () => ({ ...box.env, ARTIFACTS_URL: url, ARTIFACTS_TOKEN: token });
  const folder = mkdtempSync(join(tmpdir(), "artifacts-brand-guide-"));
  const json = (args: string[], cwd = folder) => cliJson(args, env(), cwd);
  /** The theme the server stored for an artifact's article, in its latest version. */
  const articleTheme = async (slug: string) => {
    const { version } = await versionOf(t, token, `use/${slug}`);
    const page = version.pages.find((entry) => entry.key === "doc");
    return page?.kind === "article" ? page.theme : undefined;
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
    let orgId: string;
    ({ t, url, token, orgId } = await hostedServer());
    cookie = await signIn(t, OWNER.email, OWNER.password);
    reviewer = (await makePerson(t, orgId, "reviewer")).token;
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

    // Only a person applies it (who may: api/brand.test.ts).
    const apply = `/api/brand/proposals/${proposed.id}/apply`;
    expect((await t.api(apply, { method: "POST", cookie })).status).toBe(200);
    expect((await json(["brand", "show"])).brand.name).toBe("Acme");
    const list = (await json(["brand", "show"])).proposals;
    expect(list[0].appliedAt).not.toBe(null);
    expect(list[0].sample.slug).toBe(slug);
  }, 180_000);

  test("precedence: a template gives way to the brand, and the brand to a project's theme", async () => {
    const plain = await template("branded");
    await json(["publish", "-m", "go"], plain);
    expect((await articleTheme("branded"))?.accent).toBe(ACCENT);
    const own = await template("own-theme", { theme: { accent: "#123456" } });
    await json(["publish", "-m", "go"], own);
    expect((await articleTheme("own-theme"))?.accent).toBe("#123456");
    // The brand's fonts go up with the bundle, so the article can use them.
    expect(existsSync(join(plain, ".artifacts/brand-fonts"))).toBe(true);
    const bundle = VersionBundle.parse(
      await (await t.api("/api/library/projects/use/branded/bundle", { bearer: token })).json(),
    );
    expect(bundle.files.some((entry) => entry.path.startsWith(".artifacts/brand-fonts/"))).toBe(true);
  }, 120_000);

  test("taking a brand off reaches the next render, and a pull leaves its fonts out", async () => {
    const dir = await template("pulled");
    await json(["publish", "-m", "go"], dir);
    const out = mkdtempSync(join(tmpdir(), "artifacts-brand-pull-"));
    const pulled = await json(["pull", "use/pulled", "--dir", join(out, "copy")], out);
    expect(existsSync(join(pulled.root, ".artifacts"))).toBe(false);
    expect((await t.api("/api/brand", { method: "DELETE", cookie })).status).toBe(200);
    await json(["publish", "-m", "again"], dir);
    expect((await articleTheme("pulled"))?.accent).toBe("#8a1c2b");
    // Back on, for the offline render below.
    const proposals = (await json(["brand", "show"])).proposals;
    expect(
      (await t.api(`/api/brand/proposals/${proposals[0].id}/apply`, { method: "POST", cookie })).status,
    ).toBe(200);
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
