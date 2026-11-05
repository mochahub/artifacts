import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  Artifact,
  type ArtifactCard,
  Home,
  ProjectArtifacts,
  ProjectRow,
  VersionRow,
} from "@artifacts/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { sha256 } from "../../src/auth/secrets.ts";
import { artifacts, decisions, people, threads, tokens, views } from "../../src/db/schema.ts";
import { claim, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { makePerson, publish } from "../publish-helper.ts";

describe("lists and artifacts", () => {
  let t: TestServer;
  let token: string;
  let personId: string;
  let member: string;
  let id: string;
  let orgId: string;
  const get = (path: string, bearer = token) => t.api(path, { bearer });

  beforeAll(async () => {
    t = await startTestServer();
    const owner = await claim(t);
    token = owner.token;
    personId = owner.person.id;
    await publish(t, token);
    await publish(t, token, { frameHash: "a".repeat(64) });
    await publish(t, token, { slug: "secret", visibility: "me" });
    id = (await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "roadmap")))[0]?.id as string;
    orgId = (await t.server.db.select().from(people))[0]?.orgId as string;
    member = await makePerson(t, orgId, "member");
  });
  afterAll(() => t.stop());

  test("home lists what's waiting, and a seen version stops waiting", async () => {
    const home = Home.parse(await (await get("/api/home")).json());
    expect(home.waiting.map((card) => card.slug).sort()).toEqual(["roadmap", "secret"]);
    const card = home.waiting.find((c) => c.slug === "roadmap") as ArtifactCard;
    expect(card).toMatchObject({
      latestVersion: 2,
      pageCount: 2,
      publishedBy: "Zahin",
      status: { kind: "waiting" },
    });
    expect(card.counts.changedFrames).toBe(1);
    expect(card.cover).toHaveProperty("renderHash");

    const seen = await t.api(`/api/artifacts/${id}/seen`, {
      method: "POST",
      bearer: token,
      json: { version: 2 },
    });
    expect(seen.status).toBe(200);
    const after = Home.parse(await (await get("/api/home")).json());
    expect(after.waiting.map((c) => c.slug)).toEqual(["secret"]);
    expect(after.recent.map((c) => c.slug)).toEqual(["roadmap"]);
  });

  test("a member doesn't see someone else's private artifact anywhere", async () => {
    const home = Home.parse(await (await get("/api/home", member)).json());
    expect(home.waiting.map((c) => c.slug)).toEqual(["roadmap"]);
    const list = ProjectArtifacts.parse(
      await (await get("/api/projects/camerabuddy/artifacts", member)).json(),
    );
    expect(list.artifacts.map((c) => c.slug)).toEqual(["roadmap"]);
    expect((await get("/api/artifacts/by-slug/camerabuddy/secret", member)).status).toBe(404);
  });

  test("projects: counts, search and sort", async () => {
    await t.server.db.insert(threads).values({
      id: Bun.randomUUIDv7(),
      orgId,
      artifactId: id,
      n: 1,
      pageKey: "mocks",
      createdVersion: 2,
      authorPersonId: personId,
      authorName: "Zahin",
    });
    const rows = z.array(ProjectRow).parse(await (await get("/api/projects")).json());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: "camerabuddy", artifactCount: 2, openCount: 1 });
    expect(await (await get("/api/projects?q=nothing")).json()).toEqual([]);
    expect(await (await t.api("/api/projects")).status).toBe(401);
  });

  test("a project's artifacts filter by status and search", async () => {
    const list = async (query: string) =>
      ProjectArtifacts.parse(
        await (await get(`/api/projects/camerabuddy/artifacts?${query}`)).json(),
      ).artifacts.map((c) => c.slug);
    expect((await list("sort=name")).sort()).toEqual(["roadmap", "secret"]);
    expect(await list("status=your_turn")).toEqual(["secret"]);
    expect(await list("q=zzz")).toEqual([]);
    expect((await get("/api/projects/none/artifacts")).status).toBe(404);
  });

  test("status follows the review", async () => {
    const status = async () => Artifact.parse(await (await get(`/api/artifacts/${id}`)).json()).status;
    const decide = (kind: "approved" | "changes_requested", version: number) =>
      t.server.db.insert(decisions).values({
        id: Bun.randomUUIDv7(),
        orgId,
        artifactId: id,
        version,
        personId,
        kind,
        createdAt: t.clock.now(),
      });
    expect((await status()).kind).toBe("not_reviewed");
    t.clock.advance(1000);
    await decide("changes_requested", 2);
    expect(await status()).toMatchObject({ kind: "with_agent", agent: "Zahin's agent" });
    t.clock.advance(1000);
    await publish(t, token, { frameHash: "b".repeat(64) });
    expect((await status()).kind).toBe("waiting");
    t.clock.advance(1000);
    await decide("approved", 3);
    expect(await status()).toEqual({ kind: "approved", version: 3 });
  });

  test("the artifact has pages, changes and permissions, and answers by slug", async () => {
    const body = Artifact.parse(await (await get("/api/artifacts/by-slug/camerabuddy/roadmap")).json());
    expect(body.id).toBe(id);
    expect(body.pages.map((p) => [p.key, p.changed, p.open])).toEqual([
      ["plan", false, 0],
      ["mocks", true, 1],
    ]);
    expect(body.permissions).toEqual({
      comment: true,
      decide: false, // This caller is a CLI token, and tokens never decide.
      manage: true,
      share: true,
      delete: true,
      purge: false,
    });
    const theirs = Artifact.parse(await (await get(`/api/artifacts/${id}`, member)).json());
    expect(theirs.permissions).toMatchObject({ comment: true, manage: false, delete: false });
    expect((await get(`/api/artifacts/${id}`, "art_nope")).status).toBe(401);
    expect((await t.api(`/api/artifacts/${id}`)).status).toBe(401);
    expect((await t.api("/api/artifacts/by-slug/camerabuddy/roadmap")).status).toBe(401);
  });

  test("no caller can't tell a real id from an unknown one", async () => {
    const real = await t.api(`/api/artifacts/${id}/versions`);
    const unknown = await t.api("/api/artifacts/00000000-0000-7000-8000-000000000000/versions");
    expect([real.status, unknown.status]).toEqual([401, 401]);
  });

  test("GETs carry an ETag, and a match answers 304", async () => {
    const first = await get(`/api/artifacts/${id}`);
    const etag = first.headers.get("etag") as string;
    expect(etag).toBeTruthy();
    const again = await t.api(`/api/artifacts/${id}`, { bearer: token, headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    // A proxy that compresses turns it weak, and a browser may send several.
    for (const header of [`W/${etag}`, `"other", ${etag}`, `W/"other", W/${etag}`, "*"]) {
      const match = await t.api(`/api/artifacts/${id}`, {
        bearer: token,
        headers: { "If-None-Match": header },
      });
      expect(match.status).toBe(304);
    }
    const other = await t.api(`/api/artifacts/${id}`, {
      bearer: token,
      headers: { "If-None-Match": '"other"' },
    });
    expect(other.status).toBe(200);
  });

  test("a deleted artifact: 410 for those who could see it, 404 for everyone else", async () => {
    const [secret] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "secret"));
    await t.server.db
      .update(artifacts)
      .set({ deletedAt: t.clock.now(), deletedBy: personId })
      .where(eq(artifacts.id, secret?.id as string));
    const gone = await get("/api/artifacts/by-slug/camerabuddy/secret");
    expect(gone.status).toBe(410);
    expect(JSON.stringify(await gone.json())).not.toContain("Zahin");
    expect((await get(`/api/artifacts/${secret?.id}`)).status).toBe(410);
    expect((await get("/api/artifacts/by-slug/camerabuddy/secret", member)).status).toBe(404);
    expect((await get(`/api/artifacts/${secret?.id}`, member)).status).toBe(404);
  });

  test("versions: the list, and one version's frames and blocks", async () => {
    const list = z.array(VersionRow).parse(await (await get(`/api/artifacts/${id}/versions`)).json());
    expect(list.map((v) => v.n)).toEqual([3, 2, 1]);
    expect(list[0]?.changes.frames).toBe(1);
    expect(list[0]?.decision).toBe("approved");
    const one = (await (await get(`/api/artifacts/${id}/versions/3`)).json()) as {
      pages: { key: string; frames?: { key: string; changed: boolean }[]; blocks?: { changed: boolean }[] }[];
    };
    expect(one.pages.find((p) => p.key === "mocks")?.frames?.[0]).toMatchObject({
      key: "live-view",
      changed: true,
    });
    expect(one.pages.find((p) => p.key === "plan")?.blocks?.[0]?.changed).toBe(false);
    expect((await get(`/api/artifacts/${id}/versions/9`)).status).toBe(404);
    expect((await get(`/api/artifacts/${id}/versions/x`)).status).toBe(404);
  });

  test("seen remembers a position per page, as a person", async () => {
    const cookie = await signIn(t, OWNER.email, OWNER.password);
    const response = await t.api(`/api/artifacts/${id}/seen`, {
      method: "POST",
      cookie,
      json: { version: 1, pageKey: "plan", position: { blockKey: "x" } },
    });
    expect(response.status).toBe(200);
    expect((await t.api(`/api/artifacts/${id}/seen`, { method: "POST", json: { version: 1 } })).status).toBe(
      401,
    );
  });

  test("seen keeps only real pages and small positions, and can't mark a future version", async () => {
    const cookie = await signIn(t, OWNER.email, OWNER.password);
    const seen = (json: unknown) => t.api(`/api/artifacts/${id}/seen`, { method: "POST", cookie, json });
    expect((await seen({ version: 99_999_999_999, pageKey: "made-up", position: { y: 1 } })).status).toBe(
      200,
    );
    expect((await seen({ version: 1, pageKey: "plan", position: { blob: "x".repeat(5000) } })).status).toBe(
      200,
    );
    expect((await seen({ version: 1, pageKey: "mocks", position: { y: 2 } })).status).toBe(200);
    const [row] = await t.server.db.select().from(views).where(eq(views.personId, personId));
    expect(row?.positions).toEqual({ plan: { blockKey: "x" }, mocks: { y: 2 } });
    const [art] = await t.server.db.select().from(artifacts).where(eq(artifacts.id, id));
    expect(row?.lastSeenVersion).toBeLessThanOrEqual(art?.latestVersion as number);
  });

  test("one org token's searches don't use up another's", async () => {
    const make = async (secret: string) => {
      await t.server.db.insert(tokens).values({
        id: Bun.randomUUIDv7(),
        orgId,
        kind: "org",
        name: secret,
        tokenHash: sha256(secret),
        scopes: ["read"],
        createdBy: personId,
      });
      return secret;
    };
    const busy = await make("art_org_busy_token");
    const quiet = await make("art_org_quiet_token");
    for (let i = 0; i < 60; i++) await get("/api/search?q=roadmap", busy);
    expect((await get("/api/search?q=roadmap", busy)).status).toBe(429);
    expect((await get("/api/search?q=roadmap", quiet)).status).toBe(200);
  });
});
