import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Artifact, VersionDetail } from "@artifacts/schema";
import { claim, startTestServer, type TestServer, testPort } from "../../../apps/server/test/helpers.ts";

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

/** A stand-in program: writes `script` as an executable `name` in `bin`, to put first on PATH. */
export function fakeBin(bin: string, name: string, script: string) {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
  return bin;
}

/** A claimed server at an address the CLI can reach, with the owner's token. */
export async function hostedServer(overrides: Record<string, string> = {}) {
  const port = testPort();
  const url = `http://127.0.0.1:${port}`;
  const t = await startTestServer({ PUBLIC_URL: url, MORE_URLS: "", PORT: String(port), ...overrides });
  return { t, url, ...(await claim(t)) };
}

/** An artifact found by its project/slug path, the way the viewer finds it. */
export async function artifactAt(t: TestServer, bearer: string, path: string) {
  const found = await t.api(`/api/artifacts/by-slug/${path}`, { bearer });
  if (found.status !== 200) throw new Error(`${path}: ${found.status} ${await found.text()}`);
  return Artifact.parse(await found.json());
}

/** An artifact and one of its versions (the latest unless `n` says), read the way the viewer reads them. */
export async function versionOf(t: TestServer, bearer: string, path: string, n?: number) {
  const artifact = await artifactAt(t, bearer, path);
  const response = await t.api(`/api/artifacts/${artifact.id}/versions/${n ?? artifact.latestVersion}`, {
    bearer,
  });
  if (response.status !== 200) throw new Error(`${path} v${n}: ${response.status}`);
  return { artifact, version: VersionDetail.parse(await response.json()) };
}

/** A private copy of a fixture, so a test can edit it. */
export function copyFixture(from: string) {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-fixture-"));
  cpSync(from, dir, { recursive: true });
  return dir;
}

export const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
export const camerabuddy = join(import.meta.dir, "../../../fixtures/camerabuddy-roadmap");
