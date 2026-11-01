import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UNTRUSTED_NOTICE } from "@artifacts/schema";
import {
  OWNER,
  signIn,
  startTestServer,
  type TestServer,
  testPort,
} from "../../../apps/server/test/helpers.ts";
import { codexConfig } from "../src/commands/connect.ts";
import { cli, copyFixture, sandbox } from "./sandbox.ts";

const artStyles = join(import.meta.dir, "../../../fixtures/art-styles");

describe("a box with no login, through the hosted MCP", () => {
  let t: TestServer;
  let url: string;
  let token: string;
  let cookie: string;
  // No ARTIFACTS_TOKEN, no ARTIFACTS_URL and no config: the connector is the only sign-in here.
  const box = sandbox();
  let id = 1;
  const rpc = async (method: string, params: object) => {
    const response = await fetch(`${url}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
    });
    return (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  };
  const tool = async (name: string, args: object) => {
    const { result } = await rpc("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(`${name}: ${result.content[0]?.text}`);
    return result;
  };
  const json = async (name: string, args: object) =>
    JSON.parse((await tool(name, args)).content.at(-1)?.text as string);
  const run = async (args: string[], dir: string) => {
    const result = await cli(args, box.env, dir);
    if (result.code !== 0) throw new Error(`${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };

  beforeAll(async () => {
    const port = testPort();
    url = `http://127.0.0.1:${port}`;
    t = await startTestServer({ PUBLIC_URL: url, MORE_URLS: "", PORT: String(port) });
    const setup = await t.api("/api/setup", {
      method: "POST",
      json: { setupToken: "s".repeat(48), orgName: "Mochahub", clientName: "x", ...OWNER },
    });
    token = ((await setup.json()) as { token: string }).token;
    cookie = await signIn(t, OWNER.email, OWNER.password);
  }, 60_000);
  afterAll(() => t.stop());

  test("search, pack, upload, commit, read comments and reply", async () => {
    const dir = copyFixture(artStyles);
    const pack = JSON.parse(await run(["pack", "--json", "-m", "From a remote box"], dir));
    expect(pack.payload.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The payload goes first, then the files, each by a plan the server wrote to the bucket.
    const first = await json("artifacts_publish_prepare", pack);
    expect(first.step).toBe("upload_payload");
    expect(JSON.stringify(first).length).toBeLessThan(2000);
    await run(["pack", "--upload", first.plan, "--json"], dir);
    const second = await json("artifacts_publish_prepare", pack);
    expect(second.step).toBe("upload_files");
    expect(second.missing).toBeGreaterThan(3);
    expect(JSON.stringify(second).length).toBeLessThan(3000);
    await run(["pack", "--upload", second.plan, "--json"], dir);
    const done = await json("artifacts_publish_commit", {
      uploadId: second.uploadId,
      payload: pack.payload.sha256,
    });
    expect(done.version).toBe(1);

    const found = await json("artifacts_search", { query: "risograph" });
    expect(found.cards[0].slug).toBe("art-styles");
    const read = await json("artifacts_read", { artifact: "forest-game/art-styles" });
    expect(read.items.map((item: { ref: string }) => item.ref)).toContain("gouache");
    const view = await rpc("tools/call", {
      name: "artifacts_view",
      arguments: { artifact: "forest-game/art-styles", frame: "ink" },
    });
    expect((view.result.content[1] as unknown as { type: string }).type).toBe("image");

    const { id: artifact } = (await (
      await t.api("/api/artifacts/by-slug/forest-game/art-styles", { cookie })
    ).json()) as { id: string };
    await t.api(`/api/artifacts/${artifact}/threads`, {
      method: "POST",
      cookie,
      json: { pageKey: "studies", anchor: null, body: "Warmer please", version: 1 },
    });
    const comments = await tool("artifacts_comments", { artifact: "forest-game/art-styles" });
    expect(comments.content[0]?.text).toBe(UNTRUSTED_NOTICE);
    const [thread] = JSON.parse(comments.content[1]?.text as string);
    expect(thread.text).toBe("Warmer please");
    const reply = await json("artifacts_reply", {
      artifact: "forest-game/art-styles",
      n: thread.id,
      message: "Warmed in v2",
      fixed: true,
    });
    expect(reply.marksFixed).toBe(true);
    const status = await json("artifacts_status", { artifact: "forest-game/art-styles" });
    expect(status.open).toEqual([]);
  }, 120_000);

  test("a tampered payload or file fails exactly as the API's commit does", async () => {
    const dir = copyFixture(artStyles);
    const path = join(dir, "artifact.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...manifest, slug: "tampered", title: "Tampered one" }));
    const pack = JSON.parse(await run(["pack", "--json"], dir));
    const first = await json("artifacts_publish_prepare", pack);
    const planned = (await (await fetch(first.plan)).json()) as {
      missing: { url: string; headers: Record<string, string> }[];
    };
    const item = planned.missing[0] as { url: string; headers: Record<string, string> };
    await fetch(item.url, {
      method: "PUT",
      headers: item.headers,
      body: "x".repeat(pack.payload.size),
    });
    const refused = await rpc("tools/call", { name: "artifacts_publish_prepare", arguments: pack });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0]?.text).toContain("doesn't match what was uploaded");
    // It was deleted, so the honest upload can still go through.
    expect((await json("artifacts_publish_prepare", pack)).step).toBe("upload_payload");
  }, 60_000);

  test("a ticket commits only its own payload, and a plan can't point elsewhere", async () => {
    const dir = copyFixture(artStyles);
    const pack = JSON.parse(await run(["pack", "--json"], dir));
    await run(
      ["pack", "--upload", (await json("artifacts_publish_prepare", pack)).plan, "--json"],
      dir,
    ).catch(() => "");
    const second = await json("artifacts_publish_prepare", pack);
    const other = "a".repeat(64);
    const swapped = await rpc("tools/call", {
      name: "artifacts_publish_commit",
      arguments: { uploadId: second.uploadId, payload: other },
    });
    expect(swapped.result.isError).toBe(true);

    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          missing: [{ sha256: pack.payload.sha256, url: "https://evil.test/x", headers: {} }],
        }),
    });
    const result = await cli(["pack", "--upload", `http://127.0.0.1:${server.port}/plan`], box.env, dir);
    server.stop(true);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("points somewhere else");
  }, 60_000);

  test("a reviewer's token gets no upload URL", async () => {
    const dir = copyFixture(artStyles);
    const pack = JSON.parse(await run(["pack", "--json"], dir));
    const invite = await t.api("/api/invites", {
      method: "POST",
      cookie,
      json: { email: "rev@example.com", role: "reviewer" },
    });
    expect(invite.status).toBe(200);
    const { makePerson } = await import("../../../apps/server/test/publish-helper.ts");
    const [org] = await t.server.db.query.org.findMany();
    const reviewer = await makePerson(t, (org as { id: string }).id, "reviewer");
    const response = await fetch(`${url}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${reviewer}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "artifacts_publish_prepare", arguments: { ...pack, slug: "reviewers" } },
      }),
    });
    const body = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(JSON.stringify(body)).not.toContain("X-Amz");
  }, 60_000);
});

describe("artifacts mcp install", () => {
  test("Codex gets its config, and what's already there stays", () => {
    const before = 'model = "x"\n\n[mcp_servers.other]\nurl = "https://o"\n';
    const once = codexConfig(before, "https://a.test/api/mcp", "ARTIFACTS_MCP_TOKEN");
    expect(once).toContain('model = "x"');
    expect(once).toContain("[mcp_servers.other]");
    expect(once).toContain('bearer_token_env_var = "ARTIFACTS_MCP_TOKEN"');
    const twice = codexConfig(once, "https://b.test/api/mcp");
    expect(twice.match(/mcp_servers\.artifacts/g)).toHaveLength(1);
    expect(twice).toContain("https://b.test/api/mcp");
    expect(twice).not.toContain("bearer_token_env_var");
  });

  test("it writes to both clients, in a sandbox", async () => {
    const box = sandbox();
    const bin = join(box.home, "bin");
    mkdirSync(bin);
    const log = join(box.home, "claude.log");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" > ${log}\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const env = { ...box.env, PATH: `${bin}:${box.env.PATH}`, ARTIFACTS_URL: "https://art.example.org" };
    const result = await cli(["mcp", "install", "--token-env", "ART_TOKEN", "--json"], env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).installed).toEqual(["claude", "codex"]);
    const added = readFileSync(log, "utf8");
    expect(added).toContain("mcp add --transport http");
    expect(added).toContain("https://art.example.org/api/mcp");
    expect(added).toContain("Authorization: Bearer ${ART_TOKEN}");
    expect(readFileSync(join(box.home, ".codex/config.toml"), "utf8")).toContain(
      "https://art.example.org/api/mcp",
    );
    const bad = await cli(["mcp", "install", "--token-env", "$(rm -rf)"], env);
    expect(bad.code).toBe(2);
  });
});
