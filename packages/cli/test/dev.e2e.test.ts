import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyFixture, sandbox, start } from "./sandbox.ts";

describe("artifacts dev", () => {
  const box = sandbox();
  const dir = copyFixture(join(import.meta.dir, "../../../fixtures/micro-app-poll-backend"));
  const port = 53600 + Math.floor(Math.random() * 1000);
  const viewer = `http://localhost:${port}`;
  const content = `http://127.0.0.1:${port + 1}`;
  let child: ReturnType<typeof start>;

  beforeAll(async () => {
    child = start(["dev", "--port", String(port)], box.env, dir);
    child.stdin.end();
    for (let i = 0; i < 240; i++) {
      const up = await fetch(`${viewer}/api/meta`).catch(() => null);
      if (up?.ok) return;
      await Bun.sleep(250);
    }
    throw new Error("dev never started");
  }, 90_000);
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
