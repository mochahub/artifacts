import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { org } from "../../../apps/server/src/db/schema.ts";
import { OWNER, startTestServer, type TestServer, testPort } from "../../../apps/server/test/helpers.ts";
import { checksumFor } from "../src/commands/operate.ts";
import { VERSION } from "../src/version.ts";
import { fakeRailway } from "./fake-railway.ts";
import { cli, sandbox } from "./sandbox.ts";

describe("setup and operations on Railway, against a fake railway binary", () => {
  let t: TestServer;
  let url: string;
  const box = sandbox();

  // The fake domain must be reachable over https by health checks, so the viewer URL here is http.
  beforeAll(async () => {
    const port = testPort();
    url = `http://127.0.0.1:${port}`;
    t = await startTestServer({
      PUBLIC_URL: url,
      MORE_URLS: "",
      PORT: String(port),
      CONTENT_URL: "https://content.up.railway.app",
    });
  });
  afterAll(() => t.stop());

  const env = (extra: Record<string, string> = {}, deployFails = false, status = "SUCCESS") => {
    const fake = fakeRailway(box.home, { viewerUrl: url, deployFails, status });
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

  test("a deploy that fails takes its empty project with it", async () => {
    const { env: e, log } = env({}, true);
    const child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts"), "setup", "--no-skill"], {
      env: e,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write("railway\n");
    child.stdin.end();
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("railway deploy failed");
    expect(readFileSync(log, "utf8")).toContain("delete --project proj-1 --yes");
  });

  test("a deploy that fails stops the wait, rather than sitting out the timeout", async () => {
    const { env: e } = env({}, false, "FAILED");
    const child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts"), "setup", "--no-skill"], {
      env: e,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write("railway\n");
    child.stdin.end();
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("The deploy ended as FAILED");
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
      {
        // Stands in for a released CLI, which has an image of its own.
        env: { ...e, ARTIFACTS_RAILWAY_HTTP: "1", ARTIFACTS_IMAGE: `ghcr.io/mochahub/artifacts:${VERSION}` },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child.stdin.write("railway\n");
    child.stdin.end();
    const code = await child.exited;
    const calls = readFileSync(log, "utf8").split("\n");
    expect(await new Response(child.stderr).text()).not.toContain("failed");
    expect(code).toBe(0);
    const expected = [
      "init --name artifacts --workspace w1 --json",
      "deploy --template abc123 --variable artifacts.S3_FORCE_PATH_STYLE=false --variable Postgres.PGDATA=/var/lib/postgresql/data/pgdata --variable Postgres.PGPORT=5432 --variable Postgres.POSTGRES_DB=railway --variable Postgres.POSTGRES_USER=postgres --variable Postgres.RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60 --variable Postgres.SSL_CERT_DAYS=820",
      "service status --service artifacts --json",
      "domain list --service artifacts --json",
      `variable set PUBLIC_URL=https://${new URL(url).host} CONTENT_URL=https://content.up.railway.app --service artifacts --skip-deploys`,
      `service source connect --image ghcr.io/mochahub/artifacts:${VERSION} --service artifacts`,
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
    expect(calls).not.toContain("PUBLIC_URL=https://art.example.com");
    expect((await cli(["domain", "nonsense"], e)).code).toBe(2);
    expect(JSON.parse(result.stdout).googleRedirectUri).toBeNull();

    // With Google on, a new domain needs its own redirect, or sign-in there fails.
    await t.server.db.update(org).set({ googleClientId: "client", googleEnabled: true });
    const withGoogle = await cli(["domain", "add", "art.example.com", "--json"], e);
    expect(JSON.parse(withGoogle.stdout).googleRedirectUri).toBe(
      "https://art.example.com/api/auth/google/callback",
    );
    await t.server.db.update(org).set({ googleClientId: null, googleEnabled: false });
  });

  test("upgrade --server moves the service to the release's image", async () => {
    const { env: e, log } = env();
    const result = await cli(["upgrade", "--server", "--to", VERSION, "--json"], {
      ...e,
      ARTIFACTS_RAILWAY_POLL_MS: "20",
    });
    expect(result.stderr).not.toContain("failed");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout.slice(result.stdout.indexOf("{")))).toEqual({
      cli: VERSION,
      server: VERSION,
    });
    expect(readFileSync(log, "utf8")).toContain(
      `service source connect --image ghcr.io/mochahub/artifacts:${VERSION} --service artifacts`,
    );
  });

  test("a domain that is really a flag or a list of origins is refused", async () => {
    const { env: e, log } = env();
    const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").length : 0);
    const before = calls();
    for (const bad of ["art.example.com,https://evil.test", "https://art.example.com", "a b.com"]) {
      expect((await cli(["domain", "add", bad], e)).code).toBe(2);
    }
    // After "--", a value that starts with a dash is still a value.
    expect((await cli(["domain", "add", "--", "--help"], e)).code).toBe(2);
    expect(calls()).toBe(before);
  });

  test("upgrade refuses a version that isn't a number, and a release site that isn't https", async () => {
    const { env: e, log } = env();
    const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").length : 0);
    const before = calls();
    expect((await cli(["upgrade", "--server", "--to", "1.0.0\nSESSION_SECRET=x"], e)).code).toBe(2);
    expect((await cli(["upgrade", "--server", "--to", "../../x"], e)).code).toBe(2);
    expect(calls()).toBe(before);

    const insecure = await cli(["upgrade"], {
      ...e,
      ARTIFACTS_LATEST_URL: "http://releases.example.com/latest",
    });
    expect(insecure.code).toBe(1);
    expect(insecure.stderr).toContain("isn't https");
  });
});

describe("checksums", () => {
  test("a file name has to match whole, not just at its end", () => {
    const sums = `${"a".repeat(64)}  evil-artifacts-linux-x64\n${"b".repeat(64)}  artifacts-linux-x64\n`;
    expect(checksumFor(sums, "artifacts-linux-x64")).toBe("b".repeat(64));
    expect(
      checksumFor(`${"a".repeat(64)}  evil-artifacts-linux-x64\n`, "artifacts-linux-x64"),
    ).toBeUndefined();
    expect(checksumFor(`${"c".repeat(64)} *artifacts-linux-x64\n`, "artifacts-linux-x64")).toBe(
      "c".repeat(64),
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

describe("install.sh, when something is off", () => {
  const box = sandbox();
  const site = join(box.home, "site");
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const name = `artifacts-${os}-${arch}`;
  const body = "#!/bin/sh\necho installed\n";
  const sum = createHash("sha256").update(body).digest("hex");
  mkdirSync(join(site, "v9.9.9"), { recursive: true });
  writeFileSync(join(site, "v9.9.9", name), body);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => new Response(Bun.file(join(site, new URL(request.url).pathname))),
  });
  afterAll(() => server.stop(true));
  const script = join(import.meta.dir, "../../../scripts/install.sh");

  async function install(env: Record<string, string> = {}) {
    const child = Bun.spawn(["sh", script], {
      env: {
        ...box.env,
        ARTIFACTS_RELEASES_URL: `http://127.0.0.1:${server.port}`,
        ARTIFACTS_VERSION: "9.9.9",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: await child.exited, stderr: await new Response(child.stderr).text() };
  }

  test("a sums file with no line for this binary stops it, even if another name ends the same", async () => {
    writeFileSync(join(site, "v9.9.9/SHA256SUMS"), `${sum}  evil-${name}\n`);
    const result = await install();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no checksum");
  });

  test("a version that isn't a number, or a site that isn't https, stops it", async () => {
    writeFileSync(join(site, "v9.9.9/SHA256SUMS"), `${sum}  ${name}\n`);
    const version = await install({ ARTIFACTS_VERSION: "../../evil" });
    expect(version.code).toBe(1);
    expect(version.stderr).toContain("isn't a version number");
    const plain = await install({ ARTIFACTS_RELEASES_URL: "http://releases.example.com" });
    expect(plain.code).toBe(1);
    expect(plain.stderr).toContain("isn't https");
  });

  test("running it twice adds the PATH line once", async () => {
    writeFileSync(join(site, "v9.9.9/SHA256SUMS"), `${sum}  ${name}\n`);
    writeFileSync(join(box.home, ".zshrc"), "# mine\n");
    expect((await install()).code).toBe(0);
    expect((await install()).code).toBe(0);
    const profile = readFileSync(join(box.home, ".zshrc"), "utf8");
    expect(profile.split(".artifacts/bin").length - 1).toBe(1);
    expect(profile).toStartWith("# mine\n");
  });
});
