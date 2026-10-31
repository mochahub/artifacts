import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "es-module-lexer";
import { crawl, jsRefs } from "../src/bundle/crawl.ts";
import { loadManifest } from "../src/bundle/manifest.ts";
import { copyFixture, fixture } from "./sandbox.ts";

async function crawlWith(board: string, prepare: (dir: string) => void = () => {}) {
  const dir = copyFixture(fixture("small"));
  writeFileSync(join(dir, "boards/main.html"), board);
  prepare(dir);
  const { manifest } = loadManifest(dir);
  return crawl(dir, manifest as NonNullable<typeof manifest>);
}

describe("what a bundle may reach", () => {
  test("a link to a file outside the folder isn't followed, so it can't be published", async () => {
    const secrets = mkdtempSync(join(tmpdir(), "artifacts-secrets-"));
    writeFileSync(join(secrets, "id_rsa"), "PRIVATE KEY");
    const { files, problems } = await crawlWith(
      '<div data-frame="one"><img src="../photo.png"></div>',
      (dir) => symlinkSync(join(secrets, "id_rsa"), join(dir, "photo.png")),
    );
    expect(files.has("photo.png")).toBe(false);
    expect(problems.map((problem) => problem.rule)).toContain("files/outside");
  });

  test("a link to a file inside the folder is fine", async () => {
    const { files, problems } = await crawlWith(
      '<div data-frame="one"><img src="../alias.png"></div>',
      (dir) => {
        mkdirSync(join(dir, "assets"));
        writeFileSync(join(dir, "assets/real.png"), "png");
        symlinkSync(join(dir, "assets/real.png"), join(dir, "alias.png"));
      },
    );
    expect(files.has("alias.png")).toBe(true);
    expect(problems).toEqual([]);
  });

  test("a stray % in a reference is a missing file, not a crash", async () => {
    const { problems } = await crawlWith('<div data-frame="one"><img src="../100%.png"></div>');
    expect(problems.map((problem) => problem.rule)).toEqual(["files/missing"]);
  });
});

describe("the references in a script", () => {
  test("named files count, and an import worked out at run time doesn't", async () => {
    await init;
    const js =
      'import a from "./a.js"; export * from "./b.js"; import("./c.js"); import(`./d/${x}.js`); import(x); import.meta.url;';
    expect(jsRefs(js)).toEqual(["./a.js", "./b.js", "./c.js"]);
  });
});
