import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import {
  activity,
  artifacts,
  comments,
  frames,
  guestLinks,
  people,
  shareLinks,
  threads,
  tombstones,
  versions,
} from "../../src/db/schema.ts";
import { purgeArtifact } from "../../src/jobs/purge.ts";
import { claim, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { file, hash, makePerson, publish } from "../publish-helper.ts";

const OPS = "o".repeat(64);
const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe("lifecycle", () => {
  let t: TestServer;
  let token: string;
  let cookie: string;
  let orgId: string;
  let personId: string;
  let member: string;
  let slugs = 0;

  const fresh = async (visibility: "me" | "org" = "org") => {
    slugs += 1;
    const slug = `art-${slugs}`;
    expect((await publish(t, token, { slug, visibility, frameHash: hash(slug) })).status).toBe(200);
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, slug));
    return row as typeof artifacts.$inferSelect;
  };
  const post = (path: string, auth: { cookie?: string; bearer?: string } = { cookie }, json?: unknown) =>
    t.api(path, { method: "POST", json, ...auth });
  const job = (name: string) =>
    fetch(`http://127.0.0.1:${t.server.ports.internal}/internal/jobs/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPS}` },
    });

  beforeAll(async () => {
    t = await startTestServer();
    const made = await claim(t);
    token = made.token;
    personId = made.person.id;
    cookie = await signIn(t, OWNER.email, OWNER.password);
    orgId = (await t.server.db.select().from(people))[0]?.orgId as string;
    member = await makePerson(t, orgId, "member");
  });
  afterAll(() => t.stop());

  test("archive: read-only, links work, hidden from lists, undone by unarchive", async () => {
    const row = await fresh();
    expect((await post(`/api/artifacts/${row.id}/archive`, { bearer: member })).status).toBe(403);
    expect((await post(`/api/artifacts/${row.id}/archive`, { bearer: token })).status).toBe(200);
    expect((await t.api(`/api/artifacts/${row.id}`, { bearer: token })).status).toBe(200);
    expect(await code(await publish(t, token, { slug: row.slug }))).toBe("read_only");
    const home = (await (await t.api("/api/home", { bearer: token })).json()) as {
      waiting: { id: string }[];
    };
    expect(home.waiting.map((card) => card.id)).not.toContain(row.id);
    const archived = (await (
      await t.api("/api/projects/camerabuddy/artifacts?status=archived", { bearer: token })
    ).json()) as { artifacts: { id: string }[] };
    expect(archived.artifacts.map((card) => card.id)).toContain(row.id);
    expect((await post(`/api/artifacts/${row.id}/unarchive`, { bearer: token })).status).toBe(200);
    expect((await publish(t, token, { slug: row.slug })).status).toBe(200);
  });

  test("through the app, only pictures come out, as downloads (?via=app)", async () => {
    // A publisher chooses each file's type, so a page of theirs must never be served from this origin.
    const page = file("page.html", "<script src=/x.js></script>", "text/html");
    expect((await publish(t, token, { slug: "via-app", extra: [page] })).status).toBe(200);
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "via-app"));
    const read = (blob: string) =>
      t.api(`/api/artifacts/${row?.id}/r/${blob}?via=app`, { cookie, redirect: "manual" });
    expect((await read(page.sha256)).status).toBe(302);

    const [made] = await t.server.db
      .select()
      .from(versions)
      .where(eq(versions.artifactId, row?.id as string));
    const [frame] = await t.server.db
      .select()
      .from(frames)
      .where(eq(frames.versionId, made?.id as string));
    const render = (frame as { renders: { "2x": string } }).renders["2x"];
    const image = await read(render);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/webp");
    expect(image.headers.get("content-disposition")).toBe("attachment");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");

    // A picture whose stored type says otherwise goes by the redirect too.
    await t.server.bucket.put(`blobs/${render}`, "<script>1</script>", { contentType: "text/html" });
    expect((await read(render)).status).toBe(302);
  });

  test("a version number that isn't a number the database can hold is a 400", async () => {
    const row = await fresh();
    for (const path of [
      `/api/artifacts/${row.id}/compare?from=x&to=1`,
      `/api/artifacts/${row.id}/compare?from=1&to=99999999999`,
      `/api/artifacts/${row.id}/versions/99999999999`,
      `/api/artifacts/${row.id}/v/99999999999/article/plan`,
    ]) {
      expect((await t.api(path, { bearer: token })).status).toBe(400);
    }
  });

  test("delete: links stop, the slug stays taken, and an agent can undo it", async () => {
    const row = await fresh("me");
    const { url } = (await (
      await post(`/api/artifacts/${row.id}/links`, { bearer: token }, { permission: "view" })
    ).json()) as { url: string };
    const deleted = await post(`/api/artifacts/${row.id}/delete`, { bearer: token });
    expect(deleted.status).toBe(200);
    const { purgeAfter } = (await deleted.json()) as { purgeAfter: string };
    expect(new Date(purgeAfter).getTime() - t.clock.now().getTime()).toBe(30 * 24 * 3600_000);

    expect((await t.api(`/api/artifacts/${row.id}`, { bearer: token })).status).toBe(410);
    expect((await t.api(`/api/artifacts/${row.id}`, { bearer: member })).status).toBe(404);
    expect((await t.api(`/api/s/${url.split("/s/")[1]}`)).status).toBe(410);
    expect(await code(await publish(t, token, { slug: row.slug }))).toBe("slug_deleted");
    expect(await code(await publish(t, member, { slug: row.slug }))).toBe("conflict");
    expect((await post(`/api/artifacts/${row.id}/archive`, { bearer: token })).status).toBe(404);

    const list = (await (await t.api("/api/deleted", { bearer: token })).json()) as {
      artifact: { id: string };
    }[];
    expect(list.map((entry) => entry.artifact.id)).toContain(row.id);
    const theirs = (await (await t.api("/api/deleted", { bearer: member })).json()) as unknown[];
    expect(theirs).toEqual([]);

    expect((await post(`/api/artifacts/${row.id}/undelete`, { bearer: member })).status).toBe(404);
    expect((await post(`/api/artifacts/${row.id}/undelete`, { bearer: token })).status).toBe(200);
    expect((await t.api(`/api/artifacts/${row.id}`, { bearer: token })).status).toBe(200);
    expect((await t.api(`/api/s/${url.split("/s/")[1]}`)).status).toBe(200);
    expect((await post(`/api/artifacts/${row.id}/undelete`, { bearer: token })).status).toBe(409);
  });

  test("purge: a person with a recent sign-in, only from Recently deleted, and it frees the slug", async () => {
    const row = await fresh();
    const made = await t.api(`/api/artifacts/${row.id}/threads`, {
      method: "POST",
      bearer: token,
      json: { pageKey: "plan", anchor: null, body: "Hi", version: 1 },
    });
    const thread = (await made.json()) as { id: string };
    await t.server.bucket.put(`data/${row.id}/shared/votes`, "{}");
    await post(`/api/artifacts/${row.id}/links`, { bearer: token }, { permission: "view" });

    expect(await code(await t.api(`/api/artifacts/${row.id}`, { method: "DELETE", cookie }))).toBe(
      "conflict",
    );
    await post(`/api/artifacts/${row.id}/delete`, { bearer: token });
    expect((await t.api(`/api/artifacts/${row.id}`, { method: "DELETE", bearer: token })).status).toBe(404);
    t.clock.advance(11 * 60_000);
    expect(await code(await t.api(`/api/artifacts/${row.id}`, { method: "DELETE", cookie }))).toBe(
      "recent_auth_required",
    );
    cookie = await signIn(t, OWNER.email, OWNER.password);
    expect((await t.api(`/api/artifacts/${row.id}`, { method: "DELETE", cookie })).status).toBe(200);

    const db = t.server.db;
    expect(await db.select().from(artifacts).where(eq(artifacts.id, row.id))).toEqual([]);
    expect(await db.select().from(versions).where(eq(versions.artifactId, row.id))).toEqual([]);
    expect(await db.select().from(threads).where(eq(threads.id, thread.id))).toEqual([]);
    expect(await db.select().from(comments).where(eq(comments.threadId, thread.id))).toEqual([]);
    expect(await db.select().from(shareLinks).where(eq(shareLinks.artifactId, row.id))).toEqual([]);
    expect(await db.select().from(activity).where(eq(activity.artifactId, row.id))).toEqual([]);
    const lines = await db.select().from(tombstones).where(eq(tombstones.slug, row.slug));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "artifact", title: "Roadmap" });
    expect(await t.server.bucket.head(`data/${row.id}/shared/votes`)).toBeNull();
    expect((await publish(t, token, { slug: row.slug })).status).toBe(200);
  });

  test("the purge job takes only what's past its 30 days", async () => {
    const old = await fresh();
    await post(`/api/artifacts/${old.id}/delete`, { bearer: token });
    t.clock.advance(15 * 24 * 3600_000);
    const recent = await fresh();
    await post(`/api/artifacts/${recent.id}/delete`, { bearer: token });
    t.clock.advance(16 * 24 * 3600_000);
    expect((await job("purge")).status).toBe(200);
    const ids = (await t.server.db.select().from(artifacts)).map((row) => row.id);
    expect(ids).not.toContain(old.id);
    expect(ids).toContain(recent.id);
    await post(`/api/artifacts/${recent.id}/undelete`, { bearer: token });
    cookie = await signIn(t, OWNER.email, OWNER.password);
  });

  test("a single version: not the latest, threads move on, and it can come back", async () => {
    const row = await fresh();
    await publish(t, token, { slug: row.slug, frameHash: hash("v2") });
    await publish(t, token, { slug: row.slug, frameHash: hash("v3") });
    const made = await t.api(`/api/artifacts/${row.id}/threads`, {
      method: "POST",
      bearer: token,
      json: {
        pageKey: "mocks",
        anchor: { type: "frame", frameKey: "live-view", x: 0.5, y: 0.5 },
        body: "Hi",
        version: 2,
      },
    });
    const thread = (await made.json()) as { id: string };

    expect((await post(`/api/artifacts/${row.id}/versions/3/delete`, { bearer: token })).status).toBe(409);
    expect((await post(`/api/artifacts/${row.id}/versions/2/delete`, { bearer: token })).status).toBe(200);
    const [moved] = await t.server.db.select().from(threads).where(eq(threads.id, thread.id));
    expect(moved).toMatchObject({ createdVersion: 3, movedFromVersion: 2 });
    expect((await t.api(`/api/artifacts/${row.id}/versions/2`, { bearer: token })).status).toBe(404);
    const list = (await (await t.api(`/api/artifacts/${row.id}/versions`, { bearer: token })).json()) as {
      n: number;
    }[];
    expect(list.map((v) => v.n)).toEqual([3, 1]);

    expect((await post(`/api/artifacts/${row.id}/versions/2/undelete`, { bearer: token })).status).toBe(200);
    await post(`/api/artifacts/${row.id}/versions/2/delete`, { bearer: token });
    expect(
      (await t.api(`/api/artifacts/${row.id}/versions/2`, { method: "DELETE", bearer: token })).status,
    ).toBe(403);
    expect((await t.api(`/api/artifacts/${row.id}/versions/2`, { method: "DELETE", cookie })).status).toBe(
      200,
    );
    expect((await t.api(`/api/artifacts/${row.id}/versions/1`, { method: "DELETE", cookie })).status).toBe(
      409,
    );

    // Numbers are never reused.
    const next = (await (await publish(t, token, { slug: row.slug, frameHash: hash("v4") })).json()) as {
      version: number;
    };
    expect(next.version).toBe(4);
  });

  test("purging a removed version takes its crops and quotes with it", async () => {
    const png = await sharp({ create: { width: 786, height: 1704, channels: 4, background: "#20232a" } })
      .webp()
      .toBuffer();
    const row = await fresh();
    await publish(t, token, { slug: row.slug, frameHash: hash(`crop-${row.slug}`), renderBytes: png });
    await publish(t, token, { slug: row.slug, frameHash: hash(`next-${row.slug}`) });
    const threadOn = async (anchor: unknown, pageKey: string) =>
      (await (
        await t.api(`/api/artifacts/${row.id}/threads`, {
          method: "POST",
          bearer: token,
          json: { pageKey, anchor, body: "A secret", version: 2 },
        })
      ).json()) as { id: string; crop: string | null };
    const pin = await threadOn({ type: "frame", frameKey: "live-view", x: 0.5, y: 0.5 }, "mocks");
    const quote = await threadOn(
      { type: "text", blockKey: "intro/p1", quote: { exact: "Hello", prefix: "", suffix: "" } },
      "plan",
    );
    expect(pin.crop).not.toBeNull();
    await post(`/api/artifacts/${row.id}/versions/2/delete`, { bearer: token });
    const listed = (await (await t.api(`/api/artifacts/${row.id}/threads`, { bearer: token })).json()) as {
      id: string;
      anchorState: string;
      createdVersion: number;
    }[];
    expect(listed.find((entry) => entry.id === quote.id)).toMatchObject({
      createdVersion: 3,
      anchorState: "moved_version",
    });

    // A publish in between must not lose track of them.
    await publish(t, token, { slug: row.slug, frameHash: hash(`again-${row.slug}`) });
    expect((await t.api(`/api/artifacts/${row.id}/versions/2`, { method: "DELETE", cookie })).status).toBe(
      200,
    );
    const [pinned] = await t.server.db.select().from(threads).where(eq(threads.id, pin.id));
    expect(pinned?.cropKey).toBeNull();
    expect(await t.server.bucket.head(`crops/${pin.id}.webp`)).toBeNull();
    const [quoted] = await t.server.db.select().from(threads).where(eq(threads.id, quote.id));
    expect(quoted?.anchor).toEqual({ type: "block", blockKey: "intro/p1" });
  });

  test("a deleted artifact's history stays in Activity", async () => {
    const row = await fresh();
    await post(`/api/artifacts/${row.id}/delete`, { bearer: token });
    const { items } = (await (await t.api("/api/activity", { bearer: token })).json()) as {
      items: { kind: string; artifact: { slug: string } | null }[];
    };
    expect(items.some((item) => item.kind === "deleted" && item.artifact?.slug === row.slug)).toBe(true);
    await post(`/api/artifacts/${row.id}/undelete`, { bearer: token });
  });

  test("a purge that lost a race with a restore does nothing", async () => {
    const row = await fresh();
    await post(`/api/artifacts/${row.id}/delete`, { bearer: token });
    const [stale] = await t.server.db.select().from(artifacts).where(eq(artifacts.id, row.id));
    await post(`/api/artifacts/${row.id}/undelete`, { bearer: token });
    expect(await purgeArtifact(t.server.deps, stale as typeof artifacts.$inferSelect, null)).toBe(false);
    expect((await t.api(`/api/artifacts/${row.id}`, { bearer: token })).status).toBe(200);
  });

  test("agents' lifecycle actions are marked as theirs", async () => {
    const row = await fresh();
    await t.api(`/api/artifacts/${row.id}/archive`, {
      method: "POST",
      bearer: token,
      headers: { "Artifacts-Agent": "Claude Code" },
    });
    const { items } = (await (await t.api("/api/activity?filter=agents", { bearer: token })).json()) as {
      items: { kind: string; actor: string }[];
    };
    expect(items[0]).toMatchObject({ kind: "archived", actor: "Claude Code" });
  });

  test("restore publishes a copy, which re-anchors threads", async () => {
    const row = await fresh();
    await publish(t, token, { slug: row.slug, frameHash: hash("changed") });
    const made = await t.api(`/api/artifacts/${row.id}/threads`, {
      method: "POST",
      bearer: token,
      json: {
        pageKey: "mocks",
        anchor: { type: "frame", frameKey: "live-view", x: 0.5, y: 0.5 },
        body: "Hi",
        version: 2,
      },
    });
    const thread = (await made.json()) as { id: string };
    expect((await post(`/api/artifacts/${row.id}/versions/1/restore`, { bearer: member })).status).toBe(403);
    const restored = await post(`/api/artifacts/${row.id}/versions/1/restore`, { bearer: token });
    expect(await restored.json()).toEqual({ n: 3 });
    const [v3] = await t.server.db
      .select()
      .from(versions)
      .where(eq(versions.artifactId, row.id))
      .orderBy(versions.n);
    expect(v3?.n).toBe(1);
    const all = await t.server.db.select().from(versions).where(eq(versions.artifactId, row.id));
    expect(all.find((v) => v.n === 3)).toMatchObject({ restoredFrom: 1, message: "Restored v1" });
    const copied = await t.server.db
      .select()
      .from(frames)
      .where(eq(frames.versionId, all.find((v) => v.n === 3)?.id as string));
    expect(copied).toHaveLength(1);
    const [anchored] = await t.server.db.select().from(threads).where(eq(threads.id, thread.id));
    expect(anchored?.anchorState).toBe("updated");
    const compare = await t.api(`/api/artifacts/${row.id}/compare?from=2&to=3`, { bearer: token });
    expect(((await compare.json()) as { frames: { changed: string[] } }).frames.changed).toEqual([
      "mocks/live-view",
    ]);
    expect((await t.api(`/api/artifacts/${row.id}/compare?from=2&to=9`, { bearer: token })).status).toBe(404);
  });

  test("naming a version", async () => {
    const row = await fresh();
    const name = (json: unknown, bearer = token) =>
      t.api(`/api/artifacts/${row.id}/versions/1`, { method: "PATCH", bearer, json });
    expect((await name({ name: "Real photos" })).status).toBe(200);
    expect((await name({ name: "x" }, member)).status).toBe(403);
    expect((await name({ name: 5 })).status).toBe(400);
    const [version] = await t.server.db.select().from(versions).where(eq(versions.artifactId, row.id));
    expect(version?.name).toBe("Real photos");
  });

  test("activity: filters, and never shows a private artifact to someone else", async () => {
    const secret = await fresh("me");
    await post(`/api/artifacts/${secret.id}/archive`, { bearer: token });
    const mine = (await (await t.api("/api/activity", { bearer: token })).json()) as {
      items: { kind: string; artifact: { slug: string } | null }[];
    };
    expect(mine.items.some((item) => item.kind === "archived" && item.artifact?.slug === secret.slug)).toBe(
      true,
    );
    const theirs = (await (await t.api("/api/activity", { bearer: member })).json()) as {
      items: { artifact: { slug: string } | null }[];
    };
    expect(theirs.items.some((item) => item.artifact?.slug === secret.slug)).toBe(false);
    const agents = (await (await t.api("/api/activity?filter=agents", { bearer: token })).json()) as {
      items: { agent: string | null }[];
    };
    expect(agents.items.every((item) => item.agent !== null)).toBe(true);
    const people_ = (await (await t.api("/api/activity?filter=people", { bearer: token })).json()) as {
      items: unknown[];
    };
    expect(people_.items.length).toBeGreaterThan(0);
    expect((await t.api("/api/activity")).status).toBe(401);
  });

  test("expire clears leftovers, and the job needs the secret", async () => {
    expect((await job("expire")).status).toBe(200);
    const denied = await fetch(`http://127.0.0.1:${t.server.ports.internal}/internal/jobs/gc`, {
      method: "POST",
    });
    expect(denied.status).toBe(401);
    expect((await job("nothing")).status).toBe(404);
    expect(personId).toBeTruthy();
    expect(await t.server.db.select().from(guestLinks)).toEqual([]);
  });
});

// Its own server: GC compares bucket timestamps with the clock, so the clock can't have been moved yet.
describe("garbage collection", () => {
  let t: TestServer;
  let token: string;
  const gc = async () => {
    const response = await fetch(`http://127.0.0.1:${t.server.ports.internal}/internal/jobs/gc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPS}` },
    });
    return ((await response.json()) as { result: { deleted: number } }).result;
  };

  beforeAll(async () => {
    t = await startTestServer();
    token = (await claim(t)).token;
  });
  afterAll(() => t.stop());

  test("keeps what's used, what's young, and what a removed version needs; deletes the rest", async () => {
    const unique = Bun.randomUUIDv7();
    await publish(t, token, { slug: "keep", frameHash: hash(unique) });
    await publish(t, token, { slug: "keep", frameHash: hash(`${unique}2`) });
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "keep"));
    const all = await t.server.db
      .select()
      .from(versions)
      .where(eq(versions.artifactId, row?.id as string));
    const first = all.find((v) => v.n === 1);
    const used = Object.values(first?.files as Record<string, { hash: string }>).map((entry) => entry.hash);
    const [frame] = await t.server.db
      .select()
      .from(frames)
      .where(eq(frames.versionId, first?.id as string));
    const render = (frame as unknown as { renders: { "1x": string } }).renders["1x"];
    await t.api(`/api/artifacts/${row?.id}/versions/1/delete`, { method: "POST", bearer: token });

    const orphan = file("orphan.bin", `orphan ${unique}`);
    await t.server.bucket.put(`blobs/${orphan.sha256}`, orphan.body);

    await gc();
    expect(await t.server.bucket.head(`blobs/${orphan.sha256}`)).not.toBeNull();

    t.clock.advance(25 * 3600_000);
    expect((await gc()).deleted).toBeGreaterThan(0);
    expect(await t.server.bucket.head(`blobs/${orphan.sha256}`)).toBeNull();
    for (const hashed of [...used, render]) {
      expect(await t.server.bucket.head(`blobs/${hashed}`)).not.toBeNull();
    }

    // The sweep: what a failed purge left in the bucket, with nothing in Postgres pointing at it.
    const ghost = Bun.randomUUIDv7();
    await t.server.bucket.put(`data/${ghost}/shared/x`, "{}");
    await t.server.bucket.put(`crops/${ghost}.webp`, "x");
    t.clock.advance(25 * 3600_000);
    await gc();
    expect(await t.server.bucket.head(`data/${ghost}/shared/x`)).toBeNull();
    expect(await t.server.bucket.head(`crops/${ghost}.webp`)).toBeNull();
  });
});
