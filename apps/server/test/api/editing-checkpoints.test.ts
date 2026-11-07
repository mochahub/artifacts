import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI_SCOPES, EDIT_QUIET_MS } from "@artifacts/schema";
import { and, eq } from "drizzle-orm";
import {
  activity,
  artifacts,
  blockAliases,
  blocks,
  comments,
  editDocs,
  editPresence,
  pages,
  people,
  threads,
  tokens,
  versions,
} from "../../src/db/schema.ts";
import { sweepDrafts } from "../../src/jobs/editing.ts";
import { claim, json, mcp, OWNER, orgToken, signIn, startTestServer, type TestServer } from "../helpers.ts";

/** 13, "Checkpoints": agent and quiet ones, fixes, legacy threads, restore and publish over a draft, carry-over. */
describe("checkpoints", () => {
  let t: TestServer;
  let token: string;
  let orgId: string;
  let owner: string;
  let id: string;

  const article = (markdown: string) =>
    mcp(t, token, "tools/call", {
      name: "artifacts_publish_article",
      arguments: { project: "brain", slug: "pricing", title: "Pricing", summary: "How we price.", markdown },
    }).then(async (r) => (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } });
  const ops = async (body: object) =>
    json<{ results: { outcome: string }[]; version: number | null }>(
      await t.api(`/api/artifacts/${id}/doc/ops`, {
        method: "POST",
        bearer: token,
        json: { agent: "Claude Code", ...body },
      }),
    );
  const insert = (markdown: string, extra: object = {}) =>
    ops({ ops: [{ op: "insert", after: null, markdown }], ...extra });
  const version = async (n: number) => {
    const [row] = await t.server.db
      .select()
      .from(versions)
      .where(and(eq(versions.artifactId, id), eq(versions.n, n)));
    return row;
  };
  const idsOf = async (n: number) => {
    const row = await version(n);
    const [page] = await t.server.db
      .select({ meta: pages.meta })
      .from(pages)
      .where(eq(pages.versionId, row?.id as string));
    return page?.meta.blockIds ?? [];
  };

  beforeAll(async () => {
    t = await startTestServer();
    ({ token, orgId } = await claim(t));
    owner = await signIn(t, OWNER.email, OWNER.password);
    await t.server.db.update(tokens).set({ scopes: [...CLI_SCOPES] });
    await t.api("/api/wikis", { method: "POST", bearer: token, json: { slug: "brain", name: "Brain" } });
    expect((await article("# Pricing\n\nOne.\n\nTwo.\n")).result.isError).toBeFalsy();
    const [row] = await t.server.db.select({ id: artifacts.id }).from(artifacts).limit(1);
    id = row?.id as string;
    await t.api(`/api/artifacts/${id}/doc/maintained`, {
      method: "PUT",
      cookie: owner,
      json: { agentMaintained: true },
    });
  });
  afterAll(() => t.stop());

  test("an agent's checkpoint fixes its thread, and a legacy thread re-anchors to the lasting id", async () => {
    const thread = await json<{ n: number }>(
      await t.api(`/api/artifacts/${id}/threads`, {
        method: "POST",
        cookie: owner,
        json: {
          pageKey: "doc",
          anchor: { type: "block", blockKey: "pricing/p1" },
          body: "Say more.",
          version: 1,
        },
      }),
    );
    const done = await insert("A new first line.", { fixes: [thread.n] });
    expect(done.results[0]?.outcome).toBe("applied");
    const saved = await t.api(`/api/artifacts/${id}/doc/checkpoint`, {
      method: "POST",
      bearer: token,
      json: {},
    });
    expect(await saved.json()).toEqual({ version: 2, created: true, kind: "agent" });
    expect(await version(2)).toMatchObject({ checkpoint: "agent", agent: "agent" });
    const [alias] = await t.server.db
      .select()
      .from(blockAliases)
      .where(and(eq(blockAliases.artifactId, id), eq(blockAliases.legacyKey, "pricing/p1")));
    const [row] = await t.server.db.select().from(threads).where(eq(threads.artifactId, id));
    expect(row).toMatchObject({
      status: "fixed",
      fixedVersion: 2,
      anchorState: "ok",
      anchor: { type: "block", blockKey: alias?.blockId },
    });
  });

  test("the sweep makes a quiet checkpoint after the typing stops", async () => {
    await insert("Another line.");
    expect((await sweepDrafts(t.server.deps)).checkpoints).toBe(0);
    t.clock.advance(EDIT_QUIET_MS + 1000);
    expect((await sweepDrafts(t.server.deps)).checkpoints).toBe(1);
    expect(await version(3)).toMatchObject({ checkpoint: "quiet" });
    expect(await idsOf(3)).toHaveLength(5);
  });

  test("a CLI or MCP publish keeps the lasting ids of blocks that still match", async () => {
    const before = await idsOf(3);
    // v3: [Another line, A new first line, Pricing, One, Two]
    expect((await article("# Pricing\n\nOne. And more.\n\nTwo.\n\nThree.\n")).result.isError).toBeFalsy();
    const after = await idsOf(4);
    expect(after).toHaveLength(4);
    expect(after.slice(0, 3)).toEqual(before.slice(2, 5));
    expect(before).not.toContain(after[3] as string);
    const keys = await t.server.db
      .select({ key: blocks.blockKey })
      .from(blocks)
      .where(eq(blocks.versionId, (await version(4))?.id as string))
      .orderBy(blocks.id);
    expect(keys.map((row) => row.key)).toEqual(after);
    // The next draft seeds from those ids, so the editor's blocks keep them.
    const draft = await json<{ blockIds: string[] }>(
      await t.api(`/api/artifacts/${id}/doc/draft`, { cookie: owner }),
    );
    expect(draft.blockIds).toEqual(after);
  });

  test("a restore over a live draft is refused, and over a dirty one saves a handoff first", async () => {
    await insert("Unsaved.");
    await t.server.db.insert(editPresence).values({
      artifactId: id,
      connectionId: "c1",
      orgId,
      personId: (await version(1))?.publishedBy as string,
      mode: "pair",
      replica: "test",
      seenAt: t.clock.now(),
    });
    const restore = () => t.api(`/api/artifacts/${id}/versions/1/restore`, { method: "POST", cookie: owner });
    const refused = await restore();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { details: { reason: "live_draft" } } });
    await t.server.db.delete(editPresence);
    expect((await restore()).status).toBe(200);
    expect(await version(5)).toMatchObject({ checkpoint: "handoff" });
    expect(await version(6)).toMatchObject({ checkpoint: null, restoredFrom: 1 });
  });

  test("an organization token's fix is replied to as the person who made the token", async () => {
    const made = await orgToken(t, owner, { scopes: ["read", "comment", "edit"] });
    const thread = await json<{ n: number }>(
      await t.api(`/api/artifacts/${id}/threads`, {
        method: "POST",
        cookie: owner,
        json: { pageKey: "doc", anchor: null, body: "Fix the intro.", version: 6 },
      }),
    );
    const done = await json<{ results: { outcome: string }[]; version: number | null }>(
      await t.api(`/api/artifacts/${id}/doc/ops`, {
        method: "POST",
        bearer: made.token,
        json: {
          ops: [{ op: "insert", after: null, markdown: "Fixed intro." }],
          fixes: [thread.n],
          checkpoint: true,
        },
      }),
    );
    expect(done.results[0]?.outcome).toBe("applied");
    const [row] = await t.server.db
      .select({ status: threads.status, id: threads.id })
      .from(threads)
      .where(and(eq(threads.artifactId, id), eq(threads.n, thread.n)));
    expect(row?.status).toBe("fixed");
    const [reply] = await t.server.db
      .select({ author: comments.authorPersonId, marksFixed: comments.marksFixed })
      .from(comments)
      .where(and(eq(comments.threadId, row?.id as string), eq(comments.marksFixed, true)));
    const [me] = await t.server.db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.email, OWNER.email));
    expect(reply?.author).toBe(me?.id);
  });

  test("a draft that can't be saved refuses a restore, discardDraft drops it and logs the loss, and the sweep backs off", async () => {
    await insert("Will be lost.");
    // A source that isn't in the wiki fails the checkpoint's source check (step 4).
    await t.server.db
      .update(editDocs)
      .set({ meta: { sources: ["no-such-source"] } })
      .where(eq(editDocs.artifactId, id));
    t.clock.advance(EDIT_QUIET_MS + 1000);
    const first = await sweepDrafts(t.server.deps);
    expect(first.checkpoints).toBe(0);
    const [held] = await t.server.db
      .select({ meta: editDocs.meta })
      .from(editDocs)
      .where(eq(editDocs.artifactId, id));
    expect(held?.meta?.sweep?.attempts).toBe(1);
    // Within its back-off it isn't tried again; after it, it is, and waits longer.
    expect((await sweepDrafts(t.server.deps)).checked).toBe(0);
    t.clock.advance(31_000);
    expect((await sweepDrafts(t.server.deps)).checked).toBe(1);
    const [again] = await t.server.db
      .select({ meta: editDocs.meta })
      .from(editDocs)
      .where(eq(editDocs.artifactId, id));
    expect(again?.meta?.sweep?.attempts).toBe(2);

    const latest = async () =>
      (
        await t.server.db.select({ n: artifacts.latestVersion }).from(artifacts).where(eq(artifacts.id, id))
      )[0]?.n;
    const before = await latest();
    const refused = await t.api(`/api/artifacts/${id}/versions/1/restore`, { method: "POST", cookie: owner });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { details: { reason: "draft_invalid" } } });
    expect(await latest()).toBe(before);
    const forced = await t.api(`/api/artifacts/${id}/versions/1/restore?discardDraft=1`, {
      method: "POST",
      cookie: owner,
    });
    expect(forced.status).toBe(200);
    expect(await latest()).toBe((before as number) + 1);
    const edited = await t.server.db
      .select({ payload: activity.payload })
      .from(activity)
      .where(and(eq(activity.artifactId, id), eq(activity.kind, "edited")));
    expect(edited.map((row) => row.payload)).toContainEqual(expect.objectContaining({ discarded: true }));
    const [draft] = await t.server.db.select().from(editDocs).where(eq(editDocs.artifactId, id));
    expect(draft?.snapshot.length).toBe(0);
  });
});
