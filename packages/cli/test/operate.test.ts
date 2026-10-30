import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER, startTestServer, type TestServer } from "../../../apps/server/test/helpers.ts";
import { fakeRailway } from "./fake-railway.ts";
import { cli, sandbox } from "./sandbox.ts";

describe("setup and operations on Railway, against a fake railway binary", () => {
  let t: TestServer;
  let url: string;
  const box = sandbox();

  // The fake domain must be reachable over https by health checks, so the viewer URL here is http.
  beforeAll(async () => {
    const port = 51600 + Math.floor(Math.random() * 2000);
    url = `http://127.0.0.1:${port}`;
    t = await startTestServer({
      PUBLIC_URL: url,
      MORE_URLS: "",
      PORT: String(port),
      CONTENT_URL: "https://content.up.railway.app",
    });
  });
  afterAll(() => t.stop());

  const env = (extra: Record<string, string> = {}) => {
    const fake = fakeRailway(box.home, { viewerUrl: url });
    return {
      env: {
        ...box.env,
        PATH: `${fake.bin}:${box.env.PATH}`,
        ARTIFACTS_RAILWAY_TEMPLATE: "abc123",
        ARTIFACTS_RAILWAY_POLL_MS: "20",
        ARTIFACTS_PASSWORD: OWNER.password,
        ...extra,
      },
      log: fake.log,
    };
  };

  test("without a template, it says so plainly", async () => {
    const { env: e } = env({ ARTIFACTS_RAILWAY_TEMPLATE: "" });
    const child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts"), "setup", "--no-skill"], {
      env: e,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write("railway\n");
    child.stdin.end();
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("isn't published yet");
  });

  test("the whole path: project, template, domains, CONTENT_URL, claim", async () => {
    const { env: e, log } = env();
    const { setupRailway } = await import("../src/railway/setup.ts");
    expect(setupRailway).toBeFunction();
    // Health checks go to https://<domain>, which this fake can't serve, so this stops after the variables.
    const child = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "../src/index.ts"),
        "setup",
        "--no-skill",
        "--org",
        "Mochahub",
        "--name",
        "Z",
        "--email",
        OWNER.email,
      ],
      { env: { ...e, ARTIFACTS_RAILWAY_HTTP: "1" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    child.stdin.write("railway\n");
    child.stdin.end();
    const code = await child.exited;
    const calls = readFileSync(log, "utf8").split("\n");
    expect(await new Response(child.stderr).text()).not.toContain("failed");
    expect(code).toBe(0);
    const expected = [
      "init --name artifacts --workspace w1 --json",
      "deploy --template abc123",
      "service status --service artifacts --json",
      "domain list --service artifacts --json",
      "variable set CONTENT_URL=https://content.up.railway.app --service artifacts",
      "variable list --service artifacts --json",
    ];
    let at = -1;
    for (const line of expected) {
      const next = calls.findIndex((call, i) => i > at && call === line);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    const config = JSON.parse(readFileSync(join(box.home, ".config/artifacts/config.json"), "utf8"));
    expect(config.servers[0]).toMatchObject({
      name: "artifacts",
      railway: { projectId: "proj-1", service: "artifacts" },
    });
    expect(await (await t.api("/api/meta")).json()).toMatchObject({ orgName: "Mochahub" });
  });

  test("domain add: DNS records, MORE_URLS, and PUBLIC_URL only if asked", async () => {
    const { env: e, log } = env();
    const result = await cli(["domain", "add", "art.example.com", "--json"], e);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ domain: "art.example.com", primary: false });
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("domain art.example.com --service artifacts --port 8080");
    expect(calls).toContain("variable set MORE_URLS=https://art.example.com --service artifacts");
    expect(calls).not.toContain("PUBLIC_URL");
    expect((await cli(["domain", "nonsense"], e)).code).toBe(2);
  });

  test("upgrade --server moves the service to the release's image", async () => {
    const { env: e, log } = env();
    const result = await cli(["upgrade", "--server", "--to", "0.1.0", "--json"], {
      ...e,
      ARTIFACTS_RAILWAY_POLL_MS: "20",
    });
    expect(result.stderr).not.toContain("failed");
    expect(result.code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain(
      "service source connect --image ghcr.io/mochahub/artifacts:0.1.0 --service artifacts",
    );
  });
});

describe("install.sh", () => {
  test("downloads, checks the sum and installs; a bad sum stops it", async () => {
    const box = sandbox();
    const site = join(box.home, "site");
    mkdirSync(join(site, "v9.9.9"), { recursive: true });
    const os = process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const name = `artifacts-${os}-${arch}`;
    const body = "#!/bin/sh\necho installed\n";
    writeFileSync(join(site, "v9.9.9", name), body);
    const sum = createHash("sha256").update(body).digest("hex");
    writeFileSync(join(site, "v9.9.9/SHA256SUMS"), `${sum}  ${name}\n`);
    const server = Bun.serve({
      port: 0,
      fetch: (request) => new Response(Bun.file(join(site, new URL(request.url).pathname))),
    });
    const script = join(import.meta.dir, "../../../scripts/install.sh");
    const run = () =>
      Bun.spawn(["sh", script], {
        env: {
          ...box.env,
          ARTIFACTS_RELEASES_URL: `http://127.0.0.1:${server.port}`,
          ARTIFACTS_VERSION: "9.9.9",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    expect(await run().exited).toBe(0);
    const installed = Bun.spawnSync([join(box.home, ".artifacts/bin/artifacts")]);
    expect(installed.stdout.toString()).toBe("installed\n");

    writeFileSync(join(site, "v9.9.9/SHA256SUMS"), `${"0".repeat(64)}  ${name}\n`);
    const bad = run();
    expect(await bad.exited).toBe(1);
    expect(await new Response(bad.stderr).text()).toContain("checksum");
    server.stop(true);
  });
});
