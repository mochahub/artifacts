import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  OWNER,
  signIn,
  startTestServer,
  type TestServer,
  testPort,
} from "../../../apps/server/test/helpers.ts";
import { cli, sandbox, start } from "./sandbox.ts";

const SETUP_TOKEN = "s".repeat(48);

describe("the account commands against a real server", () => {
  let t: TestServer;
  let url: string;
  const box = sandbox();

  beforeAll(async () => {
    const port = testPort();
    url = `http://127.0.0.1:${port}`;
    t = await startTestServer({ PUBLIC_URL: url, MORE_URLS: "", PORT: String(port) });
  });
  afterAll(() => t.stop());

  test("usage errors exit 2", async () => {
    expect((await cli(["nonsense"], box.env)).code).toBe(2);
    expect((await cli(["--bad-flag"], box.env)).code).toBe(2);
  });

  test("whoami before anything exists is a plain error", async () => {
    const result = await cli(["whoami"], box.env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("artifacts setup");
  });

  test("setup <url> claims a server in setup mode", async () => {
    const child = start(
      ["setup", url, "--org", "Mochahub", "--name", OWNER.name, "--email", OWNER.email, "--no-skill"],
      {
        ...box.env,
        ARTIFACTS_SETUP_TOKEN: SETUP_TOKEN,
        ARTIFACTS_PASSWORD: OWNER.password,
      },
    );
    child.stdin.end();
    expect(await child.exited).toBe(0);
    const stored = join(box.home, ".config/artifacts/credentials.json");
    expect(statSync(stored).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(stored, "utf8")))).toEqual([url]);
  });

  test("whoami --json puts only JSON on stdout", async () => {
    const result = await cli(["whoami", "--json"], box.env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      person: { email: OWNER.email, role: "owner" },
      org: { name: "Mochahub" },
      server: url,
    });
  });

  test("doctor passes when everything is right", async () => {
    const missing = JSON.parse((await cli(["doctor", "--json"], box.env)).stdout);
    expect(missing.ok).toBe(false);
    expect(missing.checks.find((check: { name: string }) => check.name === "skill").detail).toContain(
      "skill install",
    );
    await cli(["skill", "install"], box.env);
    const result = await cli(["doctor", "--json"], box.env);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  });

  test("logout revokes the token; whoami then fails", async () => {
    const token = JSON.parse(readFileSync(join(box.home, ".config/artifacts/credentials.json"), "utf8"))[url];
    expect((await cli(["logout"], box.env)).code).toBe(0);
    expect((await t.api("/api/me", { bearer: token })).status).toBe(401);
    expect((await cli(["whoami"], box.env)).code).toBe(1);
  });

  test("login: the device flow, through a browser session", async () => {
    const child = start(["login", url], box.env);
    child.stdin.end();
    const reader = child.stdout.getReader();
    let text = "";
    while (!/[A-Z]{4}-[A-Z]{4}/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    const code = text.match(/[A-Z]{4}-[A-Z]{4}/)?.[0];
    const cookie = await signIn(t, OWNER.email, OWNER.password);
    expect(
      (await t.api(`/api/device/${code}`, { cookie, headers: { Host: new URL(url).host } })).status,
    ).toBe(200);
    const approve = await t.api(`/api/device/${code}/approve`, {
      method: "POST",
      cookie,
      headers: { Host: new URL(url).host, Origin: url },
    });
    expect(approve.status).toBe(200);
    expect(await child.exited).toBe(0);
    expect((await cli(["whoami"], box.env)).code).toBe(0);
  }, 20_000);

  test("recover prints a reset link", async () => {
    const result = await cli(["recover", url, "--email", OWNER.email, "--json"], {
      ...box.env,
      ARTIFACTS_SETUP_TOKEN: SETUP_TOKEN,
    });
    expect(JSON.parse(result.stdout).resetUrl).toContain("/reset/");
  });

  test("ARTIFACTS_URL and ARTIFACTS_TOKEN override everything (CI)", async () => {
    const empty = sandbox();
    const failed = await cli(["whoami", "--json"], {
      ...empty.env,
      ARTIFACTS_URL: url,
      ARTIFACTS_TOKEN: "art_wrong",
    });
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stderr).error.code).toBe("unauthenticated");
  });
});
