import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { TEMPLATES } from "@artifacts/kit/templates";
import type { TestServer } from "../../../apps/server/test/helpers.ts";
import { cli, cliJson, hostedServer, sandbox, versionOf } from "./sandbox.ts";

const NAMES = Object.keys(TEMPLATES);
const kit = join(import.meta.dir, "../../kit/src/templates");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

test("the embedded templates are every file in the kit's folders", () => {
  expect(NAMES.sort()).toEqual(readdirSync(kit).sort());
  for (const name of NAMES) {
    const onDisk = walk(join(kit, name)).map((path) => relative(join(kit, name), path).replace(/\.txt$/, ""));
    expect(
      Object.keys(TEMPLATES[name] as object)
        .map((p) => p.replace(/\.txt$/, ""))
        .sort(),
    ).toEqual(onDisk.sort());
  }
});

test("each template's text carries none of the forbidden patterns", () => {
  for (const name of NAMES) {
    for (const [path, body] of Object.entries(TEMPLATES[name] as Record<string, string>)) {
      expect(`${path}: ${/\sborder-left\s*:|backdrop-filter|linear-gradient\([^)]*#|\s·\s/.test(body)}`).toBe(
        `${path}: false`,
      );
      expect(body.includes("/Users/")).toBe(false);
    }
  }
});

test("--template and --kind don't mix, and a wrong name lists the right ones", async () => {
  const box = sandbox();
  const both = await cli(["init", "--template", "prd", "--kind", "article"], box.env, box.home);
  expect(both.code).toBe(2);
  const wrong = await cli(["init", "--template", "constructor"], box.env, box.home);
  expect(wrong.code).toBe(2);
  expect(wrong.stderr).toContain("weekly-status");
});

describe("templates", () => {
  let t: TestServer;
  let url: string;
  let token: string;
  const box = sandbox();
  const env = () => ({ ...box.env, ARTIFACTS_URL: url, ARTIFACTS_TOKEN: token });
  const folders = new Map<string, string>();

  beforeAll(async () => {
    ({ t, url, token } = await hostedServer());
  });
  afterAll(() => t.stop());

  for (const name of NAMES) {
    test(`${name} initializes, lints clean, renders and publishes`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `artifacts-template-${name}-`));
      const init = await cli(
        ["init", "--template", name, "--project", "templates", "--slug", name, "--in-repo", "--json"],
        env(),
        dir,
      );
      expect(init.code).toBe(0);
      folders.set(name, dir);
      const lint = await cliJson(["lint"], env(), dir);
      expect(lint.problems).toEqual([]);
      expect(lint.ok).toBe(true);
      const published = await cli(["publish", "--json", "-m", "First"], env(), dir);
      expect(published.stderr).toContain("still the template's");
      expect(published.code).toBe(0);
      expect(JSON.parse(published.stdout).version).toBe(1);
    }, 90_000);
  }

  test("one accent reaches every template, on canvases and in article pages", async () => {
    const accent = "#00a36c";
    let articles = 0;
    for (const name of NAMES) {
      const dir = folders.get(name) as string;
      const path = join(dir, "artifact.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...manifest, summary: "Mine.", theme: { accent } }));
      const body = await cliJson(["publish", "-m", "Rebrand"], env(), dir);
      expect(body.version).toBe(2);
      // Pixels, not the stylesheet: every template has at least one frame that really changed.
      expect(body.changes.frames.changed.length).toBeGreaterThan(0);
      const { version } = await versionOf(t, token, `templates/${name}`, 2);
      for (const page of version.pages) {
        if (page.kind !== "article") continue;
        articles += 1;
        expect(`${name}/${page.key}: ${page.theme?.accent}`).toBe(`${name}/${page.key}: ${accent}`);
      }
    }
    // Some templates are articles, so the check above ran.
    expect(articles).toBeGreaterThan(0);
  }, 240_000);
});
