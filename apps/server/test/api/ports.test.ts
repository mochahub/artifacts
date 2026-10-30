import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ApiErrorBody, DEFAULT_ORG_SETTINGS, Health, Meta } from "@artifacts/schema";
import { org } from "../../src/db/schema.ts";
import { createLogger } from "../../src/log.ts";
import { startServer } from "../../src/server.ts";
import { VERSION } from "../../src/version.ts";
import { createDatabase, silent, testEnv, viewerFixture } from "../helpers.ts";

describe("the three ports", () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let server: Awaited<ReturnType<typeof startServer>>;
  const lines: string[] = [];

  const request = (port: number, path: string, host: string, init: RequestInit = {}) =>
    // Bun's fetch lets a test set Host, which is what routing looks at.
    fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { ...init.headers, Host: host } });
  const viewer = (path: string, host = "viewer.test", init?: RequestInit) =>
    request(server.ports.viewer, path, host, init);
  const content = (path: string, host = "content.test", init?: RequestInit) =>
    request(server.ports.content, path, host, init);
  const internal = (path: string, init?: RequestInit) => request(server.ports.internal, path, "x", init);

  beforeAll(async () => {
    database = await createDatabase();
    server = await startServer(testEnv(database.url), {
      log: createLogger("info", (line) => lines.push(line)),
      viewerDir: viewerFixture(),
    });
  });
  afterAll(async () => {
    await server.stop();
    await database.drop();
  });

  describe("viewer port", () => {
    test("health reports setup mode on an empty database", async () => {
      const response = await viewer("/api/health");
      expect(response.status).toBe(200);
      expect(Health.parse(await response.json())).toEqual({ ok: true, version: VERSION, setupMode: true });
    });

    test("meta has the shape in 03", async () => {
      const body = Meta.parse(await (await viewer("/api/meta")).json());
      expect(body).toMatchObject({
        version: VERSION,
        orgName: null,
        homeDomain: null,
        publicUrl: "http://viewer.test",
        contentUrl: "http://content.test",
        viewerOrigins: ["http://viewer.test", "https://art.example.org"],
      });
    });

    test("an unknown Host gets 421 in the error format", async () => {
      const response = await viewer("/api/meta", "evil.test");
      expect(response.status).toBe(421);
      const body = ApiErrorBody.parse(await response.json());
      expect(body.error).toMatchObject({ code: "misdirected", details: {} });
    });

    test("health answers any Host, for Railway's and Docker's checks", async () => {
      expect((await viewer("/api/health", "healthcheck.railway.app")).status).toBe(200);
      expect((await viewer("/api/health", "127.0.0.1:8080")).status).toBe(200);
    });

    test("MORE_URLS hosts are viewer hosts", async () => {
      expect((await viewer("/api/meta", "art.example.org")).status).toBe(200);
    });

    test("every response carries the version, a request id and the headers in 04", async () => {
      for (const response of [await viewer("/api/meta"), await viewer("/"), await viewer("/api/nope")]) {
        expect(response.headers.get("artifacts-version")).toBe(VERSION);
        expect(response.headers.get("x-request-id")).toBeTruthy();
        expect(response.headers.get("x-frame-options")).toBe("DENY");
        expect(response.headers.get("referrer-policy")).toBe("same-origin");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
        const csp = response.headers.get("content-security-policy");
        expect(csp).toContain("frame-src http://content.test");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("img-src 'self' data: blob: http://127.0.0.1:18333");
      }
    });

    test("in setup mode an unknown API path is a JSON 503, not the viewer (04)", async () => {
      const response = await viewer("/api/nope");
      expect(response.status).toBe(503);
      expect(ApiErrorBody.parse(await response.json()).error.code).toBe("setup_mode");
    });

    test("serves the viewer, with index.html for client-side routes", async () => {
      for (const path of ["/", "/camerabuddy/roadmap", "/settings/people"]) {
        const response = await viewer(path);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("cache-control")).toBe("no-cache");
      }
    });

    test("hashed assets are immutable; a missing one is a 404", async () => {
      const asset = await viewer("/assets/index-abc.js");
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toContain("immutable");
      expect((await viewer("/assets/index-gone.js")).status).toBe(404);
    });

    test("static paths can't climb out of the viewer folder", async () => {
      for (const path of ["/..%2f..%2f..%2fetc%2fhosts", "/%2e%2e/%2e%2e/etc/hosts"]) {
        const text = await (await viewer(path)).text();
        expect(text).toContain("<title>viewer</title>");
      }
    });
  });

  describe("content port", () => {
    test("everything outside /t/ is 404, whatever the Host", async () => {
      for (const path of ["/", "/api/health", "/anything"]) {
        expect((await content(path)).status).toBe(404);
        expect((await content(path, "localhost:8081")).status).toBe(404);
      }
    });

    test("/t/ fails closed: no Sec-Fetch-Dest is refused, and so is a forged token", async () => {
      expect((await content("/t/abc/v1/index.html")).status).toBe(403);
      const forged = await content("/t/abc/v1/index.html", "content.test", {
        headers: { "Sec-Fetch-Dest": "iframe" },
      });
      expect(forged.status).toBe(403);
    });

    test("/t/ on another Host is 421", async () => {
      expect((await content("/t/abc/v1/index.html", "viewer.test")).status).toBe(421);
    });

    test("responses carry the version header", async () => {
      expect((await content("/")).headers.get("artifacts-version")).toBe(VERSION);
    });
  });

  describe("internal port", () => {
    const auth = { headers: { Authorization: `Bearer ${"o".repeat(64)}` }, method: "POST" };

    test("needs OPS_SECRET", async () => {
      expect((await internal("/internal/jobs/gc", { method: "POST" })).status).toBe(401);
      const wrong = { method: "POST", headers: { Authorization: "Bearer nope" } };
      expect((await internal("/internal/jobs/gc", wrong)).status).toBe(401);
    });

    test("with it, an unknown job is 404", async () => {
      expect((await internal("/internal/jobs/gc", auth)).status).toBe(404);
      expect((await internal("/internal/jobs/constructor", auth)).status).toBe(404);
    });

    test("doesn't serve the API", async () => {
      expect((await internal("/api/health")).status).toBe(404);
    });
  });

  describe("logs", () => {
    test("are JSON lines with the fields in 09", async () => {
      await viewer("/api/health");
      const line = JSON.parse(lines.findLast((l) => l.includes('"request"')) as string);
      expect(line).toMatchObject({ level: "info", msg: "request", route: "/api/health", status: 200 });
      expect(line.requestId).toBeTruthy();
      expect(typeof line.ms).toBe("number");
    });

    test("never contain a path's token", async () => {
      await content("/t/SECRET-TOKEN/v1/index.html");
      await viewer("/s/SECRET-TOKEN");
      expect(lines.join("\n")).not.toContain("SECRET-TOKEN");
    });
  });

  test("once an org exists: setup mode ends, and the home domain is a viewer host", async () => {
    await server.db.insert(org).values({
      id: Bun.randomUUIDv7(),
      name: "Mochahub",
      homeDomain: "home.example.org",
      settings: DEFAULT_ORG_SETTINGS,
      pseudonymKey: new Uint8Array(32),
    });
    expect(Health.parse(await (await viewer("/api/health")).json()).setupMode).toBe(false);

    const response = await viewer("/api/meta", "home.example.org");
    expect(response.status).toBe(200);
    expect(Meta.parse(await response.json())).toMatchObject({
      orgName: "Mochahub",
      homeDomain: "home.example.org",
      viewerOrigins: ["http://viewer.test", "https://art.example.org", "https://home.example.org"],
    });
  });
});

describe("boot", () => {
  test("refuses a content host that is the home domain", async () => {
    const database = await createDatabase();
    const first = await startServer(testEnv(database.url), { log: silent, viewerDir: null });
    await first.db.insert(org).values({
      id: Bun.randomUUIDv7(),
      name: "Mochahub",
      homeDomain: "home.example.org",
      settings: DEFAULT_ORG_SETTINGS,
      pseudonymKey: new Uint8Array(32),
    });
    await first.stop();

    const env = testEnv(database.url, { CONTENT_URL: "https://home.example.org" });
    await expect(startServer(env, { log: silent, viewerDir: null })).rejects.toThrow(/home domain/);
    await Bun.sleep(100);
    await database.drop();
  });

  test("without a built viewer, pages are a 404 and the API still works", async () => {
    const database = await createDatabase();
    const server = await startServer(testEnv(database.url), { log: silent, viewerDir: null });
    const get = (path: string) =>
      fetch(`http://127.0.0.1:${server.ports.viewer}${path}`, { headers: { Host: "viewer.test" } });
    expect((await get("/")).status).toBe(404);
    expect((await get("/api/health")).status).toBe(200);
    await server.stop();
    await database.drop();
  });
});
