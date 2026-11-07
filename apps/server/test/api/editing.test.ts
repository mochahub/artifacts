import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI_SCOPES, DocState, EDITING_FEATURE, FEATURES_HEADER, WikiSpace } from "@artifacts/schema";
import { and, eq } from "drizzle-orm";
import {
  artifactAccess,
  blockAliases,
  editDocs,
  editPresence,
  tokens,
  versions,
} from "../../src/db/schema.ts";
import { downgrade } from "../../src/http/compat.ts";
import { claim, json, mcp, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { makeAccount, makePerson } from "../publish-helper.ts";

/** 13, "HTTP API": the editing routes, what they leak to whom, checkpoints and the live-draft rule. */
describe("editing wiki pages", () => {
  let t: TestServer;
  let token: string;
  let orgId: string;
  let owner: string;
  let id: string;
  let editor: Awaited<ReturnType<typeof makeAccount>>;
  let reader: Awaited<ReturnType<typeof makeAccount>>;
  let outsider: Awaited<ReturnType<typeof makeAccount>>;

  const article = (markdown: string, slug = "pricing") =>
    mcp(t, token, "tools/call", {
      name: "artifacts_publish_article",
      arguments: { project: "brain", slug, title: slug, summary: "How we price.", markdown },
    }).then(async (r) => (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } });
  const doc = async (cookie: string) =>
    DocState.parse(await json(await t.api(`/api/artifacts/${id}/doc`, { cookie })));
  const ops = (body: object) =>
    t.api(`/api/artifacts/${id}/doc/ops`, {
      method: "POST",
      bearer: token,
      json: { agent: "Claude Code", ...body },
    });

  beforeAll(async () => {
    t = await startTestServer();
    ({ token, orgId } = await claim(t));
    owner = await signIn(t, OWNER.email, OWNER.password);
    // Tokens made before `edit` existed lack it; this one is a fresh sign-in's.
    await t.server.db.update(tokens).set({ scopes: [...CLI_SCOPES] });
    expect(
      (await t.api("/api/wikis", { method: "POST", bearer: token, json: { slug: "brain", name: "Brain" } }))
        .status,
    ).toBe(201);
    expect((await article("# Pricing\n\nOne.\n\nTwo.\n")).result.isError).toBeFalsy();
    const [row] = await t.server.db.select({ id: versions.artifactId }).from(versions).limit(1);
    id = row?.id as string;
    editor = await makeAccount(t, orgId, "member");
    reader = await makeAccount(t, orgId, "member");
    outsider = await makeAccount(t, orgId, "outside");
    await t.server.db.insert(artifactAccess).values({
      orgId,
      artifactId: id,
      personId: editor.id,
      permission: "edit",
      grantedBy: editor.id,
    });
  });
  afterAll(() => t.stop());

  test("someone who can't edit learns only what readers know", async () => {
    const state = await doc(reader.cookie);
    expect(state).toMatchObject({
      editable: true,
      canEdit: false,
      canAccept: false,
      dirty: false,
      present: [],
      openSuggestions: 0,
      runs: [],
      audience: null,
      agents: null,
    });
    expect((await t.api(`/api/artifacts/${id}/doc/draft`, { cookie: reader.cookie })).status).toBe(403);
    expect((await t.api(`/api/artifacts/${id}/suggestions`, { cookie: reader.cookie })).status).toBe(403);
    expect((await t.api(`/api/artifacts/${id}/doc/markdown?draft=1`, { cookie: reader.cookie })).status).toBe(
      403,
    );
    // Hidden is not found, on every route, the same as an id that doesn't exist.
    expect((await t.api(`/api/artifacts/${id}/doc`, { cookie: outsider.cookie })).status).toBe(404);
    expect((await t.api(`/api/artifacts/${id}/doc/draft`, { cookie: outsider.cookie })).status).toBe(404);
    expect((await t.api(`/api/artifacts/${Bun.randomUUIDv7()}/doc`, { cookie: reader.cookie })).status).toBe(
      404,
    );
  });

  test("an editor sees the draft, seeded with lasting ids and aliases for the legacy keys", async () => {
    const state = await doc(editor.cookie);
    expect(state).toMatchObject({ canEdit: true, canAccept: true, canMaintain: false });
    expect(state.agents?.edits).toBe("suggestion");
    const draft = await t.api(`/api/artifacts/${id}/doc/draft`, { cookie: editor.cookie });
    expect(draft.status).toBe(200);
    const view = (await draft.json()) as { blockIds: string[]; html: string };
    expect(view.blockIds).toHaveLength(3);
    expect(view.html).toContain(`data-block="${view.blockIds[0]}"`);
    const aliases = await t.server.db.select().from(blockAliases).where(eq(blockAliases.artifactId, id));
    expect(aliases.map((row) => row.legacyKey).sort()).toEqual(["pricing", "pricing/p1", "pricing/p2"]);
  });

  test("an editor's page reads give the same lasting ids each time; a reader's, the version's keys", async () => {
    const read = async (cookie: string, draft: boolean) =>
      json<{ blocks: { id: string }[] }>(
        await t.api(`/api/artifacts/${id}/doc/markdown${draft ? "?draft=1" : ""}`, { cookie }),
      );
    const first = (await read(editor.cookie, true)).blocks.map((block) => block.id);
    const again = (await read(editor.cookie, true)).blocks.map((block) => block.id);
    expect(first).toHaveLength(3);
    expect(again).toEqual(first);
    const aliases = await t.server.db.select().from(blockAliases).where(eq(blockAliases.artifactId, id));
    expect(aliases.map((row) => row.blockId).sort()).toEqual([...first].sort());
    const [draft] = await t.server.db.select().from(editDocs).where(eq(editDocs.artifactId, id));
    expect(draft?.epoch).toBe(1);
  });

  test("a checkpoint with nothing new makes no version", async () => {
    const r = await t.api(`/api/artifacts/${id}/doc/checkpoint`, {
      method: "POST",
      cookie: editor.cookie,
      json: {},
    });
    expect(await r.json()).toEqual({ version: 1, created: false, kind: null });
  });

  test("an owner marks a page agent-maintained; a token can't", async () => {
    const put = (auth: { cookie?: string; bearer?: string }) =>
      t.api(`/api/artifacts/${id}/doc/maintained`, {
        method: "PUT",
        ...auth,
        json: { agentMaintained: true },
      });
    expect((await put({ bearer: token })).status).toBe(403);
    expect((await put({ cookie: editor.cookie })).status).toBe(403);
    const r = await put({ cookie: owner });
    expect(r.status).toBe(200);
    expect(DocState.parse(await r.json()).agents?.edits).toBe("direct");
  });

  test("a direct op dirties the draft, and Save version makes a saved checkpoint", async () => {
    const r = await ops({ ops: [{ op: "insert", after: null, markdown: "A new first line." }] });
    expect(r.status).toBe(200);
    const result = (await r.json()) as { results: { outcome: string }[] };
    expect(result.results[0]?.outcome).toBe("applied");
    expect((await doc(editor.cookie)).dirty).toBe(true);
    // Readers still see the checkpoint, and nothing tells them someone is editing.
    expect((await doc(reader.cookie)).dirty).toBe(false);
    const saved = await t.api(`/api/artifacts/${id}/doc/checkpoint`, {
      method: "POST",
      cookie: editor.cookie,
      json: { name: "First edit" },
    });
    expect(await saved.json()).toEqual({ version: 2, created: true, kind: "saved" });
    const [v2] = await t.server.db
      .select()
      .from(versions)
      .where(and(eq(versions.artifactId, id), eq(versions.n, 2)));
    expect(v2).toMatchObject({ checkpoint: "saved", name: "First edit", publishedBy: editor.id });
    expect((await doc(editor.cookie)).dirty).toBe(false);
    const authors = await json<{ authors: { kind: string }[] }>(
      await t.api(`/api/artifacts/${id}/authors?version=2`, { cookie: reader.cookie }),
    );
    expect(authors.authors.map((a) => a.kind).sort()).toEqual(["agent", "agent"]);
  });

  test("a publish over a live draft is refused; over a dirty one it saves a handoff first", async () => {
    await ops({ ops: [{ op: "insert", after: null, markdown: "Another line." }] });
    await t.server.db.insert(editPresence).values({
      artifactId: id,
      connectionId: "c1",
      orgId,
      personId: editor.id,
      mode: "write",
      replica: "test",
      seenAt: t.clock.now(),
    });
    const refused = await article("# Pricing\n\nReplaced.\n");
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0]?.text).toContain("being edited");
    await t.server.db.delete(editPresence);
    expect((await article("# Pricing\n\nReplaced.\n")).result.isError).toBeFalsy();
    const rows = await t.server.db
      .select({ n: versions.n, checkpoint: versions.checkpoint })
      .from(versions)
      .where(eq(versions.artifactId, id))
      .orderBy(versions.n);
    expect(rows.slice(2)).toEqual([
      { n: 3, checkpoint: "handoff" },
      { n: 4, checkpoint: null },
    ]);
    const [draft] = await t.server.db.select().from(editDocs).where(eq(editDocs.artifactId, id));
    expect(draft).toMatchObject({ epoch: 2, version: 4 });
    expect(draft?.snapshot.length).toBe(0);
    // The next open seeds it again from v4, without the seq going back.
    const view = await json<{ html: string; seq: number }>(
      await t.api(`/api/artifacts/${id}/doc/draft`, { cookie: editor.cookie }),
    );
    expect(view.html).toContain("Replaced.");
    expect(view.seq).toBeGreaterThan(draft?.seq ?? 0);
  });

  test("a token can't grant edit", async () => {
    const r = await t.api(`/api/artifacts/${id}/access`, {
      method: "POST",
      bearer: token,
      json: { email: reader.email, permission: "edit" },
    });
    expect(r.status).toBe(403);
    // Nor through an invite: an unknown email would become an invite carrying it.
    const invite = await t.api(`/api/artifacts/${id}/access`, {
      method: "POST",
      bearer: token,
      json: { email: "new-person@example.com", permission: "edit" },
    });
    expect(invite.status).toBe(403);
    // A person can, for a member, and only for a member.
    const grant = (email: string) =>
      t.api(`/api/artifacts/${id}/access`, {
        method: "POST",
        cookie: owner,
        json: { email, permission: "edit" },
      });
    expect((await grant(reader.email)).status).toBeLessThan(300);
    expect((await grant(outsider.email)).status).toBe(400);
    expect((await grant("someone-new@example.com")).status).toBe(400);
    await t.server.db
      .delete(artifactAccess)
      .where(and(eq(artifactAccess.artifactId, id), eq(artifactAccess.personId, reader.id)));
  });

  test("an older CLI reads checkpointed as published and edit as comment", async () => {
    const older = await json(
      await t.api("/api/wikis/brain", { bearer: token, headers: { "Artifacts-CLI": "0.2.9" } }),
    );
    const log = (older as { log: { kind: string; slug: string | null; version: number | null }[] }).log;
    const kinds = log.map((entry) => entry.kind);
    expect(kinds).not.toContain("checkpointed");
    expect(kinds).not.toContain("maintained_changed");
    // The saved checkpoint, v2, reads as a publish.
    expect(log).toContainEqual(expect.objectContaining({ kind: "published", slug: "pricing", version: 2 }));
    const newer = await json(
      await t.api("/api/wikis/brain", {
        bearer: token,
        headers: { "Artifacts-CLI": "0.3.0", [FEATURES_HEADER]: EDITING_FEATURE },
      }),
    );
    expect(WikiSpace.safeParse(newer).success).toBe(true);
    expect((newer as { log: { kind: string }[] }).log.map((entry) => entry.kind)).toContain("checkpointed");
    expect(downgrade({ people: [{ permission: "edit" }], shared: [{ level: "edit" }] })).toEqual({
      people: [{ permission: "comment" }],
      shared: [{ level: "comment" }],
    });
  });

  test("suggestions and runs: made, listed, accepted, rejected, withdrawn and cancelled", async () => {
    expect((await article("# Plans\n\nFirst.\n", "plans")).result.isError).toBeFalsy();
    const [plans] = await t.server.db
      .select()
      .from(versions)
      .where(eq(versions.n, 1))
      .orderBy(versions.publishedAt);
    const rows = await t.server.db
      .select({ id: versions.artifactId })
      .from(versions)
      .where(eq(versions.n, 1));
    const page = rows.map((row) => row.id).find((other) => other !== id) as string;
    expect(plans).toBeDefined();
    await t.server.db
      .insert(artifactAccess)
      .values({ orgId, artifactId: page, personId: editor.id, permission: "edit", grantedBy: editor.id });
    const at = (path: string) => `/api/artifacts/${page}${path}`;
    const post = (path: string, auth: { cookie?: string; bearer?: string }, body: object = {}) =>
      t.api(path, { method: "POST", ...auth, json: body });
    const insert = (extra: object = {}) =>
      post(
        at("/doc/ops"),
        { bearer: token },
        {
          agent: "Claude Code",
          ops: [{ op: "insert", after: null, markdown: "Suggested line." }],
          ...extra,
        },
      ).then((r) => json<{ results: { outcome: string; suggestion: string | null }[] }>(r));

    // A suggestion run: its edits wait as one change set, and accepting it makes a delegate checkpoint.
    const started = await post(
      at("/doc/runs"),
      { bearer: token },
      { goal: "Tidy the plan", agent: "Claude Code" },
    );
    expect(started.status).toBe(201);
    const run = await json<{ id: string; edits: string }>(started);
    expect(run.edits).toBe("suggestion");
    expect((await post(at("/doc/runs"), { bearer: token }, { goal: "Again" })).status).toBe(409);
    expect((await insert({ run: run.id })).results[0]?.outcome).toBe("suggested");
    const listed = await json<{ suggestions: { run: string | null; status: string }[] }>(
      await t.api(at(`/suggestions?run=${run.id}`), { cookie: editor.cookie }),
    );
    expect(listed.suggestions).toMatchObject([{ run: run.id, status: "open" }]);
    expect((await post(`/api/runs/${run.id}/accept`, { bearer: token })).status).toBe(403);
    expect(
      await json(await post(`/api/runs/${run.id}/finish`, { bearer: token }, { message: "Done" })),
    ).toMatchObject({
      status: "finished",
    });
    const accepted = await json<{ status: string; version: number }>(
      await post(`/api/runs/${run.id}/accept`, { cookie: editor.cookie }),
    );
    expect(accepted.status).toBe("accepted");
    const [delegate] = await t.server.db
      .select({ checkpoint: versions.checkpoint, publishedBy: versions.publishedBy })
      .from(versions)
      .where(and(eq(versions.artifactId, page), eq(versions.n, accepted.version)));
    expect(delegate).toEqual({ checkpoint: "delegate", publishedBy: editor.id });
    // Decided once: a reject after the accept is a conflict, not a second decision.
    expect((await post(`/api/runs/${run.id}/reject`, { cookie: editor.cookie })).status).toBe(409);

    // One at a time: accept, reject and withdraw.
    const one = async () => (await insert({ suggest: true })).results[0]?.suggestion as string;
    const [a, b, c] = [await one(), await one(), await one()];
    expect((await post(`/api/suggestions/${a}/accept`, { bearer: token })).status).toBe(403);
    expect(await json(await post(`/api/suggestions/${a}/accept`, { cookie: editor.cookie }))).toMatchObject({
      status: "accepted",
    });
    expect(
      await json(await post(`/api/suggestions/${b}/reject`, { cookie: editor.cookie }, { note: "Not now" })),
    ).toMatchObject({ status: "rejected" });
    expect((await post(`/api/suggestions/${c}/withdraw`, { cookie: editor.cookie })).status).toBe(403);
    expect(await json(await post(`/api/suggestions/${c}/withdraw`, { bearer: token }))).toMatchObject({
      status: "withdrawn",
    });
    // Hidden from someone who can't see the page, as if it didn't exist.
    expect((await post(`/api/suggestions/${a}/reject`, { cookie: outsider.cookie })).status).toBe(404);

    // Runs a person stops, or rejects.
    const second = await json<{ id: string }>(
      await post(at("/doc/runs"), { bearer: token }, { goal: "Second" }),
    );
    // An agent at work shows in presence with the name of the person it's for, never an id.
    const state = DocState.parse(await json(await t.api(at("/doc"), { cookie: editor.cookie })));
    expect(state.present).toContainEqual(
      expect.objectContaining({ kind: "agent", run: second.id, for: OWNER.name }),
    );
    expect((await post(`/api/runs/${second.id}/cancel`, { cookie: reader.cookie })).status).toBe(403);
    expect(await json(await post(`/api/runs/${second.id}/cancel`, { cookie: editor.cookie }))).toMatchObject({
      status: "cancelled",
    });
    const third = await json<{ id: string }>(
      await post(at("/doc/runs"), { bearer: token }, { goal: "Third" }),
    );
    await insert({ run: third.id });
    expect(
      await json(await post(`/api/runs/${third.id}/reject`, { cookie: editor.cookie }, {})),
    ).toMatchObject({
      status: "rejected",
    });

    // Attribution of the draft, and the Markdown export of the draft and of a version.
    const authors = await json<{ draft: boolean; authors: unknown[] }>(
      await t.api(at("/authors?draft=1"), { cookie: editor.cookie }),
    );
    expect(authors.draft).toBe(true);
    expect((await t.api(at("/authors?draft=1"), { cookie: reader.cookie })).status).toBe(403);
    const exported = await t.api(at("/export.md?draft=1"), { cookie: editor.cookie });
    expect(exported.headers.get("content-type")).toContain("text/markdown");
    expect(await exported.text()).toContain("Suggested line.");
    expect(await (await t.api(at("/export.md?version=1"), { cookie: reader.cookie })).text()).toStartWith(
      '---\ntitle: "plans"',
    );
  });

  test("a token from before editing is told to sign in again", async () => {
    const person = await makePerson(t, orgId, "member");
    await t.server.db
      .insert(artifactAccess)
      .values({ orgId, artifactId: id, personId: person.id, permission: "edit", grantedBy: person.id });
    const r = await t.api(`/api/artifacts/${id}/doc/ops`, {
      method: "POST",
      bearer: person.token,
      json: { ops: [{ op: "insert", after: null, markdown: "x" }] },
    });
    expect(r.status).toBe(403);
    expect(await json(r)).toMatchObject({ error: { code: "forbidden", details: { scope: "edit" } } });
  });
});
