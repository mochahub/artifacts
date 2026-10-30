import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ArtifactReviewStatus, Comment, PublishResult, Thread } from "@artifacts/schema";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";
import { artifacts, passwords, people } from "../../src/db/schema.ts";
import { claim, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { makePerson, publish } from "../publish-helper.ts";

const error = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe("the review API", () => {
  let t: TestServer;
  let token: string;
  let cookie: string;
  let id: string;
  let reviewer: string;
  let viewerOnly: string;

  const thread = async (overrides: Record<string, unknown> = {}, bearer = token) =>
    t.api(`/api/artifacts/${id}/threads`, {
      method: "POST",
      bearer,
      json: {
        pageKey: "mocks",
        anchor: { type: "frame", frameKey: "live-view", x: 0.5, y: 0.5 },
        body: "Move this up",
        version: 1,
        ...overrides,
      },
    });
  const made = async (overrides?: Record<string, unknown>) =>
    Thread.parse(await (await thread(overrides)).json());
  const reply = (
    threadId: string,
    json: Record<string, unknown>,
    auth: { bearer?: string; cookie?: string },
  ) => t.api(`/api/threads/${threadId}/comments`, { method: "POST", json, ...auth });

  beforeAll(async () => {
    t = await startTestServer();
    const owner = await claim(t);
    token = owner.token;
    // A real image, so crops can be cut.
    const png = await sharp({ create: { width: 786, height: 1704, channels: 4, background: "#20232a" } })
      .webp()
      .toBuffer();
    await publish(t, token, { renderBytes: png });
    cookie = await signIn(t, OWNER.email, OWNER.password);
    id = (await t.server.db.select().from(artifacts))[0]?.id as string;
    const orgId = (await t.server.db.select().from(people))[0]?.orgId as string;
    reviewer = await makePerson(t, orgId, "reviewer");
    viewerOnly = await makePerson(t, orgId, "outside");
  });
  afterAll(() => t.stop());

  test("a thread on a frame gets a number, a crop, and its first comment", async () => {
    const first = await made();
    expect(first).toMatchObject({ n: 1, status: "open", anchorState: "ok", createdVersion: 1 });
    expect(first.comments[0]?.body).toBe("Move this up");
    expect(first.crop).toContain("crops/");
    const crop = await fetch(first.crop as string);
    const { width, height } = await sharp(await crop.arrayBuffer()).metadata();
    expect([width, height]).toEqual([480, 320]);
    const redirect = await t.api(`/api/threads/${first.id}/crop`, { bearer: token, redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect((await made()).n).toBe(2);
  });

  test("article and page-level threads have no crop; bad anchors and versions are refused", async () => {
    const quote = { type: "text", blockKey: "intro/p1", quote: { exact: "Hello", prefix: "", suffix: "" } };
    const text = await made({ pageKey: "plan", anchor: quote });
    expect(text.crop).toBeNull();
    expect((await made({ pageKey: "plan", anchor: null })).anchor).toBeNull();
    expect((await thread({ anchor: { type: "frame", frameKey: "nope", x: 0, y: 0 } })).status).toBe(400);
    expect((await thread({ pageKey: "plan", anchor: { type: "block", blockKey: "no" } })).status).toBe(400);
    expect((await thread({ version: 99 })).status).toBe(400);
    expect((await thread({ anchor: { type: "frame", frameKey: "live-view", x: 2, y: 0 } })).status).toBe(400);
  });

  test("a quote, a page key and a decision's note have a size limit", async () => {
    const quote = (exact: string, prefix = "", suffix = "") => ({
      type: "text",
      blockKey: "intro/p1",
      quote: { exact, prefix, suffix },
    });
    expect((await thread({ pageKey: "plan", anchor: quote("x".repeat(10_001)) })).status).toBe(400);
    expect((await thread({ pageKey: "plan", anchor: quote("Hello", "x".repeat(501)) })).status).toBe(400);
    expect((await thread({ pageKey: "p".repeat(501), anchor: null })).status).toBe(400);
    const decide = await t.api(`/api/artifacts/${id}/decisions`, {
      method: "POST",
      cookie,
      json: { version: 1, kind: "approved", note: "n".repeat(10_001) },
    });
    expect(decide.status).toBe(400);
  });

  test("a version number the database can't hold is a 400, not a 500", async () => {
    const huge = 99_999_999_999;
    expect((await thread({ version: huge })).status).toBe(400);
    expect((await t.api(`/api/artifacts/${id}/threads?version=${huge}`, { bearer: token })).status).toBe(400);
    const decide = await t.api(`/api/artifacts/${id}/decisions`, {
      method: "POST",
      cookie,
      json: { version: huge, kind: "approved" },
    });
    expect(decide.status).toBe(400);
    expect(await error(decide)).toBe("invalid");
  });

  test("permissions: outsiders see nothing, no caller is refused", async () => {
    expect((await t.api(`/api/artifacts/${id}/threads`)).status).toBe(401);
    expect((await t.api(`/api/artifacts/${id}/threads`, { bearer: viewerOnly })).status).toBe(404);
    expect((await thread({}, viewerOnly)).status).toBe(404);
  });

  test("fixed, then a reply from someone else reopens it", async () => {
    const one = await made();
    const fixed = await reply(
      one.id,
      { body: "Moved it", marksFixed: true, agent: "Claude Code" },
      { bearer: token },
    );
    expect(fixed.status).toBe(200);
    const comment = Comment.parse(await fixed.json());
    expect(comment).toMatchObject({
      agent: "Claude Code",
      marksFixed: true,
      author: { name: "Claude Code", kind: "agent" },
    });

    const list = z
      .array(Thread)
      .parse(await (await t.api(`/api/artifacts/${id}/threads?status=fixed`, { bearer: token })).json());
    expect(list.find((row) => row.id === one.id)?.fixedVersion).toBe(1);

    expect((await reply(one.id, { body: "Not quite" }, { bearer: reviewer })).status).toBe(200);
    const after = z
      .array(Thread)
      .parse(await (await t.api(`/api/artifacts/${id}/threads?status=open`, { bearer: token })).json());
    expect(after.find((row) => row.id === one.id)?.fixedVersion).toBeNull();
  });

  test("the fixer can add to their own fix without reopening it", async () => {
    const one = await made();
    await reply(one.id, { body: "Done", marksFixed: true, agent: "Claude Code" }, { bearer: token });
    await reply(one.id, { body: "Also checked SE", agent: "Claude Code" }, { bearer: token });
    const status = ArtifactReviewStatus.parse(
      await (await t.api(`/api/artifacts/${id}/status`, { bearer: token })).json(),
    );
    expect(status.fixedAwaiting.map((row) => row.id)).toContain(one.id);
  });

  test("marking fixed needs a CLI token or the publisher", async () => {
    const one = await made();
    expect((await reply(one.id, { body: "Done", marksFixed: true }, { bearer: reviewer })).status).toBe(200);
    expect((await reply(one.id, { body: "Done", marksFixed: true }, { cookie })).status).toBe(200);
    // A member in a browser, who didn't publish it, can't.
    const orgId = (await t.server.db.select().from(people))[0]?.orgId as string;
    const hash = await Bun.password.hash(OWNER.password, { algorithm: "argon2id" });
    await makePerson(t, orgId, "member");
    const member = (await t.server.db.select().from(people)).filter((row) => row.role === "member").at(-1);
    await t.server.db.insert(passwords).values({ personId: member?.id as string, orgId, hash });
    const session = await signIn(t, member?.email as string, OWNER.password);
    expect((await reply(one.id, { body: "Done", marksFixed: true }, { cookie: session })).status).toBe(403);
  });

  test("only people resolve, never tokens; reopening works", async () => {
    const one = await made();
    expect(
      await error(await t.api(`/api/threads/${one.id}/resolve`, { method: "POST", bearer: token })),
    ).toBe("forbidden");
    const resolved = await t.api(`/api/threads/${one.id}/resolve`, { method: "POST", cookie });
    expect(Thread.parse(await resolved.json()).status).toBe("resolved");
    const open = await t.api(`/api/threads/${one.id}/reopen`, { method: "POST", cookie });
    expect(Thread.parse(await open.json())).toMatchObject({ status: "open", resolvedAt: null });
    expect((await t.api("/api/threads/not-a-thread/resolve", { method: "POST", cookie })).status).toBe(404);
  });

  test("a token can't take a thread out of resolved", async () => {
    const one = await made();
    await t.api(`/api/threads/${one.id}/resolve`, { method: "POST", cookie });
    const refused = await reply(one.id, { body: "Done", marksFixed: true }, { bearer: token });
    expect(refused.status).toBe(409);
  });

  test("a thread's number is never reused, even after its only comment is deleted", async () => {
    const one = await made();
    await t.api(`/api/comments/${one.comments[0]?.id}`, { method: "DELETE", bearer: token });
    expect((await made()).n).toBe(one.n + 1);
  });

  test("you edit or delete only your own comment, for 24 hours", async () => {
    const one = await made();
    const commentId = one.comments[0]?.id as string;
    const url = `/api/comments/${commentId}`;
    expect((await t.api(url, { method: "PATCH", bearer: reviewer, json: { body: "Mine now" } })).status).toBe(
      403,
    );
    const edited = await t.api(url, { method: "PATCH", bearer: token, json: { body: "Better" } });
    expect(Comment.parse(await edited.json()).body).toBe("Better");
    expect((await t.api(url, { method: "DELETE", bearer: reviewer })).status).toBe(403);
    expect((await t.api(url, { method: "PATCH", json: { body: "x" } })).status).toBe(401);

    const later = await made();
    t.clock.advance(25 * 3600_000);
    expect(
      (
        await t.api(`/api/comments/${later.comments[0]?.id}`, {
          method: "PATCH",
          bearer: token,
          json: { body: "x" },
        })
      ).status,
    ).toBe(403);
    expect((await t.api(url, { method: "DELETE", bearer: token })).status).toBe(403);

    const fresh = await made();
    expect(
      (await t.api(`/api/comments/${fresh.comments[0]?.id}`, { method: "DELETE", bearer: token })).status,
    ).toBe(200);
    const list = z
      .array(Thread)
      .parse(await (await t.api(`/api/artifacts/${id}/threads`, { bearer: token })).json());
    expect(list.some((row) => row.id === fresh.id)).toBe(false);
  });

  test("deleting one reply keeps the thread", async () => {
    const one = await made();
    const added = Comment.parse(await (await reply(one.id, { body: "More" }, { bearer: token })).json());
    expect((await t.api(`/api/comments/${added.id}`, { method: "DELETE", bearer: token })).status).toBe(200);
    const list = z
      .array(Thread)
      .parse(await (await t.api(`/api/artifacts/${id}/threads`, { bearer: token })).json());
    expect(list.find((row) => row.id === one.id)?.comments).toHaveLength(1);
  });

  test("decisions: people only, and status reports the latest", async () => {
    const decide = (json: unknown, auth: { bearer?: string; cookie?: string }) =>
      t.api(`/api/artifacts/${id}/decisions`, { method: "POST", json, ...auth });
    expect((await decide({ version: 1, kind: "approved" }, { bearer: token })).status).toBe(403);
    expect((await decide({ version: 9, kind: "approved" }, { cookie })).status).toBe(400);
    const made_ = await decide({ version: 1, kind: "changes_requested", note: "Tighten it" }, { cookie });
    expect(made_.status).toBe(200);
    const status = ArtifactReviewStatus.parse(
      await (await t.api(`/api/artifacts/${id}/status`, { bearer: token })).json(),
    );
    expect(status).toMatchObject({
      version: 1,
      decision: "changes_requested",
      note: "Tighten it",
      decisionVersion: 1,
    });
    expect(status.open.length).toBeGreaterThan(0);
  });

  test("the comment rate limit is 30 a minute", async () => {
    const results: number[] = [];
    t.clock.advance(61_000);
    for (let i = 0; i < 31; i++)
      results.push((await thread({ pageKey: "plan", anchor: null }, reviewer)).status);
    expect(results.filter((status) => status === 200)).toHaveLength(30);
    expect(results.at(-1)).toBe(429);
    t.clock.advance(61_000);
  });

  test("archived: read-only, and reads still work", async () => {
    await t.server.db.update(artifacts).set({ archivedAt: t.clock.now() }).where(eq(artifacts.id, id));
    expect(await error(await thread())).toBe("read_only");
    const list = z
      .array(Thread)
      .parse(await (await t.api(`/api/artifacts/${id}/threads`, { bearer: token })).json());
    const one = list[0] as { id: string };
    expect(await error(await t.api(`/api/threads/${one.id}/resolve`, { method: "POST", cookie }))).toBe(
      "read_only",
    );
    expect(await error(await reply(one.id, { body: "x" }, { bearer: token }))).toBe("read_only");
    const decided = await t.api(`/api/artifacts/${id}/decisions`, {
      method: "POST",
      cookie,
      json: { version: 1, kind: "approved" },
    });
    expect(await error(decided)).toBe("read_only");
    await t.server.db.update(artifacts).set({ archivedAt: null }).where(eq(artifacts.id, id));
  });

  test("publishing re-anchors: a changed frame is reported, and a missing one is orphaned", async () => {
    const before = await made();
    const changed = PublishResult.parse(
      await (await publish(t, token, { frameHash: "c".repeat(64) })).json(),
    );
    expect(changed.threadsOnChanged).toContain(before.n);
    const list = z
      .array(Thread)
      .parse(await (await t.api(`/api/artifacts/${id}/threads`, { bearer: token })).json());
    expect(list.find((row) => row.id === before.id)?.anchorState).toBe("updated");

    const gone = PublishResult.parse(await (await publish(t, token, { frameKey: "renamed" })).json());
    expect(gone.orphaned).toContain(before.n);
  });
});
