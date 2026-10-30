import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Thread } from "@artifacts/schema";
import { eq } from "drizzle-orm";
import { artifacts } from "../../../apps/server/src/db/schema.ts";
import { OWNER, signIn, startTestServer, type TestServer } from "../../../apps/server/test/helpers.ts";
import { camerabuddy, cli, copyFixture, sandbox } from "./sandbox.ts";

/** The round trip in M5: a person comments, an agent session fixes and replies, the person resolves. */
describe("the review loop", () => {
  let t: TestServer;
  let url: string;
  let token: string;
  let cookie: string;
  const box = sandbox();
  const agent = () => ({
    ...box.env,
    ARTIFACTS_URL: url,
    ARTIFACTS_TOKEN: token,
    ARTIFACTS_AGENT: "Claude Code",
  });

  beforeAll(async () => {
    const port = 49600 + Math.floor(Math.random() * 2000);
    url = `http://127.0.0.1:${port}`;
    t = await startTestServer({ PUBLIC_URL: url, MORE_URLS: "", PORT: String(port) });
    const setup = await t.api("/api/setup", {
      method: "POST",
      json: { setupToken: "s".repeat(48), orgName: "Mochahub", clientName: "x", ...OWNER },
    });
    token = ((await setup.json()) as { token: string }).token;
    cookie = await signIn(t, OWNER.email, OWNER.password);
  });
  afterAll(() => t.stop());

  test("comment, status, comments, fix, publish, reply --fixed, resolve", async () => {
    const dir = copyFixture(camerabuddy);
    expect((await cli(["publish", "-m", "First"], agent(), dir)).code).toBe(0);
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "roadmap"));
    const id = row?.id as string;

    // 1. A person comments, and asks for changes.
    const made = await t.api(`/api/artifacts/${id}/threads`, {
      method: "POST",
      cookie,
      json: {
        pageKey: "mocks",
        anchor: { type: "frame", frameKey: "live-view", x: 0.4, y: 0.6 },
        body: "The MF arrows are too small.",
        version: 1,
      },
    });
    expect(made.status).toBe(200);
    const thread = Thread.parse(await made.json());
    await t.api(`/api/artifacts/${id}/decisions`, {
      method: "POST",
      cookie,
      json: { version: 1, kind: "changes_requested", note: "Fix the arrows first." },
    });

    // 2. An agent session starts with status.
    const status = JSON.parse((await cli(["status", "--json"], agent(), dir)).stdout);
    expect(status).toMatchObject({
      version: 1,
      decision: "changes_requested",
      note: "Fix the arrows first.",
      by: "Zahin",
    });
    expect(status.open).toHaveLength(1);

    const comments = JSON.parse((await cli(["comments", "--open", "--json"], agent(), dir)).stdout);
    expect(comments[0]).toMatchObject({
      id: 1,
      page: "mocks",
      frame: "live-view",
      author: "Zahin",
      text: "The MF arrows are too small.",
      status: "open",
    });
    expect((await fetch(comments[0].crop)).status).toBe(200);

    // 3. It edits the source and publishes; the CLI names the thread on the changed frame.
    const board = join(dir, "boards/02-shoot.html");
    writeFileSync(board, readFileSync(board, "utf8").replace("../img/02-01.jpg", "../img/02-03.jpg"));
    const published = await cli(
      ["publish", "--json", "-m", "Bigger arrows", "--note", "live-view=Made the arrows 44 pt"],
      agent(),
      dir,
    );
    expect(published.code).toBe(0);
    const result = JSON.parse(published.stdout);
    expect(result.version).toBe(2);
    expect(result.threadsOnChanged).toEqual([1]);

    // 4. It replies.
    const reply = await cli(["reply", "1", "Made the arrows 44 pt.", "--fixed"], agent(), dir);
    expect(reply.code).toBe(0);
    expect(reply.stdout).toContain("marked fixed in v2");
    const after = JSON.parse((await cli(["status", "--json"], agent(), dir)).stdout);
    expect(after.open).toHaveLength(0);
    expect(after.fixedAwaiting[0]).toMatchObject({ id: 1, status: "fixed" });
    expect(after.fixedAwaiting[0].replies[0]).toMatchObject({ agent: "Claude Code", marksFixed: true });

    // 5. Only the person can resolve.
    expect((await t.api(`/api/threads/${thread.id}/resolve`, { method: "POST", bearer: token })).status).toBe(
      403,
    );
    expect((await t.api(`/api/threads/${thread.id}/resolve`, { method: "POST", cookie })).status).toBe(200);
    const done = JSON.parse((await cli(["comments", "--all", "--json"], agent(), dir)).stdout);
    expect(done[0].status).toBe("resolved");
  }, 180_000);

  test("renaming a frame with open comments stops the publish", async () => {
    const dir = copyFixture(camerabuddy);
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "roadmap"));
    await t.api(`/api/artifacts/${row?.id}/threads`, {
      method: "POST",
      cookie,
      json: {
        pageKey: "mocks",
        anchor: { type: "frame", frameKey: "timer", x: 0.5, y: 0.5 },
        body: "x",
        version: 2,
      },
    });
    const board = join(dir, "boards/02-shoot.html");
    writeFileSync(board, readFileSync(board, "utf8").replace('data-frame="timer"', 'data-frame="countdown"'));
    const result = await cli(["publish"], agent(), dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("frames/renamed");
  }, 120_000);

  test("org invite, reset-link, visibility and share", async () => {
    const dir = copyFixture(camerabuddy);
    const invite = JSON.parse(
      (await cli(["org", "invite", "sam@example.com", "--role", "reviewer", "--json"], agent())).stdout,
    );
    expect(invite.url).toContain("/join/");
    expect((await cli(["org", "invite", "x@example.com", "--role", "owner"], agent())).code).toBe(1);
    const joined = await t.api(`/api/invites/${invite.url.split("/join/")[1]}/accept`, {
      method: "POST",
      json: { name: "Sam", password: "a perfectly long password" },
    });
    expect(joined.status).toBe(200);
    const reset = JSON.parse((await cli(["org", "reset-link", "sam@example.com", "--json"], agent())).stdout);
    expect(reset.url).toContain("/reset/");
    expect((await cli(["org", "reset-link", OWNER.email], agent())).code).toBe(1);
    expect((await cli(["org", "reset-link", "nobody@example.com"], agent())).code).toBe(1);

    expect((await cli(["visibility", "me"], agent(), dir)).code).toBe(0);
    expect((await cli(["visibility", "nonsense"], agent(), dir)).code).toBe(2);
    const link = JSON.parse(
      (await cli(["share", "--link", "--comment", "--expires", "7d", "--json"], agent(), dir)).stdout,
    );
    expect(link.url).toContain("/s/");
    const person = JSON.parse(
      (await cli(["share", "--invite", "out@example.com", "--comment", "--json"], agent(), dir)).stdout,
    );
    expect(person.url).toContain("/join/");
    expect((await cli(["share", "--invite", "out2@example.com", "--publish"], agent(), dir)).code).toBe(1);
    expect((await cli(["share"], agent(), dir)).code).toBe(2);
  });

  test("versions, name, diff, restore, archive, delete and undelete", async () => {
    const dir = copyFixture(camerabuddy);
    const run = (...args: string[]) => cli(args, agent(), dir);
    const list = JSON.parse((await run("versions", "--json")).stdout);
    expect(list[0].n).toBe(2);
    expect((await run("versions", "name", "1", "First draft")).code).toBe(0);
    const diff = JSON.parse((await run("diff", "v1", "v2", "--json")).stdout);
    expect(diff.frames.changed).toEqual(["mocks/live-view"]);
    expect(JSON.parse((await run("restore", "1", "--json")).stdout)).toEqual({ n: 3 });

    expect((await run("archive")).code).toBe(0);
    expect((await run("publish", "-m", "x")).code).toBe(1);
    expect((await run("archive", "--undo")).code).toBe(0);

    const removed = JSON.parse((await run("delete", "--version", "2", "--json")).stdout);
    expect(removed.undo).toBe("artifacts undelete camerabuddy/roadmap --version 2");
    expect((await run("undelete", "camerabuddy/roadmap", "--version", "2")).code).toBe(0);

    const deleted = await cli(["delete", "camerabuddy/roadmap", "--json"], agent());
    expect(JSON.parse(deleted.stdout).purgeAfter).toBeString();
    expect((await run("status")).code).toBe(1);
    expect((await cli(["undelete", "camerabuddy/roadmap"], agent())).code).toBe(0);
    expect((await run("status")).code).toBe(0);
    expect((await cli(["undelete", "nothing/here"], agent())).code).toBe(1);
  }, 120_000);

  test("skill install writes both folders, and never outside this home", async () => {
    const result = await cli(["skill", "install", "--json"], box.env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).installed).toEqual([
      join(box.home, ".claude/skills/artifacts"),
      join(box.home, ".codex/skills/artifacts"),
    ]);
    expect(existsSync(join(box.home, ".claude/skills/artifacts/SKILL.md"))).toBe(true);
    expect(existsSync(join(box.home, ".codex/skills/artifacts/references/lint.md"))).toBe(true);
    const codex = await cli(["skill", "install", "--codex", "--json"], {
      ...box.env,
      CODEX_HOME: join(box.home, "cx"),
    });
    expect(JSON.parse(codex.stdout).installed).toEqual([join(box.home, "cx/skills/artifacts")]);
  });
});
