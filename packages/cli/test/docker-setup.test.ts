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

describe("the Docker deployment folder", () => {
  const fresh = () => join(mkdtempSync(join(tmpdir(), "artifacts-docker-")), "srv");

  test("keeps its secrets private and generates them from the system's random source", () => {
    const dir = fresh();
    const { setupToken } = writeDeployment(dir, "ghcr.io/mochahub/artifacts:0.2.0", 8080);
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(statSync(join(dir, ".env")).mode & 0o077).toBe(0);
    const env = Object.fromEntries(
      readFileSync(join(dir, ".env"), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    );
    expect(env.SETUP_TOKEN).toBe(setupToken);
    expect(setupToken).toMatch(/^[0-9a-f]{48}$/);
    for (const key of ["SESSION_SECRET", "OPS_SECRET", "S3_SECRET_ACCESS_KEY"]) {
      expect(env[key]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(env.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
  });

  test("an image name can't add a line to .env", () => {
    for (const image of ["x\nSETUP_TOKEN=evil", "x y", "$(touch /tmp/x)", "-v", ""]) {
      const dir = fresh();
      expect(() => writeDeployment(dir, image, 8080)).toThrow("isn't an image name");
      expect(existsSync(join(dir, ".env"))).toBe(false);
    }
  });

  test("never overwrites an existing deployment's secrets", () => {
    const dir = fresh();
    writeDeployment(dir, "artifacts:dev", 8080);
    expect(() => writeDeployment(dir, "artifacts:dev", 8080)).toThrow("already has a deployment");
  });
});
