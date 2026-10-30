import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyFixture, sandbox, start } from "./sandbox.ts";

describe("artifacts dev", () => {
  const box = sandbox();
  const dir = copyFixture(join(import.meta.dir, "../../../fixtures/micro-app-poll-backend"));
  const port = 53600 + Math.floor(Math.random() * 1000);
  const viewer = `http://localhost:${port}`;
  const origin = `http://127.0.0.1:${port + 1}`;
  const ID = "00000000-0000-7000-8000-00000000d0d0";
  /** The content host's address for this run. It has a secret in the path, which only the viewer's API hands out. */
  let content = origin;
  let child: ReturnType<typeof start>;

  beforeAll(async () => {
    // `dev` serves the built viewer, which a fresh checkout hasn't built when tests run first.
    if (!existsSync(join(import.meta.dir, "../../../apps/viewer/dist/index.html"))) {
      const built = Bun.spawnSync(["bun", "run", "--filter", "@artifacts/viewer", "build"]);
      expect(built.success).toBe(true);
    }
    const backend = join(dir, "api/index.js");
    writeFileSync(
      backend,
      readFileSync(backend, "utf8").replace(
        "const who = caller(request);",
        `if (request.url.endsWith("/escape")) {
      const code = await env.DATA.put("../../escaped.json", 1).catch((error) => error.code);
      return Response.json({ code });
    }
    const who = caller(request);`,
      ),
    );
    // An article page, to prove its route works.
    writeFileSync(join(dir, "notes.md"), "# Notes\n\nHello from the notes.\n");
    const manifest = JSON.parse(readFileSync(join(dir, "artifact.json"), "utf8"));
    manifest.pages.push({ id: "notes", kind: "article", src: "notes.md" });
    writeFileSync(join(dir, "artifact.json"), JSON.stringify(manifest));
    child = start(["dev", "--port", String(port)], box.env, dir);
    child.stdin.end();
    for (let i = 0; i < 240; i++) {
      const up = await fetch(`${viewer}/api/meta`).catch(() => null);
      if (up?.ok) {
        const token = await fetch(`${viewer}/api/artifacts/${ID}/content-token`, { method: "POST" });
        content = ((await token.json()) as { base: string }).base.replace(/\/v\d+\/$/, "");
        return;
      }
      await Bun.sleep(250);
    }
    throw new Error("dev never started");
  }, 180_000);
  afterAll(() => {
    child.kill();
  });

  test("serves the real viewer and the artifact, with no server", async () => {
    expect(await (await fetch(`${viewer}/`)).text()).toContain('id="app"');
    const artifact = (await (await fetch(`${viewer}/api/artifacts/by-slug/demo/poll-backend`)).json()) as {
      latestVersion: number;
      permissions: { comment: boolean };
    };
    expect(artifact.latestVersion).toBe(1);
    expect(artifact.permissions.comment).toBe(false);
  });

  test("shows an article", async () => {
    const page = await fetch(`${viewer}/api/artifacts/${ID}/v/1/article/notes`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Hello from the notes.");
  });

  test("keeps other websites out: the content host needs its secret, and each host its own Host", async () => {
    // No secret in the path, as a page that only guessed the port would have it.
    const guess = await fetch(`${origin}/v1/api/votes`, { method: "POST", body: '{"choice":"a"}' });
    expect(guess.status).toBe(404);
    expect((await fetch(`${origin}/v1/boards/main.html`)).status).toBe(404);
    // A name that someone's DNS pointed here (rebinding) has the right port but the wrong Host.
    expect((await fetch(`${viewer}/api/meta`, { headers: { Host: "evil.example.com" } })).status).toBe(403);
    expect((await fetch(`${content}/v1/api/votes`, { headers: { Host: "evil.example.com" } })).status).toBe(403);
    expect((await fetch(`${viewer}/api/meta`)).status).toBe(200);
  });

  test("runs the backend in the sandbox, with data in .artifacts/data", async () => {
    const vote = await fetch(`${content}/v1/api/votes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"choice":"b"}',
    });
    expect(await vote.json()).toMatchObject({ totals: { a: 0, b: 1 }, mine: "b", name: "You" });
    const stored = JSON.parse(readFileSync(join(dir, ".artifacts/data/shared/votes"), "utf8"));
    expect(stored.by.local).toBe("b");
  });

  test("a backend's keys and the local store can't leave the data folder", async () => {
    const up = await fetch(`${content}/v1/api/escape`, { method: "POST", body: "{}" });
    expect(await up.json()).toEqual({ code: "invalid" });
    const put = await fetch(
      `${viewer}/api/artifacts/00000000-0000-7000-8000-00000000d0d0/data/me/%2e%2e%2f%2e%2e%2fescaped`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: '{"value":1}' },
    );
    expect(put.status).toBe(400);
    expect(existsSync(join(dir, "escaped.json"))).toBe(false);
    expect(existsSync(join(dir, ".artifacts/escaped"))).toBe(false);
  });

  test("the built-in store works locally, with conditional writes", async () => {
    const put = (body: unknown, headers = {}) =>
      fetch(`${viewer}/api/artifacts/00000000-0000-7000-8000-00000000d0d0/data/me/x`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ value: body }),
      });
    const { etag } = (await (await put(1)).json()) as { etag: string };
    expect((await put(2, { "If-Match": "stale" })).status).toBe(412);
    expect((await put(2, { "If-Match": etag })).status).toBe(200);
  });

  test("a change is picked up as the next version", async () => {
    const page = join(dir, "boards/main.html");
    writeFileSync(page, readFileSync(page, "utf8").replace("Two options", "Three options"));
    for (let i = 0; i < 120; i++) {
      const body = (await (await fetch(`${viewer}/api/artifacts/by-slug/demo/poll-backend`)).json()) as {
        latestVersion: number;
      };
      if (body.latestVersion === 2) return;
      await Bun.sleep(250);
    }
    throw new Error("no new version");
  }, 40_000);
});
