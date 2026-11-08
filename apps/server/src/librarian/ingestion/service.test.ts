import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase, testClock, testEnv } from "../../../test/helpers.ts";
import { connect } from "../../db/index.ts";
import { runMigrations } from "../../db/migrate.ts";
import { librarianInbox, librarianWikis, org, people, projects } from "../../db/schema.ts";
import type { Deps } from "../../deps.ts";
import { authorize, createUpload, enqueueSource, ownedInbox, type Submission, sha256 } from "./index.ts";

let database: Awaited<ReturnType<typeof createDatabase>>, connection: ReturnType<typeof connect>, deps: Deps;
const orgId = crypto.randomUUID(),
  ownerId = crypto.randomUUID(),
  wikiId = crypto.randomUUID();
const objects = new Map<string, Uint8Array>();
const clock = testClock(new Date("2026-11-07T00:00:00Z"));
const input: Submission = {
  orgId,
  wikiId,
  caller: {
    kind: "person",
    person: { id: ownerId, name: "QA", email: "qa@example.test", role: "owner" },
    sessionId: crypto.randomUUID(),
    recentAuth: true,
  },
};
beforeAll(async () => {
  database = await createDatabase();
  await runMigrations(database.url);
  connection = connect(database.url);
  deps = {
    db: connection.db,
    clock,
    env: testEnv(database.url),
    bucket: {
      put: async (key: string, bytes: string | Uint8Array) => {
        objects.set(key, typeof bytes === "string" ? Buffer.from(bytes) : bytes);
        return { etag: "fixture" };
      },
      head: async (key: string) => (objects.has(key) ? { size: objects.get(key)?.length } : null),
      getRange: async (key: string, from: number, to: number) =>
        objects.get(key)?.slice(from, to + 1) ?? null,
      presignPut: async () => ({ url: "https://storage.example.test/owned-ticket", headers: {} }),
    },
  } as unknown as Deps;
  await deps.db.insert(org).values({
    id: orgId,
    name: "Private QA",
    homeDomain: "example.test",
    settings: {},
    pseudonymKey: randomBytes(32),
  });
  await deps.db
    .insert(people)
    .values({ id: ownerId, orgId, name: "QA", email: "qa@example.test", role: "owner" });
  await deps.db.insert(projects).values({ id: wikiId, orgId, name: "Wiki", slug: "wiki", kind: "wiki" });
  await deps.db.insert(librarianWikis).values({ orgId, projectId: wikiId, selectedBy: ownerId });
});
afterAll(async () => {
  await connection?.close();
  await database?.drop();
});

test("concurrent enqueue is one item, replay preserves identity, payload/wiki mismatch conflicts while OFF", async () => {
  const request = {
    idempotencyKey: crypto.randomUUID(),
    source: { kind: "text", title: "Private source", text: "confidential source" },
  };
  const results = await Promise.all([
    enqueueSource(deps, input, request),
    enqueueSource(deps, input, request),
  ]);
  expect(results[0]?.item.id).toBe(results[1]?.item.id);
  expect(results.filter((r) => r.replay)).toHaveLength(1);
  await expect(enqueueSource(deps, input, { ...request, note: "changed" })).rejects.toThrow("already used");
  const other = crypto.randomUUID();
  await deps.db.insert(projects).values({ id: other, orgId, name: "Other", slug: "other", kind: "wiki" });
  await deps.db.insert(librarianWikis).values({ orgId, projectId: other, selectedBy: ownerId });
  await expect(enqueueSource(deps, { ...input, wikiId: other }, request)).rejects.toThrow("already used");
});
test("current permission and selection guard every detail; own item is hidden from another token", async () => {
  const result = await enqueueSource(deps, input, {
    idempotencyKey: crypto.randomUUID(),
    source: { kind: "text", title: "Private", text: "secret" },
  });
  await expect(
    ownedInbox(
      deps,
      {
        ...input,
        caller: {
          kind: "orgToken",
          tokenId: crypto.randomUUID(),
          createdBy: ownerId,
          scopes: ["publish"],
          projectIds: [wikiId],
        },
      },
      result.item.id,
    ),
  ).rejects.toThrow("Not found");
  await expect(authorize(deps, { ...input, caller: { kind: "anonymous" } })).rejects.toThrow("Not found");
  await deps.db.delete(librarianWikis).where(eq(librarianWikis.projectId, wikiId));
  await expect(ownedInbox(deps, input, result.item.id)).rejects.toThrow("Not found");
  await deps.db.insert(librarianWikis).values({ orgId, projectId: wikiId, selectedBy: ownerId });
});
test("file tickets enforce completion, byte hash/size, owner, expiry, and replay after ticket expiry", async () => {
  const bytes = Buffer.from("document");
  const upload = await createUpload(deps, input, {
    name: "source.txt",
    size: bytes.length,
    contentType: "text/plain",
    sha256: sha256(bytes),
  });
  const request = {
    idempotencyKey: crypto.randomUUID(),
    source: { kind: "file", uploadId: upload.uploadId },
  };
  await expect(enqueueSource(deps, input, request)).rejects.toThrow("incomplete");
  const key = `librarian/${orgId}/${upload.uploadId}/original`;
  objects.set(key, Buffer.from("tampered"));
  await expect(enqueueSource(deps, input, request)).rejects.toThrow("verification");
  objects.set(key, bytes);
  const accepted = await enqueueSource(deps, input, request);
  expect(accepted.item.kind).toBe("file");
  clock.advance(16 * 60_000);
  expect((await enqueueSource(deps, input, request)).replay).toBe(true);
  const rows = await deps.db.select().from(librarianInbox).where(eq(librarianInbox.id, accepted.item.id));
  expect(rows[0]?.quarantineKey).toBe(key);
});
