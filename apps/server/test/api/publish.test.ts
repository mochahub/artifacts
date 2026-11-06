import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Artifact, DAY_MS, PublishPrepared, PublishResult, VersionRow } from "@artifacts/schema";
import { z } from "zod";
import { claim, code as error, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { file, hash, makePerson, publish, published } from "../publish-helper.ts";

describe("publishing", () => {
  let t: TestServer;
  let owner: Awaited<ReturnType<typeof claim>>;
  const bySlug = (slug: string) =>
    t.api(`/api/artifacts/by-slug/camerabuddy/${slug}`, { bearer: owner.token });
  const artifact = async (slug: string) => Artifact.parse(await (await bySlug(slug)).json());
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
    expect(await artifact("roadmap")).toMatchObject({ latestVersion: 1, visibility: "org" });
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
    const { id } = await artifact("roadmap");
    const response = await t.api(`/api/artifacts/${id}/v/1/article/plan`, { bearer: owner.token });
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
    const prepared = await t.api("/api/publish/prepare", {
      method: "POST",
      bearer: owner.token,
      json: { project: "camerabuddy", slug: "late", title: "Late", files: [] },
    });
    const { uploadId } = PublishPrepared.parse(await prepared.json());
    t.clock.advance(DAY_MS);
    expect(await error(await commit(uploadId))).toBe("invalid");
    expect((await bySlug("late")).status).toBe(404);
  });

  test("permissions: no caller, a reviewer, and someone else's private slug", async () => {
    expect((await t.api("/api/publish/prepare", { method: "POST", json: {} })).status).toBe(401);
    expect((await t.api("/api/publish/commit", { method: "POST", json: {} })).status).toBe(401);
    expect(
      (await t.api("/api/publish/prepare", { method: "POST", bearer: owner.token, json: {} })).status,
    ).toBe(400);
    const body = { project: "p", slug: "demo", title: "x", files: [] };
    expect((await t.api("/api/publish/prepare", { method: "POST", json: body })).status).toBe(401);

    const reviewer = (await makePerson(t, owner.orgId, "reviewer")).token;
    expect(
      await error(await t.api("/api/publish/prepare", { method: "POST", bearer: reviewer, json: body })),
    ).toBe("forbidden");

    await publish(t, owner.token, { slug: "private", visibility: "me" });
    const member = (await makePerson(t, owner.orgId, "member")).token;
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

  test("render redirects only serve hashes this artifact uses", async () => {
    const { id, renderHash: render } = await published(t, owner.token, {
      slug: "renders",
      frameHash: hash("renders"),
    });
    const ok = await t.api(`/api/artifacts/${id}/r/${render}`, {
      bearer: owner.token,
      redirect: "manual",
    });
    expect(ok.status).toBe(302);
    const location = ok.headers.get("location") as string;
    expect(location).toContain(`blobs/${render}`);
    expect((await fetch(location)).status).toBe(200);
    const other = await t.api(`/api/artifacts/${id}/r/${"0".repeat(64)}`, { bearer: owner.token });
    expect(other.status).toBe(404);
    expect((await t.api(`/api/artifacts/${id}/r/${render}`)).status).toBe(401);
    expect((await t.api(`/api/artifacts/not-a-uuid/r/${render}`, { bearer: owner.token })).status).toBe(404);
  });

  test("a content type that isn't a plain media type is refused at prepare and at commit", async () => {
    const files = (type: string) => [{ path: "a.txt", sha256: hash("a"), size: 1, type }];
    const prepare = (type: string) =>
      t.api("/api/publish/prepare", {
        method: "POST",
        bearer: owner.token,
        json: { project: "camerabuddy", slug: "types", title: "Types", files: files(type) },
      });
    for (const bad of [
      "text/plain\r\nSet-Cookie: a=b",
      "html",
      "text/html\u0000",
      `text/${"x".repeat(300)}`,
    ]) {
      expect(await error(await prepare(bad))).toBe("invalid");
    }
    const ok = await prepare("text/html; charset=utf-8");
    expect(ok.status).toBe(200);
    const { uploadId } = PublishPrepared.parse(await ok.json());
    const commit = await t.api("/api/publish/commit", {
      method: "POST",
      bearer: owner.token,
      json: {
        uploadId,
        files: { "a.txt": { hash: hash("a"), size: 1, type: "text/plain\r\nSet-Cookie: a=b" } },
        pages: [],
        frames: [],
        blocks: [],
      },
    });
    expect(await error(commit)).toBe("invalid");
  });

  test("a gallery keeps each item's type, so a video plays as one (SPEC §2: images or video)", async () => {
    const clip = file("clip.mp4", "not really a video", "video/mp4");
    const prepared = await t.api("/api/publish/prepare", {
      method: "POST",
      bearer: owner.token,
      json: {
        project: "camerabuddy",
        slug: "reel",
        title: "Reel",
        files: [{ path: clip.path, sha256: clip.sha256, size: clip.size, type: clip.type }],
      },
    });
    const ready = PublishPrepared.parse(await prepared.json());
    for (const missing of ready.missing) {
      await fetch(missing.url, { method: "PUT", headers: missing.headers, body: clip.body });
    }
    const committed = await t.api("/api/publish/commit", {
      method: "POST",
      bearer: owner.token,
      json: {
        uploadId: ready.uploadId,
        files: { [clip.path]: { hash: clip.sha256, size: clip.size, type: clip.type } },
        pages: [
          {
            key: "reel",
            kind: "gallery",
            title: "Reel",
            group: null,
            position: 0,
            meta: { items: [{ hash: clip.sha256, type: "video/mp4", caption: "Take one" }] },
          },
        ],
        frames: [],
        blocks: [],
      },
    });
    expect(committed.status).toBe(200);
    const { id } = await artifact("reel");
    const version = await t.api(`/api/artifacts/${id}/versions/1`, { bearer: owner.token });
    const { pages } = (await version.json()) as { pages: { meta: { items: unknown[] } }[] };
    expect(pages[0]?.meta.items).toEqual([{ hash: clip.sha256, type: "video/mp4", caption: "Take one" }]);
  });

  test("a session publishes as its person, whatever agent it names (04)", async () => {
    const cookie = await signIn(t, OWNER.email, OWNER.password);
    const prepared = await t.api("/api/publish/prepare", {
      method: "POST",
      cookie,
      json: { project: "camerabuddy", slug: "by-hand", title: "By hand", files: [] },
    });
    const { uploadId } = PublishPrepared.parse(await prepared.json());
    const committed = await t.api("/api/publish/commit", {
      method: "POST",
      cookie,
      json: { uploadId, agent: "Claude Code", files: {}, pages: [], frames: [], blocks: [] },
    });
    expect(committed.status).toBe(200);
    const { id } = await artifact("by-hand");
    const list = z
      .array(VersionRow)
      .parse(await (await t.api(`/api/artifacts/${id}/versions`, { bearer: owner.token })).json());
    expect(list[0]).toMatchObject({ publishedBy: OWNER.name, agent: null });
  });

  test("commit takes no more files than prepare does", async () => {
    const prepared = await t.api("/api/publish/prepare", {
      method: "POST",
      bearer: owner.token,
      json: { project: "camerabuddy", slug: "many", title: "Many", files: [] },
    });
    const { uploadId } = PublishPrepared.parse(await prepared.json());
    const files = Object.fromEntries(
      Array.from({ length: 20_001 }, (_, i) => [
        `f${i}.txt`,
        { hash: hash(`f${i}`), size: 1, type: "text/plain" },
      ]),
    );
    const commit = await t.api("/api/publish/commit", {
      method: "POST",
      bearer: owner.token,
      json: { uploadId, files, pages: [], frames: [], blocks: [] },
    });
    expect(await error(commit)).toBe("too_large");

    // Renders count too: each is looked up, and downloaded if it's new.
    const frames = Array.from({ length: 5001 }, (_, i) => ({
      pageKey: "mocks",
      boardKey: "main",
      frameKey: `f${i}`,
      title: null,
      device: null,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      contentHash: hash(`c${i}`),
      renders: Object.fromEntries(["1x", "2x", "3x", "thumb"].map((size) => [size, hash(`${size}${i}`)])),
      livePath: null,
    }));
    const withRenders = await t.api("/api/publish/commit", {
      method: "POST",
      bearer: owner.token,
      json: { uploadId, files: {}, pages: [], frames, blocks: [] },
    });
    expect(await error(withRenders)).toBe("too_large");
  });

  test("a backend module over the code limit is refused at commit, before it can be fetched per request", async () => {
    const big = `export default { fetch() { return new Response("x"); } };//${"x".repeat(1024 * 1024)}`;
    const response = await publish(t, owner.token, { slug: "bigbackend", backend: big });
    expect(await error(response)).toBe("too_large");
    expect((await bySlug("bigbackend")).status).toBe(404);
  });
});
