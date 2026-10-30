import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PublishPrepared, PublishResult } from "@artifacts/schema";
import { eq } from "drizzle-orm";
import { sha256 } from "../../src/auth/secrets.ts";
import { artifacts, people, projects, tokens } from "../../src/db/schema.ts";
import { claim, startTestServer, type TestServer } from "../helpers.ts";

const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const file = (path: string, body: string, type = "text/html") => ({
  path,
  body,
  sha256: hash(body),
  size: Buffer.byteLength(body),
  type,
});
const error = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

/** A minimal publish, the way the CLI does it: prepare, upload what's missing, commit. */
export async function publish(
  t: TestServer,
  bearer: string,
  options: {
    project?: string;
    slug?: string;
    files?: ReturnType<typeof file>[];
    frameHash?: string;
    visibility?: "me" | "org";
    extra?: ReturnType<typeof file>[];
    tamper?: string;
  } = {},
) {
  const { project = "camerabuddy", slug = "roadmap", frameHash = hash("frame"), visibility } = options;
  const page = file("index.html", `<h1>${frameHash}</h1>`);
  const article = file(
    "__articles/plan.html",
    '<p data-block="intro/p1" onclick="x()">Hello<script>1</script></p>',
  );
  const render = file("__renders/a.webp", `render-${frameHash}`, "image/webp");
  const files = [...(options.files ?? [page, article, render]), ...(options.extra ?? [])];
  const prepared = await t.api("/api/publish/prepare", {
    method: "POST",
    bearer,
    json: { project, slug, title: "Roadmap", visibility, files: files.map(({ body: _, ...rest }) => rest) },
  });
  if (prepared.status !== 200) return prepared;
  const ready = PublishPrepared.parse(await prepared.json());
  for (const missing of ready.missing) {
    const source = files.find((f) => f.sha256 === missing.sha256);
    const upload = await fetch(missing.url, {
      method: "PUT",
      headers: missing.headers,
      body: options.tamper === missing.sha256 ? "x".repeat(source?.size ?? 0) : source?.body,
    });
    if (!upload.ok && upload.status !== 412)
      throw new Error(`upload ${upload.status}: ${await upload.text()}`);
  }
  const bundle = Object.fromEntries(
    files
      .filter((f) => !f.path.startsWith("__renders/"))
      .map((f) => [f.path, { hash: f.sha256, size: f.size, type: f.type }]),
  );
  return t.api("/api/publish/commit", {
    method: "POST",
    bearer,
    json: {
      uploadId: ready.uploadId,
      message: "First",
      files: bundle,
      pages: [
        {
          key: "plan",
          kind: "article",
          title: "Plan",
          group: null,
          position: 0,
          meta: { htmlHash: article.sha256, outline: [], readingMinutes: 1 },
        },
        { key: "mocks", kind: "canvas", title: "Mocks", group: null, position: 1, meta: { boards: [] } },
      ],
      frames: [
        {
          pageKey: "mocks",
          boardKey: "main",
          frameKey: "live-view",
          title: "Live view",
          device: "iphone",
          x: 0,
          y: 0,
          w: 393,
          h: 852,
          contentHash: frameHash,
          renders: { "1x": render.sha256, "2x": render.sha256, "3x": render.sha256, thumb: render.sha256 },
          livePath: "index.html",
        },
      ],
      blocks: [{ pageKey: "plan", blockKey: "intro/p1", contentHash: hash("hello"), text: "Hello" }],
    },
  });
}

describe("publishing", () => {
  let t: TestServer;
  let owner: { person: { id: string }; token: string };
  beforeAll(async () => {
    t = await startTestServer();
    owner = await claim(t);
  });
  afterAll(() => t.stop());

  test("the first publish makes the project, the artifact and v1", async () => {
    const response = await publish(t, owner.token);
    expect(response.status).toBe(200);
    const result = PublishResult.parse(await response.json());
    expect(result).toMatchObject({
      version: 1,
      url: "http://viewer.test/camerabuddy/roadmap",
      changes: { frames: { added: ["live-view"] } },
    });
    expect(result.uploaded.files).toBe(3);
    const [row] = await t.server.db.select().from(artifacts);
    expect(row?.latestVersion).toBe(1);
    expect(row?.visibility).toBe("org");
  });

  test("publishing the same thing uploads nothing and reports no changes", async () => {
    const result = PublishResult.parse(await (await publish(t, owner.token)).json());
    expect(result.version).toBe(2);
    expect(result.uploaded.files).toBe(0);
    expect(result.reused).toBe(3);
    expect(result.changes.frames).toEqual({ added: [], removed: [], changed: [] });
  });

  test("a changed frame is reported", async () => {
    const result = PublishResult.parse(
      await (await publish(t, owner.token, { frameHash: hash("v3") })).json(),
    );
    expect(result.version).toBe(3);
    expect(result.changes.frames.changed).toEqual(["live-view"]);
  });

  test("the article is re-sanitized by the server", async () => {
    const [row] = await t.server.db.select().from(artifacts);
    const response = await t.api(`/api/artifacts/${row?.id}/v/1/article/plan`, { bearer: owner.token });
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await response.text();
    expect(html).toContain('data-block="intro/p1"');
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<script");
  });

  test("content that doesn't match its hash is refused and deleted, so nobody can reuse it", async () => {
    const victim = file("victim.html", `the real content ${Bun.randomUUIDv7()}`);
    const tampered = await publish(t, owner.token, { slug: "bad", extra: [victim], tamper: victim.sha256 });
    expect(await error(tampered)).toBe("invalid");
    expect(await t.server.bucket.get(`blobs/${victim.sha256}`)).toBeNull();
    const honest = await publish(t, owner.token, { slug: "good", extra: [victim] });
    expect(honest.status).toBe(200);
    const object = await t.server.bucket.get(`blobs/${victim.sha256}`);
    expect(new TextDecoder().decode(object?.body)).toBe(victim.body);
  });

  test("a presigned PUT can't replace an object", async () => {
    const body = `only once ${Bun.randomUUIDv7()}`;
    const one = file("x.bin", body, "application/octet-stream");
    const prepared = PublishPrepared.parse(
      await (
        await t.api("/api/publish/prepare", {
          method: "POST",
          bearer: owner.token,
          json: { project: "camerabuddy", slug: "put", title: "x", files: [{ ...one, body: undefined }] },
        })
      ).json(),
    );
    const put = prepared.missing[0];
    if (!put) throw new Error("expected a missing file");
    expect((await fetch(put.url, { method: "PUT", headers: put.headers, body })).status).toBe(200);
    const again = await fetch(put.url, {
      method: "PUT",
      headers: put.headers,
      body: "x".repeat(body.length),
    });
    expect(again.status).toBe(412);
  });

  test("an expired or forged upload id is refused", async () => {
    const commit = (uploadId: string) =>
      t.api("/api/publish/commit", {
        method: "POST",
        bearer: owner.token,
        json: { uploadId, files: {}, pages: [], frames: [], blocks: [] },
      });
    expect(await error(await commit("forged.signature"))).toBe("invalid");
  });

  test("permissions: no caller, a reviewer, and someone else's private slug", async () => {
    expect((await t.api("/api/publish/prepare", { method: "POST", json: {} })).status).toBe(401);
    expect((await t.api("/api/publish/commit", { method: "POST", json: {} })).status).toBe(401);
    expect(
      (await t.api("/api/publish/prepare", { method: "POST", bearer: owner.token, json: {} })).status,
    ).toBe(400);
    const body = { project: "p", slug: "demo", title: "x", files: [] };
    expect((await t.api("/api/publish/prepare", { method: "POST", json: body })).status).toBe(401);

    const org = (await t.server.db.select().from(people))[0]?.orgId as string;
    const reviewer = await makePerson(t, org, "reviewer");
    expect(
      await error(await t.api("/api/publish/prepare", { method: "POST", bearer: reviewer, json: body })),
    ).toBe("forbidden");

    await publish(t, owner.token, { slug: "private", visibility: "me" });
    const member = await makePerson(t, org, "member");
    const denied = await t.api("/api/publish/prepare", {
      method: "POST",
      bearer: member,
      json: { ...body, project: "camerabuddy", slug: "private" },
    });
    expect(await error(denied)).toBe("conflict");
    const other = await t.api("/api/publish/prepare", {
      method: "POST",
      bearer: member,
      json: { ...body, project: "camerabuddy", slug: "roadmap" },
    });
    expect(await error(other)).toBe("forbidden");
  });

  test("a deleted slug: slug_deleted for those who saw it, plain conflict for others", async () => {
    await publish(t, owner.token, { slug: "gone", visibility: "me" });
    const [project] = await t.server.db.select().from(projects);
    await t.server.db
      .update(artifacts)
      .set({ deletedAt: t.clock.now(), deletedBy: owner.person.id })
      .where(eq(artifacts.slug, "gone"));
    const body = { project: project?.slug, slug: "gone", title: "x", files: [] };
    const seen = await t.api("/api/publish/prepare", { method: "POST", bearer: owner.token, json: body });
    expect(seen.status).toBe(409);
    const details = (await seen.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(details.error.code).toBe("slug_deleted");
    expect(details.error.details.deletedBy).toBe("Zahin");
    const org = (await t.server.db.select().from(people))[0]?.orgId as string;
    const member = await makePerson(t, org, "member");
    const stranger = await t.api("/api/publish/prepare", { method: "POST", bearer: member, json: body });
    expect(await error(stranger)).toBe("conflict");
  });

  test("an archived artifact is read-only", async () => {
    await publish(t, owner.token, { slug: "old" });
    await t.server.db.update(artifacts).set({ archivedAt: t.clock.now() }).where(eq(artifacts.slug, "old"));
    expect(await error(await publish(t, owner.token, { slug: "old" }))).toBe("read_only");
  });

  test("render redirects only serve hashes this artifact uses", async () => {
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "roadmap"));
    const render = hash(`render-${hash("frame")}`);
    const ok = await t.api(`/api/artifacts/${row?.id}/r/${render}`, {
      bearer: owner.token,
      redirect: "manual",
    });
    expect(ok.status).toBe(302);
    const location = ok.headers.get("location") as string;
    expect(location).toContain(`blobs/${render}`);
    expect((await fetch(location)).status).toBe(200);
    const other = await t.api(`/api/artifacts/${row?.id}/r/${"0".repeat(64)}`, { bearer: owner.token });
    expect(other.status).toBe(404);
    expect((await t.api(`/api/artifacts/${row?.id}/r/${render}`)).status).toBe(401);
    expect((await t.api(`/api/artifacts/not-a-uuid/r/${render}`, { bearer: owner.token })).status).toBe(404);
  });
});

let people_n = 0;
/** A person with a CLI token, without going through invites (M6). */
export async function makePerson(
  t: TestServer,
  orgId: string,
  role: "member" | "reviewer" | "outside" | "admin",
) {
  const id = Bun.randomUUIDv7();
  people_n += 1;
  await t.server.db
    .insert(people)
    .values({ id, orgId, email: `p${people_n}@example.com`, name: `P${people_n}`, role });
  const secret = `art_test${id}`;
  await t.server.db.insert(tokens).values({
    id: Bun.randomUUIDv7(),
    orgId,
    kind: "cli",
    personId: id,
    name: "test",
    tokenHash: sha256(secret),
    scopes: ["publish", "comment", "read", "manage", "data"],
    createdBy: id,
  });
  return secret;
}
