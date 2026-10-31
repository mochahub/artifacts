import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeUrl, requireHttps } from "../src/config.ts";
import { cli, sandbox } from "./sandbox.ts";

const PERSON = { id: crypto.randomUUID(), name: "Z", email: "z@example.test", role: "owner" };

/** A device-flow server that approves the first poll, and writes down every path it is asked for. */
function approvingServer(hostname: string) {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname,
    fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/api/device/start") {
        return Response.json({
          deviceCode: "d",
          userCode: "ABCD-EFGH",
          verificationUrl: "https://art.example.com/device",
          interval: 0,
          expiresIn: 5,
        });
      }
      return Response.json({ status: "approved", token: "art_token", person: PERSON });
    },
  });
  return { server, paths };
}

/**
 * Plain http to a host that isn't this machine, if the CLI were to send it, goes to this proxy
 * (Bun's fetch honours http_proxy), so what it records is exactly what left the CLI.
 */
function recordingProxy() {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      seen.push(request.url);
      return Response.json({ status: "denied" });
    },
  });
  return {
    server,
    seen,
    env: { http_proxy: `http://127.0.0.1:${server.port}`, HTTP_PROXY: `http://127.0.0.1:${server.port}` },
  };
}

describe("the CLI signs in over HTTPS only, except on this machine", () => {
  const proxy = recordingProxy();
  const stops: (() => void)[] = [() => proxy.server.stop(true)];
  afterAll(() => {
    for (const stop of stops) stop();
  });

  const refused = (result: { code: number; stderr: string }) => {
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("only signs in over HTTPS");
    expect(result.stderr).toContain("README");
    expect(proxy.seen).toEqual([]);
  };

  test("login to a plain http address elsewhere is refused before a request is made", async () => {
    const box = sandbox();
    refused(await cli(["login", "http://192.0.2.10:8080"], { ...box.env, ...proxy.env }));
  });

  test("setup <url> to a plain http address elsewhere is refused before a request is made", async () => {
    const box = sandbox();
    refused(await cli(["setup", "http://192.0.2.10:8080", "--no-skill"], { ...box.env, ...proxy.env }));
  });

  test("--server with ARTIFACTS_TOKEN set is refused before the token is sent", async () => {
    const box = sandbox();
    const env = { ...box.env, ...proxy.env, ARTIFACTS_TOKEN: "art_secret" };
    refused(await cli(["whoami", "--server", "http://example.test"], env));
  });

  test("ARTIFACTS_URL with ARTIFACTS_TOKEN set is refused before the token is sent", async () => {
    const box = sandbox();
    const env = {
      ...box.env,
      ...proxy.env,
      ARTIFACTS_TOKEN: "art_secret",
      ARTIFACTS_URL: "http://example.test",
    };
    refused(await cli(["whoami"], env));
  });

  test("a plain http server stored by an older CLI is refused when it is used", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".config/artifacts"), { recursive: true });
    writeFileSync(
      join(box.home, ".config/artifacts/config.json"),
      JSON.stringify({ servers: [{ url: "http://192.0.2.10:8080", name: "old", default: true }] }),
    );
    const env = { ...box.env, ...proxy.env, ARTIFACTS_TOKEN: "art_secret" };
    refused(await cli(["whoami"], env));
  });

  test("upgrade refuses a plain http server before it changes anything", async () => {
    const box = sandbox();
    const env = {
      ...box.env,
      ...proxy.env,
      ARTIFACTS_URL: "http://example.test",
      ARTIFACTS_LATEST_URL: "http://127.0.0.1:1/latest",
    };
    refused(await cli(["upgrade", "--to", "9.9.9"], env));
  });

  test("login to localhost and 127.0.0.1 over http works", async () => {
    for (const host of ["localhost", "127.0.0.1"]) {
      const { server, paths } = approvingServer("127.0.0.1");
      stops.push(() => server.stop(true));
      const box = sandbox();
      const result = await cli(["login", `http://${host}:${server.port}`], box.env);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Signed in");
      expect(paths).toEqual(["/api/device/start", "/api/device/poll"]);
    }
  });

  test("login to an https address is not refused", async () => {
    // Nothing answers there (the proxy is a closed port), so the failure is the connection, not the rule.
    const box = sandbox();
    const result = await cli(["login", "https://art.example.test"], {
      ...box.env,
      https_proxy: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      ARTIFACTS_TIMEOUT_MS: "3000",
    });
    expect(result.stderr).toContain("Can't reach https://art.example.test");
    expect(result.stderr).not.toContain("only signs in over HTTPS");
  });

  test("which addresses pass", () => {
    for (const ok of [
      "https://art.example.com",
      "art.example.com",
      "https://192.0.2.10:8443",
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://[::1]:8080",
      "http://art.localhost:8080",
    ]) {
      expect(() => normalizeUrl(ok)).not.toThrow();
    }
    for (const bad of [
      "http://192.0.2.10:8080",
      "http://example.test",
      "http://localhost.example.com",
      "http://127.0.0.2:8080",
      "http://notlocalhost:8080",
    ]) {
      expect(() => normalizeUrl(bad)).toThrow("only signs in over HTTPS");
    }
    expect(() => requireHttps("http://example.test")).toThrow("HTTPS section");
  });
});
