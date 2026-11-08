import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { SourceInput } from "@artifacts/schema";
import { eq, sql } from "drizzle-orm";
import { connect } from "../src/db/index.ts";
import { runMigrations } from "../src/db/migrate.ts";
import {
  librarianAttempts,
  librarianConfig,
  librarianKeys,
  librarianMonths,
  librarianRuns,
  librarianWikis,
  org,
  people,
  projects,
  tokens,
} from "../src/db/schema.ts";
import type { Deps } from "../src/deps.ts";
import { claimRun, reserveAttempt, settleAttempt } from "../src/librarian/budget.ts";
import { loadSafeConfig, saveConfig } from "../src/librarian/config.ts";
import { decryptProviderKey, encryptProviderKey, keyring, rotateEnvelope } from "../src/librarian/keys.ts";
import { cancelRun, heartbeatRun, reapExpiredRuns, withRunFence } from "../src/librarian/leases.ts";
import { createDatabase, testClock, testEnv } from "./helpers.ts";

test("shared source boundary rejects credentialed, IP and non-HTTPS URLs and oversized UTF-8", () => {
  for (const url of [
    "http://example.com",
    "https://127.0.0.1",
    "https://[::1]",
    "https://user:pass@example.com",
    "https://example.com:444",
    "https://example.com/#secret",
  ]) {
    expect(SourceInput.safeParse({ kind: "url", url }).success).toBe(false);
  }
  expect(SourceInput.safeParse({ kind: "text", title: "Fixture", text: "é".repeat(524289) }).success).toBe(
    false,
  );
  expect(SourceInput.safeParse({ kind: "file", uploadId: "/tmp/file" }).success).toBe(false);
});

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
test("AEAD binds org, generation, ciphertext and KEK; synthetic recovery and rotation", () => {
  const secret = Buffer.from("synthetic-provider-fixture");
  const e = encryptProviderKey(secret, orgId, 1, ring);
  expect(JSON.stringify(e)).not.toContain(secret.toString());
  expect(decryptProviderKey(e, orgId, 1, ring).equals(secret)).toBe(true);
  expect(() => decryptProviderKey(e, crypto.randomUUID(), 1, ring)).toThrow();
  expect(() => decryptProviderKey(e, orgId, 2, ring)).toThrow();
  expect(() =>
    decryptProviderKey({ ...e, ciphertext: Buffer.from("tampered").toString("base64") }, orgId, 1, ring),
  ).toThrow();
  expect(() =>
    decryptProviderKey(e, orgId, 1, { active: "v2", keys: new Map([["v2", ring.keys.get("v2")!]]) }),
  ).toThrow();
  const rotated = rotateEnvelope(e, orgId, 1, { ...ring, active: "v2" });
  expect(rotated.kekId).toBe("v2");
  expect(rotated.nonce).not.toBe(e.nonce);
  expect(decryptProviderKey(rotated, orgId, 1, ring).equals(secret)).toBe(true);
  expect(() => keyring({ env: { sessionSecret: "x".repeat(64) } as Deps["env"] })).toThrow();
});
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
let fence: NonNullable<Awaited<ReturnType<typeof claimRun>>>;
test("racing replicas claim once and reserve full run cap", async () => {
  const claims = await Promise.all(
    Array.from({ length: 8 }, () => claimRun(deps, { orgId, wikiId, owner: crypto.randomUUID() })),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  fence = claims.find(Boolean)!;
  const [month] = await deps.db.select().from(librarianMonths);
  expect(month?.reserved).toBe(600n);
});
test("racing attempts cannot oversubscribe; settlement exactly once", async () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const race = await Promise.allSettled(
    ids.map((attemptId) => reserveAttempt(deps, fence, { attemptId, ceilingMicrousd: 400n })),
  );
  expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const attemptId = ids[race.findIndex((r) => r.status === "fulfilled")]!;
  const settle = {
    orgId,
    runId: fence.runId,
    attemptId,
    outcome: "settled" as const,
    actualMicrousd: 100n,
    requestId: "fixture-request-1",
  };
  await Promise.all([settleAttempt(deps, settle), settleAttempt(deps, settle)]);
  const [m] = await deps.db.select().from(librarianMonths);
  expect(m?.settled).toBe(100n);
  expect(m?.reserved).toBe(500n);
});
test("kill races fence mutation and retain pending billing without refund", async () => {
  const attemptId = crypto.randomUUID();
  await reserveAttempt(deps, fence, { attemptId, ceilingMicrousd: 300n });
  await deps.db.execute(sql`create table fence_mutation_proof (id integer primary key)`);
  let entered!: () => void;
  let release!: () => void;
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const continueMutation = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mutation = withRunFence(deps, fence, async (tx) => {
    entered();
    await continueMutation;
    await tx.execute(sql`insert into fence_mutation_proof values (1)`);
  });
  await inside;
  const cancellation = cancelRun(deps, orgId, fence.runId);
  release();
  await Promise.all([mutation, cancellation]);
  await expect(
    withRunFence(deps, fence, async (tx) => {
      await tx.execute(sql`insert into fence_mutation_proof values (2)`);
    }),
  ).rejects.toThrow();
  const proof = await deps.db.execute(sql`select count(*)::int as n from fence_mutation_proof`);
  expect(proof[0]?.n).toBe(1);
  await expect(withRunFence(deps, fence, async () => true)).rejects.toThrow();
  const [m] = await deps.db.select().from(librarianMonths);
  expect(m?.settled).toBe(100n);
  expect(m?.uncertain).toBe(300n);
  expect(m?.reserved).toBe(0n);
  await expect(
    settleAttempt(deps, {
      orgId,
      runId: fence.runId,
      attemptId,
      outcome: "settled",
      actualMicrousd: 1n,
      requestId: "late",
    }),
  ).rejects.toThrow();
});
test("lease heartbeat, expiry recovery and month pinning", async () => {
  fence = (await claimRun(deps, { orgId, wikiId, owner: crypto.randomUUID() }))!;
  await heartbeatRun(deps, fence);
  const attemptId = crypto.randomUUID();
  await reserveAttempt(deps, fence, { attemptId, ceilingMicrousd: 200n });
  clock.advance(120_000);
  await reapExpiredRuns(deps);
  const [run] = await deps.db.select().from(librarianRuns).where(eq(librarianRuns.id, fence.runId));
  expect(run?.state).toBe("interrupted");
  expect(run?.month).toBe("2026-01");
  const [m] = await deps.db.select().from(librarianMonths);
  expect(m?.uncertain).toBe(500n);
  expect(m?.reserved).toBe(0n);
  await expect(heartbeatRun(deps, fence)).rejects.toThrow();
});
test("safe config hides envelopes; global ceiling, stale generation and config kill", async () => {
  const safe = await loadSafeConfig(deps, orgId);
  expect(safe.keyConfigured).toBe(true);
  expect(JSON.stringify(safe)).not.toContain("ciphertext");
  fence = (await claimRun(deps, { orgId, wikiId, owner: crypto.randomUUID() }))!;
  deps.env.librarianAllowed = false;
  expect(await claimRun(deps, { orgId, wikiId, owner: crypto.randomUUID() })).toBeNull();
  await expect(withRunFence(deps, fence, async () => true)).rejects.toThrow();
  await saveConfig(deps, orgId, personId, {
    expectedGeneration: 1,
    enabled: false,
    wikiIds: [wikiId],
    model: safe.model,
    monthlyLimitMicrousd: 1000,
    runLimitMicrousd: 600,
  });
  expect((await loadSafeConfig(deps, orgId)).generation).toBe(2);
  await expect(
    saveConfig(deps, orgId, personId, {
      expectedGeneration: 1,
      enabled: false,
      wikiIds: [],
      model: safe.model,
      monthlyLimitMicrousd: 0,
      runLimitMicrousd: 0,
    }),
  ).rejects.toThrow();
  const pending = await deps.db
    .select()
    .from(librarianAttempts)
    .where(eq(librarianAttempts.state, "reserved"));
  expect(pending).toHaveLength(0);
});

test("receipts fence concurrent retries, roll back mutations and reject changed input", async () => {
  const { withToolReceipt } = await import("../src/librarian/mutations.ts");
  deps.env.librarianAllowed = true;
  await deps.db
    .update(librarianConfig)
    .set({ enabled: true, monthlyLimit: 10000n })
    .where(eq(librarianConfig.orgId, orgId));
  fence = (await claimRun(deps, { orgId, wikiId, owner: crypto.randomUUID() }))!;
  const toolKey = crypto.randomUUID(),
    inputHash = "a".repeat(64);
  let calls = 0;
  const mutate = async (tx: Parameters<Parameters<typeof withToolReceipt>[3]>[0]) => {
    calls++;
    await tx.execute(sql`insert into fence_mutation_proof values (3)`);
    return { resourceId: "fixture" };
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      withToolReceipt(deps, fence, { toolKey, inputHash }, mutate, async () => {}),
    ),
  );
  expect(calls).toBe(1);
  await expect(
    withToolReceipt(deps, fence, { toolKey, inputHash }, mutate, async () => {
      throw new Error("resource hidden since prior tool execution");
    }),
  ).rejects.toThrow();
  expect(results.every((r) => r.resourceId === "fixture")).toBe(true);
  await expect(
    withToolReceipt(deps, fence, { toolKey, inputHash: "b".repeat(64) }, mutate, async () => {}),
  ).rejects.toThrow();
  await expect(
    withToolReceipt(
      deps,
      fence,
      { toolKey: crypto.randomUUID(), inputHash },
      async (tx) => {
        await tx.execute(sql`insert into fence_mutation_proof values (4)`);
        return "x".repeat(61000);
      },
      async () => {},
    ),
  ).rejects.toThrow();
  const proof = await deps.db.execute(sql`select count(*)::int as n from fence_mutation_proof where id = 4`);
  expect(proof[0]?.n).toBe(0);
  await cancelRun(deps, orgId, fence.runId);
  await expect(
    withToolReceipt(deps, fence, { toolKey, inputHash }, mutate, async () => {}),
  ).rejects.toThrow();
});

test("daily work deduplicates, missing KEK blocks key callback, replica cancel aborts", async () => {
  const { withProviderKey } = await import("../src/librarian/keys.ts");
  const { withRunSignal } = await import("../src/librarian/signals.ts");
  fence = (await claimRun(deps, { orgId, wikiId, owner: crypto.randomUUID(), daily: true }))!;
  let called = false;
  await expect(
    withProviderKey(deps, fence, async () => {
      called = true;
    }),
  ).rejects.toThrow();
  expect(called).toBe(false);
  await withRunSignal(
    deps,
    fence,
    async (signal) => {
      const aborted = new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      // Independent Deps object represents a different replica, sharing only persistent storage.
      await cancelRun({ ...deps }, orgId, fence.runId);
      await aborted;
      expect(signal.aborted).toBe(true);
    },
    50,
  );
  expect(await claimRun(deps, { orgId, wikiId, owner: crypto.randomUUID(), daily: true })).toBeNull();
});

test("ready inbox claims bind atomically and finish its status", async () => {
  const { librarianInbox } = await import("../src/db/schema.ts");
  const id = crypto.randomUUID();
  await deps.db.insert(librarianInbox).values({
    id,
    orgId,
    wikiId,
    submittedBy: personId,
    kind: "text",
    title: "Fixture",
    idempotencyKey: crypto.randomUUID(),
    payloadHash: "a".repeat(64),
    status: "ready",
    rawExpiresAt: new Date(clock.now().getTime() + 86400000),
  });
  const claims = await Promise.all(
    Array.from({ length: 4 }, () =>
      claimRun(deps, { orgId, wikiId, inboxId: id, owner: crypto.randomUUID() }),
    ),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  const claimed = claims.find(Boolean)!;
  const [item] = await deps.db.select().from(librarianInbox).where(eq(librarianInbox.id, id));
  expect(item?.runId).toBe(claimed.runId);
  expect(item?.status).toBe("running");
  await cancelRun(deps, orgId, claimed.runId);
  expect(await claimRun(deps, { orgId, wikiId, inboxId: id, owner: crypto.randomUUID() })).toBeNull();
});

test("proposal authorization, idempotency and competing human reviews", async () => {
  const { storeProposal, reviewProposal } = await import("../src/librarian/proposals.ts");
  fence = (await claimRun(deps, { orgId, wikiId, owner: crypto.randomUUID() }))!;
  const input = {
    proposalKey: crypto.randomUUID(),
    inputHash: "c".repeat(64),
    title: "Proposal",
    summary: "Fixture",
    markdown: "Untrusted fixture",
    sources: [],
  };
  const authorized = async () => {};
  const first = await storeProposal(deps, fence, input, authorized);
  expect(await storeProposal(deps, fence, input, authorized)).toEqual(first);
  await expect(
    storeProposal(deps, fence, input, async () => {
      throw new Error("hidden citation");
    }),
  ).rejects.toThrow();
  const reviews = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      reviewProposal(
        deps,
        {
          orgId,
          wikiId,
          proposalId: first.proposalId,
          personId,
          reject: true,
        },
        authorized,
        async () => {
          throw new Error("must not create on reject");
        },
      ),
    ),
  );
  expect(reviews.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  expect(reviews.filter((r) => r.status === "fulfilled" && !r.value.replay)).toHaveLength(1);
  await cancelRun(deps, orgId, fence.runId);
});

test("bulk synthetic KEK rotation verifies envelopes and model changes invalidate pricing", async () => {
  const { rotateAllProviderEnvelopes } = await import("../src/librarian/keys.ts");
  deps.env.librarianKekId = "v2";
  deps.env.librarianKekRing = JSON.stringify(
    Object.fromEntries([...ring.keys].map(([id, key]) => [id, key.toString("base64")])),
  );
  expect(await rotateAllProviderEnvelopes(deps)).toBe(1);
  expect(await rotateAllProviderEnvelopes(deps)).toBe(0);
  const [key] = await deps.db.select().from(librarianKeys).where(eq(librarianKeys.orgId, orgId));
  expect(key?.envelope.kekId).toBe("v2");
  const config = await loadSafeConfig(deps, orgId);
  await saveConfig(deps, orgId, personId, {
    expectedGeneration: config.generation,
    enabled: false,
    wikiIds: [wikiId],
    model: "new-unpriced-model",
    monthlyLimitMicrousd: 10000,
    runLimitMicrousd: 600,
  });
  const [saved] = await deps.db.select().from(librarianConfig).where(eq(librarianConfig.orgId, orgId));
  expect(saved?.rateCard).toBeNull();
});

test("retention clears raw data and aged receipts but keeps dedup tombstones", async () => {
  const { retainLibrarian, purgeSubmittedSources } = await import("../src/librarian/retention.ts");
  const { librarianInbox, librarianReceipts, librarianEvents } = await import("../src/db/schema.ts");
  const deleted: string[] = [];
  deps.bucket = {
    async *listAll() {},
    async deletePrefix(prefix: string) {
      deleted.push(prefix);
    },
  } as unknown as Deps["bucket"];
  const id = crypto.randomUUID();
  await deps.db.insert(librarianInbox).values({
    id,
    orgId,
    wikiId,
    submittedBy: personId,
    kind: "text",
    title: "Private",
    input: { kind: "text", title: "Private", text: "private raw input" },
    note: "private note",
    idempotencyKey: crypto.randomUUID(),
    payloadHash: "d".repeat(64),
    rawExpiresAt: new Date(clock.now().getTime() + 86400000),
  });
  await purgeSubmittedSources(deps, orgId, personId);
  const [cleared] = await deps.db.select().from(librarianInbox).where(eq(librarianInbox.id, id));
  expect(cleared?.input).toBeNull();
  expect(cleared?.note).toBeNull();
  expect(deleted).toContain(`librarian/${orgId}/${id}/`);
  clock.advance(91 * 86400000);
  await retainLibrarian(deps);
  expect(await deps.db.select().from(librarianReceipts)).toHaveLength(0);
  expect(await deps.db.select().from(librarianEvents)).toHaveLength(0);
  expect((await deps.db.select().from(librarianRuns)).length).toBeGreaterThan(0);
});
