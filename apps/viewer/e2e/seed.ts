import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dirname, "../../../packages/cli/src/index.ts");
const fixture = join(import.meta.dirname, "../../../fixtures/camerabuddy-roadmap");
const URL_ = "http://localhost:18080";

const envFor = (dir: string, token: string) => ({
  PATH: process.env.PATH ?? "",
  HOME: dir,
  ARTIFACTS_URL: URL_,
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
  const publish = (message: string) =>
    execFileSync("bun", [cli, "publish", "-m", message, "--json"], { cwd: dir, env, stdio: "pipe" });
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
export function publishCopy(slug: string, token: string, twice = false) {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-e2e-"));
  cpSync(fixture, dir, { recursive: true });
  const manifest = join(dir, "artifact.json");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8")
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
