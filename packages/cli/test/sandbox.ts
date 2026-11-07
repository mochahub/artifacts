import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Artifact, VersionDetail } from "@artifacts/schema";
import { claim, startTestServer, type TestServer, testPort } from "../../../apps/server/test/helpers.ts";

export { CLI, cli, cliJson, sandbox, start } from "./run.ts";

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
