import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { parseEnv } from "../src/env.ts";
import { startServer } from "../src/server.ts";

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

/** A clock tests can move, for expiry, sessions and purge. */
export function testClock(start = new Date()) {
  let now = start.getTime();
  return {
    now: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

const hitsFile = process.env.ARTIFACTS_ROUTE_HITS;

/** A real server on a fresh database, with helpers for calling it as a browser or a CLI. */
export async function startTestServer(overrides: Record<string, string> = {}) {
  const database = await createDatabase();
  const clock = testClock();
  const server = await startServer(testEnv(database.url, overrides), {
    log: silent,
    clock,
    viewerDir: viewerFixture(),
    onRoute: hitsFile ? (method, path) => appendFileSync(hitsFile, `${method} ${path}\n`) : undefined,
  });
  const base = `http://127.0.0.1:${server.ports.viewer}`;

  const api = (
    path: string,
    init: RequestInit & { json?: unknown; cookie?: string; bearer?: string } = {},
  ) => {
    const { json, cookie, bearer, ...rest } = init;
    const host = overrides.PUBLIC_URL ? new URL(overrides.PUBLIC_URL).host : "viewer.test";
    const headers: Record<string, string> = { Host: host, ...(rest.headers as Record<string, string>) };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) {
      headers.Cookie = cookie;
      if (rest.method && rest.method !== "GET")
        headers.Origin ??= overrides.PUBLIC_URL ?? "http://viewer.test";
    }
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    return fetch(`${base}${path}`, {
      ...rest,
      headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  };

  return {
    server,
    clock,
    api,
    async stop() {
      await server.stop();
      await database.drop();
    },
  };
}

export type TestServer = Awaited<ReturnType<typeof startTestServer>>;

export const OWNER = { name: "Zahin", email: "zahin@example.com", password: "correct horse battery" };

/** Claims the server, and returns the owner's token. */
export async function claim(t: TestServer) {
  const response = await t.api("/api/setup", {
    method: "POST",
    json: { setupToken: "s".repeat(48), orgName: "Mochahub", clientName: "Test", ...OWNER },
  });
  if (response.status !== 200) throw new Error(`setup failed: ${await response.text()}`);
  return (await response.json()) as { person: { id: string }; token: string };
}

/** Signs in with a password and returns the cookie to send. */
export async function signIn(t: TestServer, email: string, password: string) {
  const response = await t.api("/api/auth/password", { method: "POST", json: { email, password } });
  if (response.status !== 200) throw new Error(`sign-in failed: ${await response.text()}`);
  return (response.headers.getSetCookie()[0] ?? "").split(";")[0] as string;
}
