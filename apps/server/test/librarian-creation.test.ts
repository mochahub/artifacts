import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { findArtifact } from "../src/auth/access.ts";
import { can } from "../src/auth/can.ts";
import {
  artifacts,
  librarianConfig,
  librarianInbox,
  librarianKeys,
  librarianProposals,
  librarianReceipts,
  librarianRuns,
  librarianWikis,
  people,
  projects,
  tokens,
  versions,
} from "../src/db/schema.ts";
import { applyOps, pageRead } from "../src/editing/ops.ts";
import { claimRun } from "../src/librarian/budget.ts";
import { createContentTools } from "../src/librarian/content-tools.ts";
import { createReviewedProposal } from "../src/librarian/creation.ts";
import {
  enqueueSource,
  extractSource,
  promoteSource,
  type Submission,
} from "../src/librarian/ingestion/index.ts";
import { encryptProviderKey } from "../src/librarian/keys.ts";
import { locked } from "../src/librarian/leases.ts";
import { claim, OWNER, signIn, startTestServer } from "./helpers.ts";

test("concrete source promotion and reviewed creation: atomic receipt, rollback, storage failure, replay and citation boundaries", async () => {
  const t = await startTestServer({ LIBRARIAN_ALLOWED: "true" });
  try {
    const setup = await claim(t),
      cookie = await signIn(t, OWNER.email, OWNER.password);
    const deps = t.server.deps,
      db = deps.db;
    await t.api("/api/wikis", { cookie, method: "POST", json: { slug: "creation", name: "Creation" } });
    const [wiki] = await db.select().from(projects).where(eq(projects.slug, "creation"));
    const [person] = await db.select().from(people).where(eq(people.email, OWNER.email));
    if (!wiki || !person) throw Error("fixture missing");
    const input: Submission = {
      orgId: setup.orgId,
      wikiId: wiki.id,
      caller: { kind: "person", person, sessionId: crypto.randomUUID(), recentAuth: true },
    };
    const tokenId = crypto.randomUUID();
    await db.insert(tokens).values({
      id: tokenId,
      orgId: setup.orgId,
      kind: "org",
      name: "Fixture",
      tokenHash: "synthetic",
      scopes: ["read", "comment", "edit", "publish"],
      projectIds: [wiki.id],
      createdBy: person.id,
    });
    await db.insert(librarianWikis).values({ orgId: setup.orgId, projectId: wiki.id });
    await db.insert(librarianConfig).values({
      orgId: setup.orgId,
      enabled: true,
      generation: 1,
      tokenId,
      monthlyLimit: 1000n,
      runLimit: 100n,
      rateCard: { input: "1", output: "1" },
    });
    await db.insert(librarianKeys).values({
      orgId: setup.orgId,
      generation: 1,
      envelope: encryptProviderKey(Buffer.from("synthetic"), setup.orgId, 1, {
        active: "fixture",
        keys: new Map([["fixture", randomBytes(32)]]),
      }),
    });
    const item = await enqueueSource(deps, input, {
      idempotencyKey: crypto.randomUUID(),
      source: { kind: "text", title: "Source", text: "<untrusted> data" },
    });
    const fence = await claimRun(deps, {
      orgId: setup.orgId,
      wikiId: wiki.id,
      owner: crypto.randomUUID(),
    });
    if (!fence) throw Error("no fence");
    await db
      .update(librarianInbox)
      .set({ runId: fence.runId, status: "running" })
      .where(eq(librarianInbox.id, item.item.id));
    const extracted = await extractSource(deps, input, item.item.id, fence, async () => "<untrusted> data");
    const sources = await Promise.all(
      [1, 2].map(() => promoteSource(deps, input, item.item.id, fence, extracted)),
    );
    expect(sources[0]).toBe(sources[1]);
    const [source] = await db.select().from(artifacts).where(eq(artifacts.id, sources[0]!));
    expect(source?.archivedAt).toBeTruthy();
    expect((await t.api(`/api/artifacts/${sources[0]}/unarchive`, { cookie, method: "POST" })).status).toBe(
      403,
    );
    const [v] = await db.select().from(versions).where(eq(versions.artifactId, sources[0]!));
    expect(v?.wiki).toMatchObject({ role: "source", untrusted: true });
    expect(v?.files.original).toBeTruthy();
    expect(v?.files["__librarian_source.json"]).toBeTruthy();
    const [promoted] = await db.select().from(librarianInbox).where(eq(librarianInbox.id, item.item.id));
    expect(promoted?.input).toBeNull();
    const tools = createContentTools(deps);
    const sourceRead = await db.transaction((tx) =>
      tools.tool(
        tx,
        fence,
        wiki.id,
        "source_read",
        { page: sources[0]! },
        { id: crypto.randomUUID(), inputHash: "0".repeat(64) },
        60000,
      ),
    );
    expect(JSON.stringify(sourceRead)).toContain("untrusted");
    await db.transaction((tx) =>
      tools.authorizeTool(tx, fence, wiki.id, "propose_page", {
        title: "Proposal",
        summary: "Review",
        markdown: "Read",
        sources: [sources[0]!],
      }),
    );
    const outsider = {
      kind: "person" as const,
      person: { ...person, id: crypto.randomUUID(), role: "outside" as const },
      sessionId: "fixture",
      recentAuth: false,
    };
    expect(can(outsider, "artifact.read", (await findArtifact(deps, setup.orgId, sources[0]!))!)).toBe(false);
    // A completed inbox remains a deduplication candidate.
    await db.update(librarianInbox).set({ status: "done" }).where(eq(librarianInbox.id, item.item.id));
    const duplicate = await enqueueSource(deps, input, {
      idempotencyKey: crypto.randomUUID(),
      source: { kind: "text", title: "Repeat", text: "<untrusted> data" },
    });
    await db
      .update(librarianInbox)
      .set({ runId: fence.runId })
      .where(eq(librarianInbox.id, duplicate.item.id));
    const duplicateText = await extractSource(
      deps,
      input,
      duplicate.item.id,
      fence,
      async () => "<untrusted> data",
    );
    expect(await promoteSource(deps, input, duplicate.item.id, fence, duplicateText)).toBe(sources[0]!);
    await db
      .update(librarianInbox)
      .set({ status: "waiting_human" })
      .where(eq(librarianInbox.id, item.item.id));
    const waitingDuplicate = await enqueueSource(deps, input, {
      idempotencyKey: crypto.randomUUID(),
      source: { kind: "text", title: "Waiting repeat", text: "<untrusted> data" },
    });
    await db
      .update(librarianInbox)
      .set({ runId: fence.runId })
      .where(eq(librarianInbox.id, waitingDuplicate.item.id));
    const waitingText = await extractSource(
      deps,
      input,
      waitingDuplicate.item.id,
      fence,
      async () => "<untrusted> data",
    );
    expect(await promoteSource(deps, input, waitingDuplicate.item.id, fence, waitingText)).toBe(sources[0]!);
    const personItem = await enqueueSource(deps, input, {
      idempotencyKey: crypto.randomUUID(),
      source: { kind: "text", title: "Person authority", text: "person bytes" },
    });
    await db
      .update(librarianInbox)
      .set({ runId: fence.runId })
      .where(eq(librarianInbox.id, personItem.item.id));
    const personText = await extractSource(
      deps,
      input,
      personItem.item.id,
      fence,
      async () => "person bytes",
    );
    await db.update(people).set({ role: "outside" }).where(eq(people.id, person.id));
    await expect(promoteSource(deps, input, personItem.item.id, fence, personText)).rejects.toThrow(
      "Not found",
    );
    const [personDenied] = await db
      .select()
      .from(librarianInbox)
      .where(eq(librarianInbox.id, personItem.item.id));
    expect(personDenied?.sourceArtifactId).toBeNull();
    await db.update(people).set({ role: person.role }).where(eq(people.id, person.id));
    // Originating CLI credential survives enqueue and is reloaded after extraction.
    const cliId = crypto.randomUUID();
    await db.insert(tokens).values({
      id: cliId,
      orgId: setup.orgId,
      kind: "cli",
      personId: person.id,
      createdBy: person.id,
      name: "CLI",
      tokenHash: cliId,
      scopes: ["read", "publish"],
    });
    const cliInput: Submission = {
      ...input,
      caller: { kind: "cliToken", person, tokenId: cliId, scopes: ["read", "publish"] },
    };
    const cliItem = await enqueueSource(deps, cliInput, {
      idempotencyKey: crypto.randomUUID(),
      source: { kind: "text", title: "CLI", text: "cli bytes" },
    });
    await db.update(librarianInbox).set({ runId: fence.runId }).where(eq(librarianInbox.id, cliItem.item.id));
    const cliText = await extractSource(deps, cliInput, cliItem.item.id, fence, async () => "cli bytes");
    await db.update(tokens).set({ revokedAt: deps.clock.now() }).where(eq(tokens.id, cliId));
    await expect(promoteSource(deps, input, cliItem.item.id, fence, cliText)).rejects.toThrow("Not found");
    const [denied] = await db.select().from(librarianInbox).where(eq(librarianInbox.id, cliItem.item.id));
    expect(denied?.sourceArtifactId).toBeNull();
    await db.update(tokens).set({ revokedAt: null }).where(eq(tokens.id, cliId));
    await db
      .update(tokens)
      .set({ scopes: ["read"] })
      .where(eq(tokens.id, cliId));
    await expect(promoteSource(deps, input, cliItem.item.id, fence, cliText)).rejects.toThrow("Not found");
    await db
      .update(tokens)
      .set({ scopes: ["read", "publish"] })
      .where(eq(tokens.id, cliId));
    await db.update(people).set({ role: "outside" }).where(eq(people.id, person.id));
    await expect(promoteSource(deps, input, cliItem.item.id, fence, cliText)).rejects.toThrow("Not found");
    await db.update(people).set({ role: person.role }).where(eq(people.id, person.id));
    const cliSource = await promoteSource(deps, cliInput, cliItem.item.id, fence, cliText);
    expect(
      JSON.stringify(
        await db.transaction((tx) =>
          tools.tool(
            tx,
            fence,
            wiki.id,
            "source_read",
            { page: cliSource },
            { id: crypto.randomUUID(), inputHash: "0".repeat(64) },
            60000,
          ),
        ),
      ),
    ).toContain("cli bytes");
    await db.transaction((tx) =>
      tools.authorizeTool(tx, fence, wiki.id, "propose_page", {
        title: "CLI citation",
        summary: "Review",
        markdown: "Read",
        sources: [cliSource],
      }),
    );
    const proposalId = crypto.randomUUID();
    await db.insert(librarianProposals).values({
      id: proposalId,
      orgId: setup.orgId,
      wikiId: wiki.id,
      runId: fence.runId,
      proposalKey: crypto.randomUUID(),
      title: "Article",
      summary: "Review",
      markdown: "hello <script>bad()</script>",
      sources: [sources[0]!],
    });
    const review = {
      orgId: setup.orgId,
      wikiId: wiki.id,
      proposalId,
      caller: input.caller,
      requestId: crypto.randomUUID(),
    };
    const badStorage = {
      ...deps,
      bucket: Object.assign(Object.create(deps.bucket), {
        get: async () => {
          throw Error("storage failed");
        },
      }),
    };
    await expect(createReviewedProposal(badStorage, review)).rejects.toThrow("storage failed");
    expect(await db.select().from(librarianReceipts)).toHaveLength(0);
    // A failure after article/version insertion must roll those rows back with review and receipt.
    await db.execute(
      sql`CREATE FUNCTION fail_review_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'review rollback fixture'; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER fail_review_fixture BEFORE UPDATE ON librarian_proposals FOR EACH ROW EXECUTE FUNCTION fail_review_fixture()`,
    );
    await expect(createReviewedProposal(deps, review)).rejects.toThrow();
    expect(
      await db
        .select()
        .from(artifacts)
        .where(eq(artifacts.slug, `prop-${proposalId.replaceAll("-", "")}`)),
    ).toHaveLength(0);
    expect(await db.select().from(librarianReceipts)).toHaveLength(0);
    await db.execute(sql`DROP TRIGGER fail_review_fixture ON librarian_proposals`);
    const collisionId = crypto.randomUUID();
    await db.insert(artifacts).values({
      id: collisionId,
      orgId: setup.orgId,
      projectId: wiki.id,
      slug: `prop-${proposalId.replaceAll("-", "")}`,
      title: "Existing",
      publisherId: person.id,
      visibility: "me",
    });
    await expect(createReviewedProposal(deps, review)).rejects.toThrow("That slug is taken");
    expect(await db.select().from(librarianReceipts)).toHaveLength(0);
    const [untouched] = await db.select().from(artifacts).where(eq(artifacts.id, collisionId));
    expect(untouched?.title).toBe("Existing");
    await db.delete(artifacts).where(eq(artifacts.id, collisionId));
    const results = await Promise.all([
      createReviewedProposal(deps, review),
      createReviewedProposal(deps, review),
    ]);
    expect(results[0].artifactId).toBe(results[1].artifactId);
    const [created] = await db.select().from(artifacts).where(eq(artifacts.id, results[0].artifactId!));
    expect(created?.slug).toBe(`prop-${proposalId.replaceAll("-", "")}`);
    expect(created?.slug.length).toBeLessThanOrEqual(40);
    const [createdVersion] = await db
      .select()
      .from(versions)
      .where(eq(versions.artifactId, results[0].artifactId!));
    expect(createdVersion?.wiki?.sources).toEqual([source!.slug]);
    expect(createdVersion?.files["artifact.json"]).toBeTruthy();
    expect(createdVersion?.files["index.md"]).toBeTruthy();
    const editable = (await findArtifact(deps, setup.orgId, created!.id))!;
    const read = await pageRead(deps, input.caller, editable, { draft: true });
    expect(read.blocks.length).toBeGreaterThan(0);
    await applyOps(deps, input.caller, editable, {
      ops: [{ op: "insert", after: null, markdown: "Edited after review." }],
      checkpoint: true,
    });

    expect(results.filter((r) => r.replay)).toHaveLength(1);
    expect(await db.select().from(librarianReceipts)).toHaveLength(1);
    const [other] = await db
      .insert(projects)
      .values({
        id: crypto.randomUUID(),
        orgId: setup.orgId,
        slug: "other-creation",
        name: "Other",
        kind: "wiki",
      })
      .returning();
    await expect(createReviewedProposal(deps, { ...review, wikiId: other!.id })).rejects.toThrow("Not found");
    // Same-wiki hidden citation cannot be disclosed on receipt replay.
    const otherPerson = crypto.randomUUID();
    await db.insert(people).values({
      id: otherPerson,
      orgId: setup.orgId,
      email: "other@creation.test",
      name: "Other",
      role: "member",
    });
    await db
      .update(artifacts)
      .set({ publisherId: otherPerson, visibility: "me" })
      .where(eq(artifacts.id, sources[0]!));
    await db.update(people).set({ role: "member" }).where(eq(people.id, person.id));
    const memberCaller = {
      sessionId: crypto.randomUUID(),
      recentAuth: true,
      kind: "person" as const,
      person: { ...person, role: "member" as const },
    };
    await expect(createReviewedProposal(deps, { ...review, caller: memberCaller })).rejects.toThrow(
      "Not found",
    );
    const memberInput = { ...input, caller: memberCaller };
    const second = await enqueueSource(deps, memberInput, {
      idempotencyKey: crypto.randomUUID(),
      source: { kind: "text", title: "Same bytes", text: "<untrusted> data" },
    });
    await db.update(librarianInbox).set({ runId: fence.runId }).where(eq(librarianInbox.id, second.item.id));
    const secondExtraction = await extractSource(
      deps,
      memberInput,
      second.item.id,
      fence,
      async () => "<untrusted> data",
    );
    const separate = await promoteSource(deps, memberInput, second.item.id, fence, secondExtraction);
    expect(separate).not.toBe(sources[0]);
    // Cancellation must reload after the scheduler's org transaction, including a newly bound run.
    const pending = await enqueueSource(deps, memberInput, {
      idempotencyKey: crypto.randomUUID(),
      source: { kind: "text", title: "Cancel race", text: "cancel" },
    });
    let cancel: ReturnType<typeof t.api> | undefined;
    await locked(deps, setup.orgId, async (tx) => {
      cancel = t.api(`/api/wikis/creation/inbox/${pending.item.id}/cancel`, { cookie, method: "POST" });
      await Bun.sleep(100);
      await tx
        .update(librarianInbox)
        .set({ runId: fence.runId, status: "running" })
        .where(eq(librarianInbox.id, pending.item.id));
    });
    expect((await cancel)?.status).toBe(200);
    const [cancelledRun] = await db.select().from(librarianRuns).where(eq(librarianRuns.id, fence.runId));
    expect(cancelledRun?.state).toBe("cancelled");
    const [cancelledInbox] = await db
      .select()
      .from(librarianInbox)
      .where(eq(librarianInbox.id, pending.item.id));
    expect(cancelledInbox?.status).toBe("cancelled");
    const deniedToken = {
      ...input,
      caller: {
        kind: "orgToken" as const,
        tokenId,
        createdBy: person.id,
        scopes: ["publish" as const],
        projectIds: null,
      },
    };
    const { createImmutableSource } = await import("../src/librarian/creation.ts");
    await expect(createImmutableSource(deps, deniedToken, secondExtraction, second.item.id)).rejects.toThrow(
      "Not found",
    );
  } finally {
    await t.stop();
  }
});
