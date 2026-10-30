import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "../src/client.ts";
import { normalizeUrl } from "../src/config.ts";

describe("the API client", () => {
  const seen: { host: string; authorization: string | null }[] = [];
  const elsewhere = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      seen.push({ host: "elsewhere", authorization: request.headers.get("authorization") });
      return Response.json({ ok: true });
    },
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/redirect") {
        return new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${elsewhere.port}/` } });
      }
      if (path === "/html") return new Response("<html><body>Bad gateway, see /secret/path</body></html>", { status: 502 });
      if (path === "/stall") return new Promise<Response>(() => {});
      return Response.json({ ok: true });
    },
  });
  afterAll(() => {
    server.stop(true);
    elsewhere.stop(true);
  });
  const client = new Client(`http://127.0.0.1:${server.port}`, "art_secret");

  test("a redirect isn't followed, so the token stays here", async () => {
    await expect(client.get("/redirect")).rejects.toThrow("The server answered 302.");
    expect(seen).toEqual([]);
  });

  test("an error page is not echoed", async () => {
    await expect(client.get("/html")).rejects.toThrow("The server answered 502.");
  });

  test("a server that never answers is given up on", async () => {
    process.env.ARTIFACTS_TIMEOUT_MS = "300";
    try {
      const started = Date.now();
      await expect(client.get("/stall")).rejects.toThrow("Can't reach");
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      delete process.env.ARTIFACTS_TIMEOUT_MS;
    }
  });
});

describe("server addresses", () => {
  test("only web addresses are servers", () => {
    expect(normalizeUrl("art.example.com/path")).toBe("https://art.example.com");
    expect(normalizeUrl("http://localhost:8080/")).toBe("http://localhost:8080");
    expect(() => normalizeUrl("file:///etc/passwd")).toThrow("web address");
    expect(() => normalizeUrl("ftp://example.com")).toThrow("web address");
  });
});
