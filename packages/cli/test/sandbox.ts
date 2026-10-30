import { cpSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const CLI = join(import.meta.dir, "../src/index.ts");

/** Real browsers, shared between runs: downloading WebKit per test would take minutes. */
const browsers =
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
  join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");

/** A throwaway home: tests must never touch the real keychain, config or skills folders. */
export function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "artifacts-cli-"));
  return {
    home,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      ARTIFACTS_CREDENTIALS: "file",
      ARTIFACTS_NO_BROWSER: "1",
      ARTIFACTS_HELPER_DIR: join(tmpdir(), "artifacts-test-helper"),
      PLAYWRIGHT_BROWSERS_PATH: browsers,
    } as Record<string, string>,
  };
}

export function start(args: string[], env: Record<string, string>, cwd?: string) {
  return Bun.spawn(["bun", CLI, ...args], { env, cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

export async function cli(args: string[], env: Record<string, string>, cwd?: string) {
  const child = start(args, env, cwd);
  child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

/** A private copy of a fixture, so a test can edit it. */
export function copyFixture(from: string) {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-fixture-"));
  cpSync(from, dir, { recursive: true });
  return dir;
}

export const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
export const camerabuddy = join(import.meta.dir, "../../../fixtures/camerabuddy-roadmap");
