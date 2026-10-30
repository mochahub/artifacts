import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDeployment } from "../src/docker/setup.ts";

describe("the Docker deployment files", () => {
  const root = mkdtempSync(join(tmpdir(), "artifacts-docker-setup-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const dir = join(root, "srv");
  const { url, setupToken } = writeDeployment(dir, "ghcr.io/example/artifacts:1.2.3", 9000);
  const env = Object.fromEntries(
    readFileSync(join(dir, ".env"), "utf8")
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

  test("keeps every secret in a private .env and writes no other file that holds one", () => {
    expect(statSync(join(dir, ".env")).mode & 0o077).toBe(0);
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(existsSync(join(dir, "s3.json"))).toBe(false);
    expect(env.S3_ACCESS_KEY_ID).toHaveLength(32);
    expect(env.S3_SECRET_ACCESS_KEY).toHaveLength(64);
    expect(env.SETUP_TOKEN).toBe(setupToken);
    expect(url).toBe("http://localhost:9000");
  });

  test("gives the compose file every variable it reads, and publishes only on loopback", () => {
    const compose = readFileSync(join(dir, "docker-compose.yml"), "utf8");
    const used = new Set([...compose.matchAll(/\$\{([A-Z0-9_]+)/g)].map((match) => match[1] as string));
    const optional = new Set(["MORE_URLS"]);
    for (const name of used) if (!optional.has(name)) expect(env).toHaveProperty(name);
    expect(env.BIND_ADDRESS).toBe("127.0.0.1");
    expect([env.VIEWER_PORT, env.LIVE_PORT, env.S3_PORT]).toEqual(["9000", "9001", "9253"]);
    // SeaweedFS takes the key pair from the environment, so no file is mounted for it.
    expect(compose).toContain("AWS_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:?");
    expect(compose).not.toContain("s3.json");
  });

  test("refuses to overwrite an existing deployment", () => {
    expect(() => writeDeployment(dir, "x", 9000)).toThrow("already has a deployment");
  });
});
