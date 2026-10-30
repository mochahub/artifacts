import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { parseEnv } from "../src/env.ts";

// docker-compose.test.yml; `bun run test` starts it.
const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://artifacts:artifacts@127.0.0.1:55432/artifacts_test";
const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? "http://127.0.0.1:18333";

/** A new empty database, so each test file starts from nothing. */
export async function createDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `t_${randomBytes(8).toString("hex")}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}

export function testEnv(databaseUrl: string, overrides: Record<string, string> = {}) {
  return parseEnv({
    DATABASE_URL: databaseUrl,
    S3_ENDPOINT,
    S3_REGION: "auto",
    S3_BUCKET: "artifacts-test",
    S3_ACCESS_KEY_ID: "devaccesskey",
    S3_SECRET_ACCESS_KEY: "devsecretkey",
    PUBLIC_URL: "http://viewer.test",
    MORE_URLS: "https://art.example.org",
    CONTENT_URL: "http://content.test",
    SETUP_TOKEN: "s".repeat(48),
    SESSION_SECRET: "x".repeat(64),
    OPS_SECRET: "o".repeat(64),
    PORT: "0",
    CONTENT_PORT: "0",
    INTERNAL_PORT: "0",
    ...overrides,
  }).env;
}

/** A stand-in for apps/viewer/dist. */
export function viewerFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-viewer-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>viewer</title>");
  writeFileSync(join(dir, "icon.svg"), "<svg/>");
  writeFileSync(join(dir, "assets/index-abc.js"), "console.log(1)");
  return dir;
}

export const silent = { debug() {}, info() {}, warn() {}, error() {} };
