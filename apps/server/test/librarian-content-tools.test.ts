import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { connect } from "../src/db/index.ts";
import { runMigrations } from "../src/db/migrate.ts";
import {
  activity,
  artifacts,
  comments,
  editDocs,
  librarianConfig,
  librarianInbox,
  librarianKeys,
  librarianProposals,
  librarianWikis,
  org,
  pages,
  people,
  projects,
  suggestions,
  tokens,
  versions,
} from "../src/db/schema.ts";
import type { Deps } from "../src/deps.ts";
import { docToY, markdownToDoc, mintBlockId } from "../src/editing/model.ts";
import { claimRun } from "../src/librarian/budget.ts";
import { createContentTools } from "../src/librarian/content-tools.ts";
import { createUpload, enqueueSource, sha256 } from "../src/librarian/ingestion/index.ts";
import { createLibrarianJob } from "../src/librarian/integration.ts";
import { encryptProviderKey } from "../src/librarian/keys.ts";
import { cancelRun } from "../src/librarian/leases.ts";
import { prepareAndPersist, withToolReceipt } from "../src/librarian/runner/receipts.ts";
import { createDatabase, testClock, testEnv } from "./helpers.ts";

const orgId = crypto.randomUUID(),
  personId = crypto.randomUUID(),
  wikiId = crypto.randomUUID(),
  tokenId = crypto.randomUUID();
const ring = { active: "v1", keys: new Map([["v1", randomBytes(32)]]) };
let database: Awaited<ReturnType<typeof createDatabase>>, connection: ReturnType<typeof connect>, deps: Deps;
const clock = testClock(new Date("2026-01-31T23:59:00Z"));
beforeAll(async () => {
  database = await createDatabase();
  await runMigrations(database.url);
  connection = connect(database.url);
  deps = {
    db: connection.db,
    clock,
    env: testEnv(database.url, { LIBRARIAN_ALLOWED: "true" }),
  } as unknown as Deps;
  deps = {
    ...deps,
    limits: { hit: () => {} },
    log: { info: () => {}, error: () => {} },
    events: { emit: async () => {} },
    bucket: {
      put: async (key: string, bytes: Uint8Array) => {
        objects.set(key, typeof bytes === "string" ? Buffer.from(bytes) : bytes);
      },
      get: async (key: string) => (objects.has(key) ? { body: objects.get(key) } : null),
      head: async (key: string) => (objects.has(key) ? { size: objects.get(key)?.length } : null),
      getRange: async (key: string, from: number, to: number) =>
        objects.get(key)?.slice(from, to + 1) ?? null,
      presignPut: async () => ({ url: "https://fixture.test/upload", headers: {} }),
      deletePrefix: async () => {},
    },
  } as unknown as Deps;
  await deps.db.insert(org).values({
    id: orgId,
    name: "Private QA",
    homeDomain: "fixture.test",
    settings: {},
    pseudonymKey: randomBytes(32),
  });
  await deps.db
    .insert(people)
    .values({ id: personId, orgId, email: "qa@fixture.test", name: "QA", role: "owner" });
  await deps.db.insert(projects).values({ id: wikiId, orgId, name: "Wiki", slug: "wiki", kind: "wiki" });
  await deps.db.insert(tokens).values({
    id: tokenId,
    orgId,
    kind: "org",
    name: "Librarian",
    tokenHash: "synthetic",
    scopes: ["read", "comment", "edit", "publish"],
    projectIds: [wikiId],
    createdBy: personId,
  });
  await deps.db.insert(librarianConfig).values({
    orgId,
    enabled: true,
    generation: 1,
    tokenId,
    monthlyLimit: 1000n,
    runLimit: 600n,
    rateCard: { input: "2", output: "10" },
  });
  await deps.db.insert(librarianWikis).values({ orgId, projectId: wikiId });
  await deps.db
    .insert(librarianKeys)
    .values({ orgId, generation: 1, envelope: encryptProviderKey(Buffer.from("fixture"), orgId, 1, ring) });
});
afterAll(async () => {
  await connection?.close();
  await database?.drop();
});
let fence: NonNullable<Awaited<ReturnType<typeof claimRun>>>;
const pageId = crypto.randomUUID();
const objects = new Map<string, Uint8Array>();
const key = () => ({ id: crypto.randomUUID(), inputHash: "a".repeat(64) });
async function invoke(
  name: Parameters<ReturnType<typeof createContentTools>["tool"]>[3],
  input: unknown,
  receipt = key(),
  max = 60000,
) {
  const adapter = createContentTools(deps);
  return prepareAndPersist(deps, fence, receipt.id, async (tx) => {
    await adapter.authorizeTool(tx, fence, wikiId, name, input);
    return withToolReceipt(tx, fence, receipt, max, () =>
      adapter.tool(tx, fence, wikiId, name, input, receipt, max),
    );
  });
}
test("private fenced tools: concurrent lost-response retry, atomic rollback, current ceiling and kill", async () => {
  const claimed = await claimRun(deps, { orgId, wikiId, owner: crypto.randomUUID() });
  if (!claimed) throw new Error("claim missing");
  fence = claimed;
  await deps.db.insert(artifacts).values({
    id: pageId,
    orgId,
    projectId: wikiId,
    slug: "article",
    title: "Article",
    visibility: "org",
    publisherId: personId,
    latestVersion: 1,
  });
  const versionId = crypto.randomUUID();
  await deps.db.insert(versions).values({
    id: versionId,
    orgId,
    artifactId: pageId,
    n: 1,
    files: {},
    publishedBy: personId,
    wiki: { role: "page", sources: [], untrusted: false },
  });
  await deps.db
    .insert(pages)
    .values({ id: crypto.randomUUID(), orgId, versionId, pageKey: "index", kind: "article", position: 0 });
  const receipt = key();
  const question = { page: pageId, checkpoint: 1, text: "Please clarify." };
  const replies = await Promise.all([
    invoke("question", question, receipt),
    invoke("question", question, receipt),
    invoke("question", question, key()),
  ]);
  expect(replies[0]).toEqual(replies[1]);
  expect(replies[0]).toEqual(replies[2]);
  expect(await invoke("question", question, key())).toEqual(replies[0]);
  expect(await deps.db.select().from(comments)).toHaveLength(1);
  expect(await deps.db.select().from(activity)).toHaveLength(1);
  await expect(invoke("question", question, key(), 1)).rejects.toThrow();
  expect(await deps.db.select().from(comments)).toHaveLength(1);
  await deps.db.update(tokens).set({ projectIds: [] }).where(eq(tokens.id, tokenId));
  await expect(invoke("question", question, receipt)).rejects.toThrow();
  await deps.db
    .update(tokens)
    .set({ projectIds: [wikiId] })
    .where(eq(tokens.id, tokenId));
  const proposal = { title: "Proposed", summary: "Review", markdown: "Untrusted text", sources: [pageId] };
  const proposalKey = key();
  expect(await invoke("propose_page", proposal, proposalKey)).toEqual({ proposalId: proposalKey.id });
  expect(await deps.db.select().from(librarianProposals)).toHaveLength(1);
  const delegate = (await invoke("page_delegate_start", {
    page: pageId,
    start: { goal: "Check the fixture" },
  })) as { id: string; edits: string };
  expect(delegate.edits).toBe("suggestion");
  const finished = (await invoke("page_delegate_finish", { page: pageId, run: delegate.id, finish: {} })) as {
    status: string;
  };
  expect(finished.status).toBe("finished");
  await deps.db.update(librarianConfig).set({ generation: 2 }).where(eq(librarianConfig.orgId, orgId));
  await expect(invoke("question", question, receipt)).rejects.toThrow();
  await deps.db.update(librarianConfig).set({ generation: 1 }).where(eq(librarianConfig.orgId, orgId));
  await cancelRun(deps, orgId, fence.runId);
  await expect(invoke("question", question, receipt)).rejects.toThrow();
});

test.each(process.env.LIBRARIAN_QA_URL === "private-fixture" ? ["url"] : ["text", "file"])(
  "deterministic %s -> immutable source -> existing article suggestion and proposal, private provider only",
  async (kind) => {
    const beforeSuggestions = (await deps.db.select().from(suggestions)).length;
    const beforeProposals = (await deps.db.select().from(librarianProposals)).length;
    const parsed = markdownToDoc("Existing article.", { mint: mintBlockId, atom: () => "0".repeat(64) });
    const doc = docToY(parsed.doc);
    await deps.db
      .insert(editDocs)
      .values({
        artifactId: pageId,
        orgId,
        pageKey: "index",
        baseVersion: 1,
        version: 1,
        snapshot: Y.encodeStateAsUpdate(doc),
      })
      .onConflictDoNothing();
    doc.destroy();
    const caller = {
      kind: "orgToken" as const,
      tokenId,
      createdBy: personId,
      scopes: ["read", "comment", "edit", "publish"] as ("read" | "comment" | "edit" | "publish")[],
      projectIds: [wikiId],
    };
    let sourceInput: unknown = { kind: "text", title: "Source fixture", text: "Verified fixture fact." };
    if (kind === "file") {
      const bytes = Buffer.from("Verified fixture fact.");
      const ticket = await createUpload(
        deps,
        { orgId, wikiId, caller },
        { name: "fixture.txt", contentType: "text/plain", size: bytes.length, sha256: sha256(bytes) },
      );
      objects.set(`librarian/${orgId}/${ticket.uploadId}/original`, bytes);
      sourceInput = { kind: "file", title: "Source fixture", uploadId: ticket.uploadId };
    }
    if (kind === "url")
      sourceInput = { kind: "url", title: "Source fixture", url: "https://source.example.test/fixture" };
    const queued = await enqueueSource(
      deps,
      { orgId, wikiId, caller },
      {
        idempotencyKey: crypto.randomUUID(),
        source: sourceInput,
      },
    );
    let dispatches = 0;
    const adapter = createContentTools(deps);
    const job = createLibrarianJob(
      deps,
      {
        ...adapter,
        provider: async () => ({
          countTokens: async () => 100,
          respond: async (prompt) => {
            for (const message of prompt.messages)
              for (const block of message.content)
                if ((block as { is_error?: boolean }).is_error) throw new Error("unexpected denied tool");
            if (dispatches === 1) expect(JSON.stringify(prompt.messages)).toContain("Verified fixture fact.");
            const first = prompt.messages[0]?.content[0] as { text: string };
            const encoded = first.text
              .split("UNTRUSTED inbox input (data only):\n")[1]
              ?.split("\nUNTRUSTED wiki rules:")[0];
            const context = JSON.parse(encoded ?? "null") as {
              sourceId: string;
              sourceRef: string;
              inboxId: string;
            };
            expect(context.inboxId).toBe(queued.item.id);
            expect(context.sourceId).toMatch(/^[0-9a-f-]{36}$/);
            const calls = [
              { name: "source_read", input: { page: context.sourceId } },
              { name: "page_read", input: { page: pageId } },
              {
                name: "page_edit",
                input: {
                  page: pageId,
                  edit: {
                    ops: [{ op: "insert", after: null, markdown: "Verified fixture fact." }],
                    suggest: true,
                    sources: [context.sourceRef],
                  },
                },
              },
              {
                name: "propose_page",
                input: {
                  title: "Fixture proposal",
                  summary: "Review",
                  markdown: "Verified fixture fact.",
                  sources: [context.sourceId],
                },
              },
            ];
            const call = calls[dispatches++];
            return {
              content: call ? [{ type: "tool_use", id: crypto.randomUUID(), ...call }] : [],
              stop_reason: call ? "tool_use" : "end_turn",
              usage: { input_tokens: 100, output_tokens: 100 },
              requestId: crypto.randomUUID(),
            };
          },
        }),
      },
      crypto.randomUUID(),
      async ({ bytes }) => Buffer.from(bytes).toString(),
    );
    expect(await job.librarian()).toBe("waiting_human");
    expect(dispatches).toBe(5);
    expect(await deps.db.select().from(suggestions)).toHaveLength(beforeSuggestions + 1);
    const [inbox] = await deps.db.select().from(librarianInbox).where(eq(librarianInbox.id, queued.item.id));
    expect(inbox?.status).toBe("waiting_human");
    expect(inbox?.input).toBeNull();
    expect(await deps.db.select().from(librarianProposals)).toHaveLength(beforeProposals + 1);
  },
);

test("queued extraction fails closed without config and fences kill during extraction before provider construction", async () => {
  const caller = {
    kind: "orgToken" as const,
    tokenId,
    createdBy: personId,
    scopes: ["read", "comment", "edit", "publish"] as ("read" | "comment" | "edit" | "publish")[],
    projectIds: [wikiId],
  };
  let factories = 0;
  const adapters = {
    ...createContentTools(deps),
    provider: async () => {
      factories++;
      throw new Error("must not construct");
    },
  };
  const enqueue = () =>
    enqueueSource(
      deps,
      { orgId, wikiId, caller },
      {
        idempotencyKey: crypto.randomUUID(),
        source: { kind: "text", title: "Closed fixture", text: crypto.randomUUID() },
      },
    );
  const first = await enqueue();
  expect(await createLibrarianJob(deps, adapters).librarian()).toBeNull();
  const [failed] = await deps.db.select().from(librarianInbox).where(eq(librarianInbox.id, first.item.id));
  expect(failed?.status).toBe("failed");
  expect(failed?.sourceArtifactId).toBeNull();
  const second = await enqueue();
  const job = createLibrarianJob(deps, adapters, crypto.randomUUID(), async () => {
    await deps.db.update(librarianConfig).set({ generation: 2 }).where(eq(librarianConfig.orgId, orgId));
    return "Extracted after kill";
  });
  expect(await job.librarian()).toBeNull();
  const [killed] = await deps.db.select().from(librarianInbox).where(eq(librarianInbox.id, second.item.id));
  expect(killed?.sourceArtifactId).toBeNull();
  expect(factories).toBe(0);
});

test("unseeded edits and checkpoints: verified storage, cancellation, stale generation, replay and direct finish", async () => {
  const { putBlob } = await import("../src/publish/blobs.ts");
  const { MANIFEST } = await import("@artifacts/schema");
  const { librarianReceipts } = await import("../src/db/schema.ts");
  await deps.db
    .update(librarianConfig)
    .set({ generation: 1, monthlyLimit: 100000n })
    .where(eq(librarianConfig.orgId, orgId));
  const fixture = async (source = "Seed text.\n") => {
    const id = crypto.randomUUID();
    const manifest = JSON.stringify({ title: "Seed", pages: [{ id: "index", src: "index.md" }] });
    const files: Record<string, { hash: string; size: number; type: string }> = {};
    for (const [path, text] of [
      ["index.md", source],
      [MANIFEST, manifest],
    ]) {
      const bytes = Buffer.from(text!);
      files[path!] = {
        hash: await putBlob(deps, orgId, bytes, "text/plain"),
        size: bytes.length,
        type: "text/plain",
      };
    }
    await deps.db.insert(artifacts).values({
      id,
      orgId,
      projectId: wikiId,
      slug: `test-${id.replaceAll("-", "")}`,
      title: "Seed",
      visibility: "org",
      publisherId: personId,
      latestVersion: 1,
      agentMaintained: true,
    });
    const vid = crypto.randomUUID();
    await deps.db.insert(versions).values({
      id: vid,
      orgId,
      artifactId: id,
      n: 1,
      files,
      publishedBy: personId,
      wiki: { role: "page", sources: [], untrusted: false },
    });
    await deps.db.insert(pages).values({
      id: crypto.randomUUID(),
      orgId,
      versionId: vid,
      pageKey: "index",
      kind: "article",
      position: 0,
    });
    return id;
  };
  const claim = async () => {
    const claimed = await claimRun(deps, { orgId, wikiId, owner: crypto.randomUUID() });
    if (!claimed) throw Error("missing claim");
    fence = claimed;
  };
  const originalBucket = deps.bucket;
  const notices: { kind: string; payload: unknown }[] = [];
  deps.docs = {
    notify: (_id, kind, payload) => {
      notices.push({ kind, payload });
    },
    agentPresence: () => {},
  };
  for (const branch of ["edit", "finish"] as const) {
    for (const mode of [
      "success",
      "storage",
      "corrupt",
      "generation",
      "fence",
      "lease",
      "kill",
      "human",
      "slow",
    ] as const) {
      await claim();
      const id = await fixture();
      const receipt = key();
      const read = (await invoke("page_read", { page: id })) as {
        blocks: { id: string; base: string; markdown: string }[];
      };
      expect(read.blocks[0]?.markdown).toContain("Seed text.");
      expect(read.blocks[0]?.id).toMatch(/^~/);
      const request = {
        page: id,
        edit: {
          ops: [
            {
              op: "replace",
              block: read.blocks[0]!.id,
              base: read.blocks[0]!.base,
              markdown: `Prepared ${mode}.`,
            },
          ],
          checkpoint: true,
        },
      };
      let finishRunId: string | undefined;
      if (branch === "finish") {
        const run = (await invoke("page_delegate_start", {
          page: id,
          start: { goal: "Prepare finish" },
        })) as { id: string };
        finishRunId = run.id;
        await invoke("page_edit", {
          page: id,
          edit: { ops: [{ op: "insert", after: null, markdown: `Finish ${mode}.` }], run: run.id },
        });
      }
      const toolName = branch === "edit" ? ("page_edit" as const) : ("page_delegate_finish" as const);
      const toolInput = branch === "edit" ? request : { page: id, run: finishRunId, finish: {} };
      let beforeDraft = await deps.db.select().from(editDocs).where(eq(editDocs.artifactId, id));
      const beforeNotices = notices.length;
      const humanEditDone = Promise.withResolvers<void>();
      let releaseStorage: (() => void) | undefined;
      let touched = false;
      deps.bucket = {
        ...originalBucket,
        put: async (...args) => {
          if (mode === "storage") throw Error("storage unavailable");
          const stored = await originalBucket.put(...args);
          if (mode === "corrupt") objects.set(args[0], Buffer.from("corrupted"));
          if (!touched) {
            touched = true;
            if (mode === "generation")
              await deps.db
                .update(librarianConfig)
                .set({ generation: 2 })
                .where(eq(librarianConfig.orgId, orgId));
            if (mode === "fence") {
              const { librarianRuns } = await import("../src/db/schema.ts");
              await deps.db
                .update(librarianRuns)
                .set({ fence: fence.fence + 1 })
                .where(eq(librarianRuns.id, fence.runId));
            }
            if (mode === "lease") clock.advance(100000);
            if (mode === "kill" || mode === "slow") await cancelRun(deps, orgId, fence.runId);
            if (mode === "human" || mode === "slow") {
              const { withDocLock } = await import("../src/editing/store.ts");
              await withDocLock(deps, id, async (lock) => {
                await lock.tx
                  .update(artifacts)
                  .set({ title: "Human edit during staging" })
                  .where(eq(artifacts.id, id));
                if (lock.row) {
                  await lock.tx
                    .update(editDocs)
                    .set({ epoch: lock.row.epoch + 1, meta: { title: "Human draft metadata" } })
                    .where(eq(editDocs.artifactId, id));
                }
              });
              beforeDraft = await deps.db.select().from(editDocs).where(eq(editDocs.artifactId, id));
              humanEditDone.resolve();
            }
            if (mode === "slow")
              await new Promise<void>((resolve) => {
                releaseStorage = resolve;
              });
          }
          return stored;
        },
      } as Deps["bucket"];
      try {
        if (mode === "success") {
          const result = await invoke(toolName, toolInput, receipt);
          expect(result).toMatchObject({ version: 2 });
          expect(await invoke(toolName, toolInput, receipt)).toEqual(result);
          const run = (await invoke("page_delegate_start", {
            page: id,
            start: { goal: "Finish checkpoint" },
          })) as { id: string; edits: string };
          expect(run.edits).toBe("direct");
          await invoke("page_edit", {
            page: id,
            edit: { ops: [{ op: "insert", after: null, markdown: "Delegate text." }], run: run.id },
          });
          const finishKey = key();
          const finishInput = { page: id, run: run.id, finish: { message: "Done" } };
          const finished = await invoke("page_delegate_finish", finishInput, finishKey);
          expect(finished).toMatchObject({ status: "finished", version: 3 });
          expect(
            notices.slice(beforeNotices).some((n) => (n.payload as { t?: string }).t === "checkpoint"),
          ).toBe(true);
          expect(notices.slice(beforeNotices).some((n) => (n.payload as { t?: string }).t === "run")).toBe(
            true,
          );
          const suggestionResult = (await invoke("page_edit", {
            page: id,
            edit: { suggest: true, ops: [{ op: "insert", after: null, markdown: "Please consider this." }] },
          })) as { results: { outcome: string }[] };
          expect(suggestionResult.results[0]?.outcome).toBe("suggested");
          expect(
            notices.slice(beforeNotices).some((n) => (n.payload as { t?: string }).t === "suggestion"),
          ).toBe(true);
          const latestRead = (await invoke("page_read", { page: id })) as {
            blocks: { id: string; base: string }[];
          };
          const deleted = (await invoke("page_edit", {
            page: id,
            edit: {
              ops: [{ op: "delete", block: latestRead.blocks[0]!.id, base: latestRead.blocks[0]!.base }],
            },
          })) as { results: { outcome: string }[] };
          expect(deleted.results[0]?.outcome).toBe("applied");
          expect(await invoke("page_delegate_finish", finishInput, finishKey)).toEqual(finished);
        } else {
          await expect(invoke(toolName, toolInput, receipt)).rejects.toThrow();
          expect(notices).toHaveLength(beforeNotices);
          if (mode === "human" || mode === "slow") {
            await humanEditDone.promise;
            expect(touched).toBe(true);
            const [human] = await deps.db.select().from(artifacts).where(eq(artifacts.id, id));
            expect(human?.title).toBe("Human edit during staging");
            const { findArtifact } = await import("../src/auth/access.ts");
            const { pageRead } = await import("../src/editing/ops.ts");
            const resource = await findArtifact(deps, orgId, id);
            if (!resource) throw Error("Human page missing");
            const canonical = await pageRead(
              deps,
              {
                kind: "orgToken",
                tokenId,
                createdBy: personId,
                scopes: ["read", "comment", "edit", "publish"],
                projectIds: [wikiId],
              },
              resource,
              { draft: false },
            );
            expect(canonical.title).toBe("Human edit during staging");
            expect(canonical.blocks.map((block) => block.markdown).join("\n")).toContain("Seed text.");
            expect(canonical.blocks.map((block) => block.markdown).join("\n")).not.toContain(
              `Prepared ${mode}.`,
            );
          }
          expect(await deps.db.select().from(editDocs).where(eq(editDocs.artifactId, id))).toEqual(
            beforeDraft,
          );
          expect(await deps.db.select().from(versions).where(eq(versions.artifactId, id))).toHaveLength(1);
          expect(
            await deps.db.select().from(librarianReceipts).where(eq(librarianReceipts.toolKey, receipt.id)),
          ).toHaveLength(0);
        }
      } finally {
        releaseStorage?.();
        deps.bucket = originalBucket;
        if (mode === "lease" && touched) clock.advance(-100000);
        await deps.db.update(librarianConfig).set({ generation: 1 }).where(eq(librarianConfig.orgId, orgId));
        await cancelRun(deps, orgId, fence.runId);
      }
    }
  }
  await claim();
  try {
    const text = Array.from({ length: 50 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(100)}`).join("\n\n");
    const id = await fixture(text);
    const first = (await invoke("page_read", { page: id })) as {
      version: number;
      seq: number;
      blocks: { markdown: string }[];
      nextCursor: string | null;
    };
    expect(first.nextCursor).toMatch(/^1:0:\d+$/);
    const read = [...first.blocks];
    let cursor = first.nextCursor;
    while (cursor) {
      const next = (await invoke("page_read", { page: id, cursor })) as typeof first;
      read.push(...next.blocks);
      cursor = next.nextCursor;
    }
    expect(read).toHaveLength(50);
    await invoke("page_edit", {
      page: id,
      edit: { ops: [{ op: "insert", after: null, markdown: "New draft sequence." }] },
    });
    await expect(invoke("page_read", { page: id, cursor: first.nextCursor })).rejects.toThrow("Page changed");
    await deps.db.update(artifacts).set({ latestVersion: 2 }).where(eq(artifacts.id, id));
    await expect(invoke("page_read", { page: id, cursor: first.nextCursor })).rejects.toThrow();
  } finally {
    await cancelRun(deps, orgId, fence.runId);
  }
});

test("large immutable source creator: complete Unicode pagination, canonical slugs, exact text hashes and version pin", async () => {
  const { extractSource, promoteSource } = await import("../src/librarian/ingestion/index.ts");
  const { blocks } = await import("../src/db/schema.ts");
  const { asc } = await import("drizzle-orm");
  const caller = {
    kind: "orgToken" as const,
    tokenId,
    createdBy: personId,
    scopes: ["read", "comment", "edit", "publish"] as ("read" | "comment" | "edit" | "publish")[],
    projectIds: [wikiId],
  };
  const submission = { orgId, wikiId, caller };
  // Starts with a newline; includes astral codepoints across chunk boundaries and HTML-like text.
  const text = "\n" + "😀é <unsafe>& \r\n".repeat(7000);
  const queued = await enqueueSource(deps, submission, {
    idempotencyKey: crypto.randomUUID(),
    source: { kind: "text", title: "Unicode source", text },
  });
  const claimed = await claimRun(deps, {
    orgId,
    wikiId,
    owner: crypto.randomUUID(),
    inboxId: queued.item.id,
  });
  if (!claimed) throw Error("missing claim");
  fence = claimed;
  try {
    const extracted = await extractSource(deps, submission, queued.item.id, fence, async () => text);
    const id = await promoteSource(deps, submission, queued.item.id, fence, extracted);
    if (!id) throw Error("source missing");
    const [source] = await deps.db.select().from(artifacts).where(eq(artifacts.id, id));
    if (!source) throw Error("source missing");
    expect(source.slug).toBe(`source-${queued.item.id.replaceAll("-", "")}`);
    expect(source.slug.length).toBeLessThanOrEqual(40);
    const [version] = await deps.db.select().from(versions).where(eq(versions.artifactId, id));
    if (!version) throw Error("version missing");
    const stored = await deps.db
      .select()
      .from(blocks)
      .where(eq(blocks.versionId, version.id))
      .orderBy(asc(blocks.blockKey));
    expect(stored.map((b) => b.text).join("")).toBe(text.replace(/\r\n?/g, "\n"));
    for (const row of stored) expect(row.contentHash).toBe(sha256(row.text));
    let cursor: number | undefined;
    const read: string[] = [];
    let count = 0;
    do {
      const result = (await invoke(
        "source_read",
        { page: id, ...(cursor === undefined ? {} : { cursor }), version: 1 },
        key(),
        12000,
      )) as { blocks: { text: string }[]; nextCursor: number | null };
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(12000);
      read.push(...result.blocks.map((b) => b.text));
      cursor = result.nextCursor ?? undefined;
      count++;
    } while (cursor !== undefined && count < 100);
    expect(cursor).toBeUndefined();
    expect(count).toBeGreaterThan(1);
    expect(read.join("")).toBe(text.replace(/\r\n?/g, "\n"));
    await expect(invoke("source_read", { page: id, version: 2 })).rejects.toThrow("Checkpoint changed");
  } finally {
    await cancelRun(deps, orgId, fence.runId);
  }
});
