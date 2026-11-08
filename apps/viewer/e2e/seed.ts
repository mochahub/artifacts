import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_URL } from "./stack.ts";

const cli = join(import.meta.dirname, "../../../packages/cli/src/index.ts");
const preparedPublisher = join(import.meta.dirname, "prepared-fixture.js");
const cachePrefix = (token: string) =>
  join(tmpdir(), `artifacts-e2e-prepared-${createHash("sha256").update(token).digest("hex")}`);

const fixture = join(import.meta.dirname, "../../../fixtures/camerabuddy-roadmap");

const envFor = (dir: string, token: string) => ({
  PATH: process.env.PATH ?? "",
  HOME: dir,
  ARTIFACTS_URL: BASE_URL,
  ARTIFACTS_TOKEN: token,
  ARTIFACTS_HELPER_DIR: join(tmpdir(), "artifacts-test-helper"),
  ARTIFACTS_AGENT: "Claude Code",
  PLAYWRIGHT_BROWSERS_PATH:
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright"),
});

/** Publishes the CameraBuddy fixture twice with the real CLI, so v2 has changes to show. */
export function seedFixture(token: string) {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-e2e-"));
  cpSync(fixture, dir, { recursive: true });
  const env = envFor(dir, token);
  let version = 0;
  const publish = (message: string) =>
    execFileSync("bun", [preparedPublisher, `${cachePrefix(token)}-${++version}.json`, "capture", message], {
      cwd: dir,
      env,
      stdio: "pipe",
    });
  publish("First draft");

  const board = join(dir, "boards/02-shoot.html");
  writeFileSync(board, readFileSync(board, "utf8").replace("../img/02-01.jpg", "../img/02-03.jpg"));
  const plan = join(dir, "README.md");
  writeFileSync(
    plan,
    readFileSync(plan, "utf8").replace("Ship pairing, live view", "Ship pairing, a faster live view"),
  );
  publish("Move MF above the strip");
}

/** The fixture again under another slug, for tests that change an artifact's lifecycle. */
export function publishCopy(slug: string, token: string, twice = false, project = "camerabuddy") {
  // These tests change identity, permissions or comments, not source pixels. Claim already
  // rendered both immutable versions with the real CLI; each copy still prepares/uploads/commits
  // through the real API and receives fresh artifact IDs. Custom projects keep the CLI path.
  if (project === "camerabuddy") return publishPreparedCopy(slug, token, twice);
  const dir = mkdtempSync(join(tmpdir(), "artifacts-e2e-"));
  cpSync(fixture, dir, { recursive: true });
  const manifest = join(dir, "artifact.json");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8")
      .replace('"project": "camerabuddy"', `"project": "${project}"`)
      .replace('"slug": "roadmap"', `"slug": "${slug}"`)
      .replace('"title": "Camera Buddy roadmap"', `"title": "Roadmap ${slug}"`),
  );
  const publish = () =>
    execFileSync("bun", [cli, "publish", "--json"], { cwd: dir, env: envFor(dir, token), stdio: "pipe" });
  publish();
  if (twice) {
    const board = join(dir, "boards/02-shoot.html");
    writeFileSync(board, readFileSync(board, "utf8").replace("../img/02-01.jpg", "../img/02-03.jpg"));
    publish();
  }
}

/** Another fixture from the repo, under a slug of its own. */
export function publishFixture(name: string, slug: string, token: string) {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-e2e-"));
  cpSync(join(import.meta.dirname, "../../../fixtures", name), dir, { recursive: true });
  const manifest = join(dir, "artifact.json");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace(/"slug": "[^"]+"/, `"slug": "${slug}"`));
  execFileSync("bun", [cli, "publish", "--json"], { cwd: dir, env: envFor(dir, token), stdio: "pipe" });
}

/** Fresh artifact IDs and real publish validation/uploads, reusing claim's immutable rendered fixture. */
export function publishPreparedCopy(slug: string, token: string, twice = false) {
  const list = `${cachePrefix(token)}-${slug}.json`;
  writeFileSync(
    list,
    JSON.stringify(Array.from({ length: twice ? 2 : 1 }, (_, i) => `${cachePrefix(token)}-${i + 1}.json`)),
  );
  execFileSync("bun", [preparedPublisher, list, "copy", slug, `Roadmap ${slug}`], {
    env: envFor(tmpdir(), token),
    stdio: "pipe",
  });
}
