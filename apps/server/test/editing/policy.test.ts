import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI_SCOPES, RUN_MAX_MS } from "@artifacts/schema";
import { eq } from "drizzle-orm";
import { findArtifact, type LoadedArtifact } from "../../src/auth/access.ts";
import type { Caller } from "../../src/auth/caller.ts";
import {
  artifactAccess,
  artifacts,
  editPresence,
  editRuns,
  people,
  shareLinks,
  versions,
} from "../../src/db/schema.ts";
import { agentPolicy } from "../../src/editing/policy.ts";
import { claim, mcp, OWNER, startTestServer, type TestServer } from "../helpers.ts";
import { makePerson } from "../publish-helper.ts";

/** 13, "Policy: direct or suggestion", every row in order: who may edit, who is present, runs, audience. */
describe("agentPolicy", () => {
  let t: TestServer;
  let orgId: string;
  let owner: { id: string; name: string; email: string };
  let team: string;
  let mine: string;
  let other: Awaited<ReturnType<typeof makePerson>>;

  const tokenFor = (
    person: { id: string; name: string; email: string },
    scopes = [...CLI_SCOPES],
  ): Caller => ({
    kind: "cliToken",
    person: { ...person, role: "owner" },
    tokenId: Bun.randomUUIDv7(),
    scopes,
  });
  const load = async (id: string) => (await findArtifact(t.server.deps, orgId, id)) as LoadedArtifact;
  const policy = async (caller: Caller, id: string, options: { run?: string; suggest?: boolean } = {}) => {
    const { held, ...rest } = await agentPolicy(t.server.deps, caller, await load(id), options);
    return { edits: rest.edits, reason: rest.reason, held };
  };
  const present = (artifactId: string, mode: "write" | "pair" | "delegate", blocks: string[] = []) =>
    t.server.db.insert(editPresence).values({
      artifactId,
      connectionId: Bun.randomUUIDv7(),
      orgId,
      personId: other.id,
      mode,
      blocks,
      replica: "test",
      seenAt: t.clock.now(),
    });
  const publish = async (token: string, project: string, slug: string) => {
    await mcp(t, token, "tools/call", {
      name: "artifacts_publish_article",
      arguments: { project, slug, title: slug, summary: "A page.", markdown: "# Page\n\nText.\n" },
    });
    const [row] = await t.server.db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.slug, slug))
      .limit(1);
    return row?.id as string;
  };

  beforeAll(async () => {
    t = await startTestServer();
    const claimed = await claim(t);
    orgId = claimed.orgId;
    const [me] = await t.server.db.select().from(people).where(eq(people.email, OWNER.email));
    owner = { id: me?.id as string, name: me?.name as string, email: OWNER.email };
    const api = (json: object) => t.api("/api/wikis", { method: "POST", bearer: claimed.token, json });
    await api({ slug: "team", name: "Team" });
    await api({ slug: "mine", name: "Mine", onlyMe: true });
    team = await publish(claimed.token, "team", "pricing");
    mine = await publish(claimed.token, "mine", "notes");
    other = await makePerson(t, orgId, "member");
    expect(await t.server.db.select().from(versions)).toHaveLength(2);
  });
  afterAll(() => t.stop());

  const clear = async () => {
    await t.server.db.delete(editPresence);
    await t.server.db.delete(editRuns);
    await t.server.db.update(artifacts).set({ agentMaintained: false });
  };

  test("1. without the edit right or scope: refused", async () => {
    await clear();
    expect(
      await policy(tokenFor(owner, ["publish", "comment", "read", "manage", "data"]), team),
    ).toMatchObject({
      edits: "refused",
      reason: "no_edit",
    });
  });

  test("5. by audience: the one reader direct, a shared wiki suggestions, maintained direct, suggest wins", async () => {
    await clear();
    expect(await policy(tokenFor(owner), mine)).toMatchObject({ edits: "direct", reason: "only_reader" });
    expect(await policy(tokenFor(owner), team)).toMatchObject({ edits: "suggestion", reason: "audience" });
    await t.server.db.update(artifacts).set({ agentMaintained: true }).where(eq(artifacts.id, team));
    expect(await policy(tokenFor(owner), team)).toMatchObject({ edits: "direct", reason: "maintained" });
    expect(await policy(tokenFor(owner), team, { suggest: true })).toMatchObject({
      edits: "suggestion",
      reason: "maintained",
    });
    expect(await policy(tokenFor(owner), mine, { suggest: true })).toMatchObject({ edits: "suggestion" });
  });

  test("2 and 3. someone writing keeps agents out; someone pairing makes suggestions; Delegate doesn't hold back", async () => {
    await clear();
    await t.server.db.update(artifacts).set({ agentMaintained: true }).where(eq(artifacts.id, team));
    await present(team, "delegate");
    expect(await policy(tokenFor(owner), team)).toMatchObject({ edits: "direct", reason: "maintained" });
    await present(team, "pair", ["~aaaaaaaaa1"]);
    const paired = await policy(tokenFor(owner), team);
    expect(paired).toMatchObject({ edits: "suggestion", reason: "pair" });
    await present(team, "write");
    expect(await policy(tokenFor(owner), team)).toMatchObject({ edits: "refused", reason: "writing" });
    // A stale row is nobody.
    await clear();
    await present(team, "write");
    t.clock.advance(60_000);
    expect((await policy(tokenFor(owner), team)).reason).toBe("audience");
  });

  test("held: a person's caret or unsent changes hold a block", async () => {
    await clear();
    await present(mine, "delegate", ["~aaaaaaaaa1", "~aaaaaaaaa2"]);
    const { edits, held } = await policy(tokenFor(owner), mine);
    expect(edits).toBe("direct");
    expect([held("~aaaaaaaaa1"), held("~aaaaaaaaa2"), held("~aaaaaaaaa3")]).toEqual([true, true, false]);
  });

  test("4. a named active run decides, only for its own caller", async () => {
    await clear();
    const run = async (artifactId: string, edits: "direct" | "suggestion", startedBy = owner.id) => {
      const id = Bun.randomUUIDv7();
      await t.server.db.insert(editRuns).values({
        id,
        orgId,
        artifactId,
        status: "active",
        edits,
        goal: "Tidy",
        agent: "Claude Code",
        startedBy,
        startedAt: t.clock.now(),
        expiresAt: new Date(t.clock.now().getTime() + RUN_MAX_MS),
      });
      return id;
    };
    const suggesting = await run(team, "suggestion");
    expect(await policy(tokenFor(owner), team, { run: suggesting })).toMatchObject({
      edits: "suggestion",
      reason: "run",
    });
    const direct = await run(mine, "direct");
    expect(await policy(tokenFor(owner), mine, { run: direct })).toMatchObject({
      edits: "direct",
      reason: "run",
    });
    // Someone else's run, or one on another page, is ignored: the audience decides.
    const theirs = await run(team, "direct", other.id);
    expect(await policy(tokenFor(owner), team, { run: theirs })).toMatchObject({ reason: "audience" });
    expect(await policy(tokenFor(owner), team, { run: direct })).toMatchObject({ reason: "audience" });
    // Pair still beats a run.
    await present(team, "pair");
    expect(await policy(tokenFor(owner), team, { run: suggesting })).toMatchObject({ reason: "pair" });
  });

  test("an only-me page shared on its own, by a grant or a live link, counts as others reading", async () => {
    await clear();
    expect((await policy(tokenFor(owner), mine)).reason).toBe("only_reader");
    await t.server.db
      .insert(artifactAccess)
      .values({ orgId, artifactId: mine, personId: other.id, permission: "view", grantedBy: owner.id });
    expect(await policy(tokenFor(owner), mine)).toMatchObject({ edits: "suggestion", reason: "audience" });
    await t.server.db.delete(artifactAccess).where(eq(artifactAccess.artifactId, mine));
    const link = Bun.randomUUIDv7();
    await t.server.db.insert(shareLinks).values({
      id: link,
      orgId,
      artifactId: mine,
      tokenHash: link,
      permission: "view",
      createdBy: owner.id,
    });
    expect((await policy(tokenFor(owner), mine)).reason).toBe("audience");
    await t.server.db.update(shareLinks).set({ revokedAt: t.clock.now() }).where(eq(shareLinks.id, link));
    expect((await policy(tokenFor(owner), mine)).reason).toBe("only_reader");
  });

  test("a person in a browser edits directly, even with someone writing; their agents are refused", async () => {
    await clear();
    await present(team, "write");
    const session: Caller = {
      kind: "person",
      person: { ...owner, role: "owner" },
      sessionId: "s",
      recentAuth: true,
    };
    expect(await policy(session, team)).toMatchObject({ edits: "direct", reason: "person" });
    const { held: _held, ...forAgents } = await agentPolicy(t.server.deps, session, await load(team), {
      forAgents: true,
    });
    expect(forAgents).toMatchObject({ edits: "refused", reason: "writing" });
  });
});
