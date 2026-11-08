import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { connect } from "../src/db/index.ts";
import { runMigrations } from "../src/db/migrate.ts";
import {
  artifacts,
  editRuns,
  librarianConfig,
  librarianInbox,
  librarianKeys,
  librarianMonths,
  librarianReceipts,
  librarianRuns,
  librarianWikis,
  org,
  people,
  projects,
  tokens,
} from "../src/db/schema.ts";
import type { Deps } from "../src/deps.ts";
import { claimRun } from "../src/librarian/budget.ts";
import { createLibrarianJob, finalizeExecution } from "../src/librarian/integration.ts";
import { encryptProviderKey } from "../src/librarian/keys.ts";
import { cancelRun, finishLocked, locked, reapExpiredRuns, withRunFence } from "../src/librarian/leases.ts";
import { ProviderFailure } from "../src/librarian/runner/provider.ts";
import { createDatabase, testClock, testEnv } from "./helpers.ts";

const orgId = crypto.randomUUID(),
  personId = crypto.randomUUID(),
  wikiId = crypto.randomUUID(),
  tokenId = crypto.randomUUID();
const ring = {
  active: "v1",
  keys: new Map([
    ["v1", randomBytes(32)],
    ["v2", randomBytes(32)],
  ]),
};
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

test.each(["cancelled", "expired", "failed", "waiting_human"])(
  "terminal %s closes only owned delegates once and preserves work",
  async (state) => {
    const fence = await claimRun(deps, { orgId, wikiId, owner: crypto.randomUUID() });
    if (!fence) throw new Error("claim missing");
    const page = crypto.randomUUID(),
      owned = crypto.randomUUID(),
      other = crypto.randomUUID();
    await deps.db.insert(artifacts).values({
      id: page,
      orgId,
      projectId: wikiId,
      slug: `p${page.replaceAll("-", "")}`,
      title: "Retained work",
      publisherId: personId,
      visibility: "org",
    });
    for (const id of [owned, other])
      await deps.db.insert(editRuns).values({
        id,
        orgId,
        artifactId: page,
        edits: "suggestion",
        goal: "fixture",
        startedBy: personId,
        tokenId,
        startedAt: clock.now(),
        expiresAt: new Date(clock.now().getTime() + 600000),
      });
    await deps.db.insert(librarianReceipts).values({
      orgId,
      runId: fence.runId,
      toolKey: crypto.randomUUID(),
      inputHash: "a".repeat(64),
      result: { kind: "delegate_ownership", editRunId: owned },
    });
    let notifications = 0;
    deps.docs = {
      notify: () => {
        notifications++;
      },
    } as unknown as Deps["docs"];
    if (state === "cancelled") {
      await expect(
        locked(deps, orgId, async (tx) => {
          const [run] = await tx.select().from(librarianRuns).where(eq(librarianRuns.id, fence.runId));
          if (!run) throw new Error("missing");
          await finishLocked(deps, tx, run, "cancelled");
          throw new Error("rollback terminal");
        }),
      ).rejects.toThrow();
      expect(notifications).toBe(0);
      expect((await deps.db.select().from(editRuns).where(eq(editRuns.id, owned)))[0]?.status).toBe("active");
      expect(
        (await deps.db.select().from(librarianRuns).where(eq(librarianRuns.id, fence.runId)))[0]?.state,
      ).toBe("running");
      expect((await deps.db.select().from(librarianMonths))[0]?.reserved).toBe(600n);
    }
    const finish = async () => {
      if (state === "cancelled") await cancelRun(deps, orgId, fence.runId);
      else if (state === "expired") {
        clock.advance(90001);
        await reapExpiredRuns(deps);
      } else await finalizeExecution(deps, fence, state as "failed" | "waiting_human");
    };
    await finish();
    await finish();
    const rows = await deps.db.select().from(editRuns);
    expect(rows.find((r) => r.id === owned)?.status).toBe("cancelled");
    expect(rows.find((r) => r.id === other)?.status).toBe("active");
    expect(notifications).toBe(1);
    expect((await deps.db.select().from(artifacts).where(eq(artifacts.id, page)))[0]?.title).toBe(
      "Retained work",
    );
    expect((await deps.db.select().from(librarianMonths))[0]?.reserved).toBe(0n);
  },
);

test("runner persists Delegate ownership in the mutation transaction before terminal cleanup", async () => {
  const page = crypto.randomUUID(),
    delegate = crypto.randomUUID();
  await deps.db.insert(artifacts).values({
    id: page,
    orgId,
    projectId: wikiId,
    slug: `p${page.replaceAll("-", "")}`,
    title: "Retained",
    publisherId: personId,
    visibility: "org",
  });
  let turn = 0;
  deps.log = { info: () => {} } as unknown as Deps["log"];
  const job = createLibrarianJob(deps, {
    authorizeTool: async () => {},
    tool: async (tx, _fence, _wiki, name) => {
      if (name !== "page_delegate_start") return {};
      await tx.insert(editRuns).values({
        id: delegate,
        orgId,
        artifactId: page,
        edits: "direct",
        goal: "fixture",
        startedBy: personId,
        tokenId,
        startedAt: clock.now(),
        expiresAt: new Date(clock.now().getTime() + 600000),
      });
      return { id: delegate };
    },
    provider: async () => ({
      countTokens: async () => 10,
      respond: async () => ({
        content:
          turn++ === 0
            ? [
                {
                  type: "tool_use",
                  id: "delegate",
                  name: "page_delegate_start",
                  input: { page, start: { goal: "fixture" } },
                },
              ]
            : [],
        stop_reason: turn === 1 ? "tool_use" : "end_turn",
        usage: { input_tokens: 10, output_tokens: 10 },
        requestId: crypto.randomUUID(),
      }),
    }),
  });
  expect(await job.librarian()).toBe("succeeded");
  const records = await deps.db.select().from(librarianReceipts);
  expect(records.some((row) => (row.result as { editRunId?: string }).editRunId === delegate)).toBe(true);
  expect((await deps.db.select().from(editRuns).where(eq(editRuns.id, delegate)))[0]?.status).toBe(
    "cancelled",
  );
});

test("cancelled inbox fences a still-running engine and provider count 401 persistently disables future jobs", async () => {
  const inboxId = crypto.randomUUID();
  await deps.db.insert(librarianInbox).values({
    id: inboxId,
    orgId,
    wikiId,
    submittedBy: personId,
    kind: "text",
    title: "Fixture",
    status: "ready",
    idempotencyKey: crypto.randomUUID(),
    payloadHash: "a".repeat(64),
    rawExpiresAt: new Date(clock.now().getTime() + 600000),
  });
  const fence = await claimRun(deps, { orgId, wikiId, owner: crypto.randomUUID(), inboxId });
  if (!fence) throw new Error("claim missing");
  await deps.db.update(librarianInbox).set({ status: "cancelled" }).where(eq(librarianInbox.id, inboxId));
  await expect(withRunFence(deps, fence, async () => {})).rejects.toThrow();
  await cancelRun(deps, orgId, fence.runId);
  clock.advance(86400000);
  let counts = 0,
    dispatches = 0;
  deps.log = { info: () => {} } as unknown as Deps["log"];
  const job = createLibrarianJob(deps, {
    authorizeTool: async () => {},
    tool: async () => ({}),
    provider: async () => ({
      countTokens: async () => {
        counts++;
        throw new ProviderFailure(401);
      },
      respond: async () => {
        dispatches++;
        throw new Error("forbidden");
      },
    }),
  });
  expect(await job.librarian()).toBe("interrupted");
  expect((await deps.db.select().from(librarianConfig))[0]?.enabled).toBe(false);
  expect(await job.librarian()).toBeNull();
  expect(counts).toBe(1);
  expect(dispatches).toBe(0);
});
