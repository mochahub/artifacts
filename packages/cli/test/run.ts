import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Running the CLI in a throwaway home. Apart from sandbox.ts so a test of the CLI alone doesn't load the server. */
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

/** Runs a command with --json and returns what it printed, parsed. Throws with its stderr if it fails. */
export async function cliJson(args: string[], env: Record<string, string>, cwd?: string) {
  const result = await cli([...args, "--json"], env, cwd);
  if (result.code !== 0) throw new Error(`${args.join(" ")} exited ${result.code}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
