import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { librarianProposals, librarianRuns, projects } from "../src/db/schema.ts";
import { claim, code, json, OWNER, signIn, startTestServer } from "./helpers.ts";

test("librarian admin API: CSRF, recent auth, safe config, write-only rotation, generation and OFF", async () => {
  const t = await startTestServer({
    LIBRARIAN_KEK_ID: "qa-v1",
    LIBRARIAN_KEK_RING: JSON.stringify({ "qa-v1": randomBytes(32).toString("base64") }),
  });
  try {
    const setup = await claim(t);
    const cookie = await signIn(t, OWNER.email, OWNER.password);
    expect((await t.api("/api/librarian/config")).status).toBe(401);
    expect((await t.api("/api/librarian/config", { bearer: setup.token })).status).toBe(403);
    const config = await t.api("/api/librarian/config", { cookie });
    expect(config.status).toBe(200);
    expect(config.headers.get("cache-control")).toBe("no-store");
    expect(await json(config)).toMatchObject({
      enabled: false,
      generation: 0,
      keyConfigured: false,
      monthlyLimitMicrousd: 0,
    });
    const edit = {
      expectedGeneration: 0,
      enabled: false,
      wikiIds: [],
      model: "claude-sonnet-5-5",
      monthlyLimitMicrousd: 1000,
      runLimitMicrousd: 100,
    };
    expect(
      (
        await t.api("/api/librarian/config", {
          cookie,
          method: "PUT",
          headers: { Origin: "https://evil.test" },
          json: edit,
        })
      ).status,
    ).toBe(403);
    expect((await t.api("/api/librarian/config", { cookie, method: "PUT", json: edit })).status).toBe(200);
    expect((await t.api("/api/librarian/config", { cookie, method: "PUT", json: edit })).status).toBe(409);
    const synthetic = "synthetic-credential-never-disclose";
    const key = await t.api("/api/librarian/key", {
      cookie,
      method: "PUT",
      json: { key: synthetic, expectedGeneration: 1 },
    });
    expect(key.status).toBe(204);
    expect(await key.text()).toBe("");
    const safe = await t.api("/api/librarian/config", { cookie });
    const body = await json(safe);
    expect(body).toMatchObject({ enabled: false, generation: 2, keyConfigured: true, keyGeneration: 2 });
    expect(JSON.stringify(body)).not.toContain(synthetic);
    const invalid = await t.api("/api/librarian/key", {
      cookie,
      method: "PUT",
      json: { key: synthetic, expectedGeneration: 2, [synthetic]: true },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain(synthetic);
    expect(
      (await t.api("/api/librarian/key", { cookie, method: "DELETE", json: { expectedGeneration: 2 } }))
        .status,
    ).toBe(204);
    expect(await json(await t.api("/api/librarian/runs", { cookie }))).toEqual({ runs: [] });
    const wiki = await t.api("/api/wikis", {
      cookie,
      method: "POST",
      json: { slug: "proposal-qa", name: "Proposal QA" },
    });
    expect(wiki.status).toBe(201);
    const proposalPath = `/api/wikis/proposal-qa/proposals/${crypto.randomUUID()}`;
    expect((await t.api(proposalPath, { cookie })).status).toBe(404);
    expect(
      (await t.api(`${proposalPath}/reject`, { cookie, method: "POST", json: { expectedStatus: "open" } }))
        .status,
    ).toBe(404);
    expect(
      (
        await t.api(`${proposalPath}/create`, {
          cookie,
          method: "POST",
          json: { expectedStatus: "open", requestId: crypto.randomUUID() },
        })
      ).status,
    ).toBe(404);
    const db = t.server.deps.db;
    const [wikiRow] = await db.select().from(projects).where(eq(projects.slug, "proposal-qa"));
    if (!wikiRow) throw new Error("missing wiki fixture");
    const runId = crypto.randomUUID(),
      proposalId = crypto.randomUUID();
    await db.insert(librarianRuns).values({
      id: runId,
      orgId: setup.orgId,
      wikiId: wikiRow.id,
      state: "waiting_human",
      model: "fixture",
      configGeneration: 0,
      rateCard: { input: "1", output: "1" },
      owner: crypto.randomUUID(),
      fence: 1,
      leaseExpiresAt: t.clock.now(),
      deadline: t.clock.now(),
      month: "2026-11",
      cap: 0n,
      reserved: 0n,
      startedAt: t.clock.now(),
    });
    await db.insert(librarianProposals).values({
      id: proposalId,
      orgId: setup.orgId,
      wikiId: wikiRow.id,
      runId,
      proposalKey: crypto.randomUUID(),
      title: "Review fixture",
      summary: "Untrusted",
      markdown: "Fixture",
      sources: [],
    });
    const reviewPath = `/api/wikis/proposal-qa/proposals/${proposalId}`;
    expect((await t.api(reviewPath, { cookie })).status).toBe(200);
    expect((await t.api(reviewPath, { bearer: setup.token })).status).toBe(404);
    const requestId = crypto.randomUUID();
    const creations = await Promise.all(
      [1, 2].map(() =>
        t.api(`${reviewPath}/create`, {
          cookie,
          method: "POST",
          json: { expectedStatus: "open", requestId },
        }),
      ),
    );
    expect(creations.map((r) => r.status).sort()).toEqual([200, 201]);
    const created = await json(creations[0]!);
    expect(created.artifactId).toBeTruthy();
    expect((await json(await t.api(reviewPath, { cookie }))).status).toBe("created");
    // Independent open proposal exercises rejection races.
    await db
      .update(librarianProposals)
      .set({ status: "open", createdArtifactId: null })
      .where(eq(librarianProposals.id, proposalId));
    expect(
      (
        await t.api(`${reviewPath}/reject`, {
          cookie,
          method: "POST",
          headers: { Origin: "https://evil.test" },
          json: { expectedStatus: "open" },
        })
      ).status,
    ).toBe(403);
    const rejects = await Promise.all(
      [1, 2].map(() =>
        t.api(`${reviewPath}/reject`, { cookie, method: "POST", json: { expectedStatus: "open" } }),
      ),
    );
    expect(rejects.map((r) => r.status)).toEqual([200, 200]);
    await db
      .update(librarianProposals)
      .set({ sources: [crypto.randomUUID()] })
      .where(eq(librarianProposals.id, proposalId));
    expect((await t.api(reviewPath, { cookie })).status).toBe(404);
    const id = crypto.randomUUID();
    expect((await t.api(`/api/librarian/runs/${id}`, { cookie })).status).toBe(404);
    expect((await t.api(`/api/librarian/runs/${id}/cancel`, { cookie, method: "POST" })).status).toBe(200);
    expect((await t.api(`/api/librarian/runs/${id}/events`, { cookie })).status).toBe(404);
    expect(
      (
        await t.api("/api/librarian/provision", {
          cookie,
          method: "PUT",
          json: {
            expectedGeneration: 3,
            model: "fixture-model",
            rateCard: { input: "2000000", output: "10000000" },
          },
        })
      ).status,
    ).toBe(200);
    const provisioned = await json(await t.api("/api/librarian/config", { cookie }));
    expect(provisioned).toMatchObject({ generation: 4, enabled: false });
    expect(JSON.stringify(provisioned)).not.toContain("tokenHash");
    t.clock.advance(600_001);
    expect(await code(await t.api("/api/librarian/config", { cookie }))).toBe("recent_auth_required");
  } finally {
    await t.stop();
  }
});

test("OFF inbox routes queue idempotently and guard selected wiki ownership", async () => {
  const { librarianConfig, librarianWikis, projects } = await import("../src/db/schema.ts");
  const t = await startTestServer();
  try {
    const setup = await claim(t);
    const cookie = await signIn(t, OWNER.email, OWNER.password);
    const wikiId = crypto.randomUUID();
    await t.server.deps.db
      .insert(projects)
      .values({ id: wikiId, orgId: setup.orgId, slug: "inbox-fixture", name: "Inbox fixture", kind: "wiki" });
    await t.server.deps.db.insert(librarianConfig).values({ orgId: setup.orgId });
    await t.server.deps.db.insert(librarianWikis).values({ orgId: setup.orgId, projectId: wikiId });
    const base = "/api/wikis/inbox-fixture/inbox";
    const request = {
      idempotencyKey: crypto.randomUUID(),
      source: { kind: "text", title: "Fixture", text: "Untrusted source" },
    };
    const first = await t.api(base, { cookie, method: "POST", json: request });
    expect(first.status).toBe(202);
    const item = (await json(first)) as { id: string; message: string };
    expect(item.message).toBe("Saved to inbox. Librarian is off.");
    expect((await t.api(base, { cookie, method: "POST", json: request })).status).toBe(200);
    expect(
      (await t.api(base, { cookie, method: "POST", json: { ...request, note: "changed" } })).status,
    ).toBe(409);
    expect((await t.api(base, { cookie })).status).toBe(200);
    const detail = await json(await t.api(`${base}/${item.id}`, { cookie }));
    expect(JSON.stringify(detail)).not.toContain("Untrusted source");
    expect((await t.api(`${base}/${item.id}/cancel`, { cookie, method: "POST" })).status).toBe(200);
    expect(
      (
        await t.api(`${base}/uploads`, {
          cookie,
          method: "POST",
          json: { name: "fixture.txt", size: 4, contentType: "text/plain", sha256: "a".repeat(64) },
        })
      ).status,
    ).toBe(201);
    expect((await t.api("/api/wikis/missing/inbox", { cookie })).status).toBe(404);
  } finally {
    await t.stop();
  }
});
