import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InviteCreated,
  OrgTokenCreated,
  Person,
  RecoverResponse,
  SetupResponse,
  type TokenScope,
} from "@artifacts/schema";
import postgres from "postgres";
import sharp from "sharp";
import type { GoogleProvider } from "../src/auth/google.ts";
import { findOrg } from "../src/db/index.ts";
import { parseEnv } from "../src/env.ts";
import { startServer } from "../src/server.ts";
import type { softAuthenticator } from "./authenticator.ts";

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

export const SETUP_TOKEN = "s".repeat(48);
export const OPS_SECRET = "o".repeat(64);
/** A password long enough for every check, for people who join. */
export const PASSWORD = "a perfectly long password";
/** The viewer's origin in every test server that doesn't set PUBLIC_URL. */
export const ORIGIN = "http://viewer.test";

export function testEnv(databaseUrl: string, overrides: Record<string, string> = {}) {
  return parseEnv({
    DATABASE_URL: databaseUrl,
    S3_ENDPOINT,
    S3_REGION: "auto",
    // Each server has its own database, so the GC job deletes what's only in another server's. One
    // bucket per worker keeps it away from files running now. `bun run test` sets this.
    S3_BUCKET: process.env.ARTIFACTS_TEST_PARALLEL ? `artifacts-test-${process.pid}` : "artifacts-test",
    S3_ACCESS_KEY_ID: "devaccesskey",
    S3_SECRET_ACCESS_KEY: "devsecretkey",
    PUBLIC_URL: "http://viewer.test",
    MORE_URLS: "https://art.example.org",
    CONTENT_URL: "http://content.test",
    SETUP_TOKEN,
    GITHUB_RELEASES_REPO: "none",
    SESSION_SECRET: "x".repeat(64),
    OPS_SECRET,
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
  writeFileSync(join(dir, "index.html"), "<!doctype html><head><title>viewer</title></head>");
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

let nextPort = 20_000 + Math.floor(Math.random() * 10_000);

/**
 * For a server that has to know its address before it starts. Below the ports Linux (from 32768) and
 * macOS (from 49152) give outgoing connections: a closed one holds its port for a minute in TIME_WAIT,
 * and Bun then can't listen there. These tests make thousands.
 */
export function testPort() {
  for (;;) {
    const port = nextPort++;
    if (nextPort > 32_000) nextPort = 20_000;
    try {
      Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } }).stop(true);
      return port;
    } catch {}
  }
}

const hitsFile = process.env.ARTIFACTS_ROUTE_HITS;
let listed = false;

/**
 * For scripts/route-coverage.ts: the server's own route list, once per process, and the route each
 * request's log line names.
 */
const recording = (routes: { method: string; path: string }[]) => {
  if (!hitsFile) return silent;
  if (!listed) {
    listed = true;
    appendFileSync(hitsFile, routes.map((route) => `route ${route.method} ${route.path}\n`).join(""));
  }
  return {
    ...silent,
    info(message: string, fields: Record<string, unknown> = {}) {
      if (message === "request") appendFileSync(hitsFile, `${fields.method} ${fields.route}\n`);
    },
  };
};

/** A real server on a fresh database, with helpers for calling it as a browser or a CLI. */
export async function startTestServer(
  overrides: Record<string, string> = {},
  options: {
    pushAllow?: (endpoint: string) => boolean;
    clientMetadata?: (url: URL) => Promise<unknown>;
    heartbeatMs?: number;
    google?: GoogleProvider;
  } = {},
) {
  const database = await createDatabase();
  const clock = testClock();
  const log = { ...silent };
  const server = await startServer(testEnv(database.url, overrides), {
    log,
    clock,
    viewerDir: viewerFixture(),
    jobs: false,
    pushAllow: options.pushAllow,
    clientMetadata: options.clientMetadata,
    google: options.google,
    heartbeatMs: options.heartbeatMs,
  });
  Object.assign(log, recording(server.routes));
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

/** A response body, cast for tests that only read a field or two. Parse with the schema to check a shape. */
export const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;

/** An error response's code. */
export const code = async (response: Response) =>
  (await json<{ error: { code: string } }>(response)).error.code;

/** A cookie a response sets (the first, or the one named), ready to send back. */
export function cookieOf(response: Response, name?: string) {
  const all = response.headers.getSetCookie();
  const found = name ? all.find((cookie) => cookie.startsWith(`${name}=`)) : all[0];
  return (found ?? "").split(";")[0] as string;
}

type Auth = { cookie?: string; bearer?: string };

/**
 * Claims the server, and returns the owner and their CLI token. The API never shows an org's id, so it's
 * read here, once, for the few tests that write rows no route can.
 */
export async function claim(t: TestServer) {
  const response = await t.api("/api/setup", {
    method: "POST",
    json: { setupToken: SETUP_TOKEN, orgName: "Mochahub", clientName: "Test", ...OWNER },
  });
  if (response.status !== 200) throw new Error(`setup failed: ${await response.text()}`);
  const body = SetupResponse.parse(await response.json());
  const org = await findOrg(t.server.db);
  if (!org) throw new Error("no org after setup");
  return { ...body, orgId: org.id };
}

/** Signs in with a password and returns the cookie to send. */
export async function signIn(t: TestServer, email: string, password: string) {
  const response = await t.api("/api/auth/password", { method: "POST", json: { email, password } });
  if (response.status !== 200) throw new Error(`sign-in failed: ${await response.text()}`);
  return cookieOf(response);
}

/** An org token, made the way an admin makes one. `cookie` must be a recent sign-in. */
export async function orgToken(
  t: TestServer,
  cookie: string,
  body: { name?: string; scopes?: TokenScope[]; projectIds?: string[]; expiresAt?: string } = {},
) {
  const response = await t.api("/api/tokens", {
    method: "POST",
    cookie,
    json: { name: "ci", scopes: ["read"], ...body },
  });
  if (response.status !== 200) throw new Error(`token failed: ${await response.text()}`);
  return OrgTokenCreated.parse(await response.json());
}

/** The secret in a /join/ link. */
export const inviteSecret = (url: string) => url.split("/join/")[1] as string;

/** Invites someone to the org and returns the join link. */
export async function invite(t: TestServer, auth: Auth, email: string, role = "member") {
  const response = await t.api("/api/invites", { method: "POST", json: { email, role }, ...auth });
  if (response.status !== 200) throw new Error(`invite failed: ${await response.text()}`);
  return InviteCreated.parse(await response.json()).url;
}

/** Accepts an invite link with a password; returns the new person and their session cookie. */
export async function acceptInvite(t: TestServer, url: string, name = "Joiner", password = PASSWORD) {
  const response = await t.api(`/api/invites/${inviteSecret(url)}/accept`, {
    method: "POST",
    json: { name, password },
  });
  if (response.status !== 200) throw new Error(`accept failed: ${await response.text()}`);
  const cookie = cookieOf(response);
  return { person: Person.parse(((await response.json()) as { person: unknown }).person), cookie };
}

/** Joins through a share link (its URL or secret) as a named guest, and returns the guest's cookie. */
export async function joinAsGuest(t: TestServer, link: string, name = "Guest") {
  const secret = link.includes("/s/") ? (link.split("/s/")[1] as string) : link;
  const response = await t.api(`/api/s/${secret}/guest`, { method: "POST", json: { name } });
  if (response.status !== 200) throw new Error(`guest join failed: ${await response.text()}`);
  return cookieOf(response);
}

/**
 * Mints a content token for a version, and returns a fetch for paths under it on the content port, sent
 * the way the viewer's iframe would.
 */
export async function contentFor(t: TestServer, artifactId: string, auth: Auth, version = 1) {
  const response = await t.api(`/api/artifacts/${artifactId}/content-token`, {
    method: "POST",
    json: { version },
    ...auth,
  });
  if (response.status !== 200) throw new Error(`content token failed: ${await response.text()}`);
  const { base } = (await response.json()) as { base: string };
  const fetchContent = (path: string, init: RequestInit = {}, host = "content.test") =>
    fetch(`http://127.0.0.1:${t.server.ports.content}${new URL(base).pathname}${path}`, {
      ...init,
      headers: { Host: host, "Sec-Fetch-Dest": "iframe", ...(init.headers as Record<string, string>) },
    });
  return { base, fetch: fetchContent };
}

let rpcId = 1;
/** A JSON-RPC call to /api/mcp. */
export function mcp(
  t: TestServer,
  bearer: string | undefined,
  method: string,
  params: object = {},
  headers: Record<string, string> = {},
) {
  return t.api("/api/mcp", {
    method: "POST",
    bearer,
    headers,
    json: { jsonrpc: "2.0", id: rpcId++, method, params },
  });
}

/** The setup token's recovery path: returns the secret in a reset link for an owner. */
export async function recover(t: TestServer, email = OWNER.email) {
  const response = await t.api("/api/recover", { method: "POST", json: { setupToken: SETUP_TOKEN, email } });
  if (response.status !== 200) throw new Error(`recover failed: ${await response.text()}`);
  return RecoverResponse.parse(await response.json()).resetUrl.split("/reset/")[1] as string;
}

type Authenticator = ReturnType<typeof softAuthenticator>;
type Challenge = { challengeId: string; challenge: string };

/** Registers a software passkey for whoever `cookie` signs in, and returns the verify response. */
export async function addPasskey(t: TestServer, cookie: string, key: Authenticator, name?: string) {
  const options = (await (
    await t.api("/api/me/passkeys/options", { method: "POST", cookie, json: {} })
  ).json()) as Challenge & { rp: { id: string } };
  return t.api("/api/me/passkeys/verify", {
    method: "POST",
    cookie,
    json: { challengeId: options.challengeId, response: key.register(options, ORIGIN), name },
  });
}

/** Signs in with a software passkey, and returns the verify response. */
export async function passkeySignIn(t: TestServer, key: Authenticator) {
  const options = (await (
    await t.api("/api/auth/passkey/options", { method: "POST", json: {} })
  ).json()) as Challenge & { rpId: string };
  return t.api("/api/auth/passkey/verify", {
    method: "POST",
    json: { challengeId: options.challengeId, response: key.assert(options, ORIGIN) },
  });
}

/** Reads a server-sent event stream until `count` events have come, or `ms` pass, then closes it. */
export async function readEvents(response: Response, count: number, ms = 3000) {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const deadline = Date.now() + ms;
  let text = "";
  while ((text.match(/^event:/gm) ?? []).length < count) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const { value, done } = await Promise.race([
      reader.read(),
      Bun.sleep(left).then(() => ({ value: undefined, done: true })),
    ]);
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  await reader.cancel();
  return text;
}

/** An image of one colour, for renders and crops. */
export function solidImage(
  width: number,
  height: number,
  background: string,
  format: "webp" | "png" = "webp",
) {
  const image = sharp({ create: { width, height, channels: 4, background } });
  return (format === "png" ? image.png() : image.webp()).toBuffer();
}
