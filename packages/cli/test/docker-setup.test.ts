import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDeployment } from "../src/docker/setup.ts";

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
