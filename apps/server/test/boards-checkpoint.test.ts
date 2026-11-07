import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { boardToY } from "@artifacts/doc/board";
import { boardHash } from "@artifacts/doc/board-hash";
import { CLI_SCOPES, MANIFEST, PublishPrepared } from "@artifacts/schema";
import type { BoardObject, BoardSnapshot } from "@artifacts/schema/boards";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import { isAnimatedPng } from "../src/boards/assets.ts";
import { canonicalJson } from "../src/boards/checkpoint.ts";
import {
  artifacts,
  blocks,
  boardSuggestions,
  boardVersions,
  editDocs,
  frames,
  pages,
  tokens,
  versions,
} from "../src/db/schema.ts";
import { blobKey } from "../src/layout.ts";
import { claim, json, OWNER, signIn, solidImage, startTestServer, type TestServer } from "./helpers.ts";
import { file } from "./publish-helper.ts";

/** 14, "Checkpoints, pictures and anchors", "Assets and limits" and "Republish merge", over HTTP. */
const T0 = "2026-11-07T10:00:00.000Z";
const style = {
  fill: "transparent" as const,
  stroke: "#242424",
  strokeWidth: 2,
  opacity: 1,
  fontSize: 20,
  align: "left" as const,
};
const stamp = { a: "a1", t: T0 };
const fields = { pose: stamp, parent: stamp, order: stamp, style: stamp, label: stamp, data: stamp };
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function sticky(id: string, text: string, order = "a0"): BoardObject {
  return {
    id,
    kind: "sticky",
    pose: { x: 900, y: 0, w: 200, h: 200, angle: 0 },
    parent: null,
    order,
    label: "",
    style: { ...style, fill: "#fff2a8" },
    text,
    attribution: { created: stamp, fields, text: [{ s: 0, e: text.length, a: "a1", t: T0 }] },
  } as BoardObject;
}

describe("boards server", () => {
  let t: TestServer;
  let token: string;
  let owner: string;
  let id: string;
  const render = file("__renders/a.webp", "render-one", "image/webp");

  /** One canvas page with one CLI frame, the way the CLI publishes a board. */
  async function publishCanvas(contentHash: string, frameKey = "live-view") {
    const page = file("index.html", `<h1>${contentHash}</h1>`);
    const manifest = file(
      MANIFEST,
      JSON.stringify({ title: "Sketch", pages: [{ id: "mocks", kind: "canvas", boards: [{ id: "main" }] }] }),
      "application/json",
    );
    const files = [page, manifest, render];
    const prepared = await t.api("/api/publish/prepare", {
      method: "POST",
      bearer: token,
      json: {
        project: "brain",
        slug: "sketch",
        title: "Sketch",
        files: files.map(({ body: _, ...rest }) => rest),
      },
    });
    const ready = PublishPrepared.parse(await prepared.json());
    for (const missing of ready.missing) {
      const source = files.find((f) => f.sha256 === missing.sha256);
      await fetch(missing.url, { method: "PUT", headers: missing.headers, body: source?.body });
    }
    return t.api("/api/publish/commit", {
      method: "POST",
      bearer: token,
      json: {
        uploadId: ready.uploadId,
        message: "Mocks",
        summary: "A sketch.",
        wiki: { role: "page", sources: [] },
        files: Object.fromEntries(
          [page, manifest].map((f) => [f.path, { hash: f.sha256, size: f.size, type: f.type }]),
        ),
        pages: [
          { key: "mocks", kind: "canvas", title: "Mocks", group: null, position: 0, meta: { boards: [] } },
        ],
        frames: [
          {
            pageKey: "mocks",
            boardKey: "main",
            frameKey,
            title: "Live view",
            device: "iphone",
            x: 0,
            y: 0,
            w: 393,
            h: 852,
            contentHash,
            renders: { "1x": render.sha256, "2x": render.sha256, "3x": render.sha256, thumb: render.sha256 },
            livePath: "index.html",
          },
        ],
        blocks: [],
      },
    });
  }

  /** A board draft row, as worker 2's seed makes one, holding this snapshot. */
  async function draft(snapshot: BoardSnapshot, seq = 1) {
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.id, id));
    const bytes = Y.encodeStateAsUpdate(boardToY(snapshot));
    await t.server.db.delete(editDocs).where(eq(editDocs.artifactId, id));
    await t.server.db.insert(editDocs).values({
      artifactId: id,
      orgId: row?.orgId as string,
      pageKey: "mocks",
      kind: "board",
      baseVersion: row?.latestVersion as number,
      version: row?.latestVersion as number,
      seq,
      checkpointSeq: 0,
      snapshotSeq: seq,
      snapshot: bytes,
      authorCounter: 1,
    });
  }

  beforeAll(async () => {
    t = await startTestServer();
    ({ token } = await claim(t));
    owner = await signIn(t, OWNER.email, OWNER.password);
    await t.server.db.update(tokens).set({ scopes: [...CLI_SCOPES] });
    await t.api("/api/wikis", { method: "POST", bearer: token, json: { slug: "brain", name: "Brain" } });
    const first = await publishCanvas(sha("frame-one"));
    expect(first.status).toBe(200);
    const [row] = await t.server.db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.slug, "sketch"));
    id = row?.id as string;
    await t.api(`/api/artifacts/${id}/doc/maintained`, {
      method: "PUT",
      cookie: owner,
      json: { agentMaintained: true },
    });
  });
  afterAll(() => t.stop());

  test("an editor's board state is the board's; an article route refuses it", async () => {
    const state = await json<{ editable: boolean; reason: string | null; canEdit: boolean }>(
      await t.api(`/api/artifacts/${id}/board`, { cookie: owner }),
    );
    expect(state).toMatchObject({ editable: true, reason: null, canEdit: true });
    const article = await t.api(`/api/artifacts/${id}/doc/draft`, { cookie: owner });
    expect(article.status).toBe(409);
  });

  test("an agent checkpoint is one serialization: DB snapshot, bundle file and hash agree; pictures pending", async () => {
    await draft({
      schema: 1,
      page: "mocks",
      objects: [sticky("~stickyaaa1", "See [[Pricing]] first", "a0")],
      deleted: [],
      assets: [],
    });
    const saved = await json<{ version: number; created: boolean; kind: string }>(
      await t.api(`/api/artifacts/${id}/board/checkpoint`, {
        method: "POST",
        bearer: token,
        json: { epoch: 1 },
      }),
    );
    expect(saved).toMatchObject({ version: 2, created: true, kind: "agent" });
    const [version] = await t.server.db
      .select()
      .from(versions)
      .where(and(eq(versions.artifactId, id), eq(versions.n, 2)));
    const [board] = await t.server.db
      .select()
      .from(boardVersions)
      .where(eq(boardVersions.versionId, version?.id as string));
    expect(board?.renders).toBeNull();
    expect(board?.hash).toBe(boardHash(board?.snapshot as BoardSnapshot));
    const stored = await t.server.bucket.get(blobKey(version?.files["__boards/mocks.json"]?.hash as string));
    expect(new TextDecoder().decode(stored?.body)).toBe(canonicalJson(board?.snapshot));
    const [page] = await t.server.db
      .select()
      .from(pages)
      .where(eq(pages.versionId, version?.id as string));
    expect(page?.meta.board).toEqual({ schema: 1, hash: board?.hash as string });
    // CLI frames carry through unchanged; native text is indexed by object id; links come from the text.
    expect(
      await t.server.db
        .select()
        .from(frames)
        .where(eq(frames.versionId, version?.id as string)),
    ).toHaveLength(1);
    const indexed = await t.server.db
      .select()
      .from(blocks)
      .where(eq(blocks.versionId, version?.id as string));
    expect(indexed.map((row) => [row.blockKey, row.text])).toEqual([
      ["~stickyaaa1", "See [[Pricing]] first"],
    ]);
    expect(version?.links).toEqual(["brain/pricing"]);
    // Nothing new: no second version.
    const again = await json<{ created: boolean }>(
      await t.api(`/api/artifacts/${id}/board/checkpoint`, {
        method: "POST",
        bearer: token,
        json: { epoch: 1 },
      }),
    );
    expect(again.created).toBe(false);
  });

  test("a stale epoch is refused", async () => {
    const stale = await t.api(`/api/artifacts/${id}/board/checkpoint`, {
      method: "POST",
      bearer: token,
      json: { epoch: 9 },
    });
    expect(stale.status).toBe(409);
  });

  test("a version capture attaches pictures once; an identical retry passes, a different set conflicts", async () => {
    const thumb = new Uint8Array(await solidImage(1200, 630, "#ffffff", "webp"));
    const other = new Uint8Array(await solidImage(1200, 630, "#000000", "webp"));
    const image = (bytes: Uint8Array) => ({
      hash: sha(bytes),
      type: "image/webp" as const,
      bytes: bytes.length,
      width: 1200,
      height: 630,
    });
    for (const bytes of [thumb, other]) {
      const prepared = await json<{ images: { url: string | null; headers: Record<string, string> }[] }>(
        await t.api(`/api/artifacts/${id}/board/assets/prepare`, {
          method: "POST",
          cookie: owner,
          json: { images: [image(bytes)] },
        }),
      );
      const url = prepared.images[0]?.url as string;
      expect(url).toContain("uploads/boards/");
      expect(
        (await fetch(url, { method: "PUT", headers: prepared.images[0]?.headers, body: bytes })).ok,
      ).toBe(true);
      const committed = await t.api(`/api/artifacts/${id}/board/assets/commit`, {
        method: "POST",
        cookie: owner,
        json: { images: [image(bytes)] },
      });
      expect(committed.status).toBe(200);
    }
    const ticket = async () =>
      json<{ ticket: string; threads: unknown[] }>(
        await t.api(`/api/artifacts/${id}/board/captures`, {
          method: "POST",
          cookie: owner,
          json: { target: { kind: "version", version: 2 } },
        }),
      );
    // Only a browser session takes pictures.
    const byToken = await t.api(`/api/artifacts/${id}/board/captures`, {
      method: "POST",
      bearer: token,
      json: { target: { kind: "version", version: 2 } },
    });
    expect(byToken.status).toBe(403);
    const first = await ticket();
    const commit = (ticketId: string, bytes: Uint8Array) =>
      t.api(`/api/artifacts/${id}/board/captures/commit`, {
        method: "POST",
        cookie: owner,
        json: { ticket: ticketId, renders: { thumbnail: image(bytes), crops: [] } },
      });
    expect((await commit(first.ticket, thumb)).status).toBe(200);
    expect((await commit(first.ticket, thumb)).status).toBe(200);
    const second = await ticket();
    expect((await commit(second.ticket, other)).status).toBe(409);
    const view = await json<{ renders: { thumbnail: { hash: string } } | null; version: number }>(
      await t.api(`/api/artifacts/${id}/board/snapshot?version=2`, { cookie: owner }),
    );
    expect(view.renders?.thumbnail.hash).toBe(sha(thumb));
    // The version is the same: capture changed no content, number or authorship.
    const [row] = await t.server.db
      .select({ latest: artifacts.latestVersion })
      .from(artifacts)
      .where(eq(artifacts.id, id));
    expect(row?.latest).toBe(2);
  });

  test("assets: a hash known elsewhere isn't attached without its bytes; spoofed and animated rasters fail", async () => {
    // The render the publish uploaded is a blob in this org, but never uploaded to this board.
    const known = {
      hash: render.sha256,
      type: "image/webp" as const,
      bytes: render.size,
      width: 1,
      height: 1,
    };
    await t.api(`/api/artifacts/${id}/board/assets/prepare`, {
      method: "POST",
      cookie: owner,
      json: { images: [known] },
    });
    const attach = await t.api(`/api/artifacts/${id}/board/assets/commit`, {
      method: "POST",
      cookie: owner,
      json: { images: [known] },
    });
    expect(attach.status).toBe(400);
    const fetched = await t.api(`/api/artifacts/${id}/board/assets/${render.sha256}`, { cookie: owner });
    expect(fetched.status).toBe(404);

    const png = new Uint8Array(await solidImage(4, 4, "#ff0000", "png"));
    const spoofed = { hash: sha(png), type: "image/webp" as const, bytes: png.length, width: 4, height: 4 };
    const prepared = await json<{ images: { url: string; headers: Record<string, string> }[] }>(
      await t.api(`/api/artifacts/${id}/board/assets/prepare`, {
        method: "POST",
        cookie: owner,
        json: { images: [spoofed] },
      }),
    );
    await fetch(prepared.images[0]?.url as string, {
      method: "PUT",
      headers: prepared.images[0]?.headers,
      body: png,
    });
    const bad = await t.api(`/api/artifacts/${id}/board/assets/commit`, {
      method: "POST",
      cookie: owner,
      json: { images: [spoofed] },
    });
    expect(bad.status).toBe(400);

    // An acTL chunk before IDAT is an APNG, whatever libvips makes of it.
    const actl = new Uint8Array([0, 0, 0, 8, 0x61, 0x63, 0x54, 0x4c, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    const apng = new Uint8Array([...png.subarray(0, 33), ...actl, ...png.subarray(33)]);
    expect(isAnimatedPng(apng)).toBe(true);
    expect(isAnimatedPng(png)).toBe(false);
  });

  test("a republish refreshes the frame's pixels in place, keeps the draft, and makes no new object", async () => {
    const before = await t.server.db.select().from(editDocs).where(eq(editDocs.artifactId, id));
    await draft(
      {
        schema: 1,
        page: "mocks",
        objects: [
          sticky("~stickyaaa1", "See [[Pricing]] first", "a0"),
          {
            id: "~rendered01",
            kind: "rendered_frame",
            pose: { x: 40, y: 50, w: 300, h: 600, angle: 0 },
            parent: null,
            order: "a1",
            label: "Live view",
            style,
            data: {
              source: { page: "mocks", board: "main", frame: "live-view" },
              version: 1,
              contentHash: sha("frame-one"),
              renders: {
                "1x": render.sha256,
                "2x": render.sha256,
                "3x": render.sha256,
                thumb: render.sha256,
              },
              intrinsic: { w: 393, h: 852 },
              livePath: "index.html",
              missing: false,
            },
            attribution: { created: stamp, fields, text: [] },
          } as BoardObject,
        ],
        deleted: [],
        assets: [],
      },
      (before[0]?.seq ?? 1) + 1,
    );
    const response = await publishCanvas(sha("frame-two"));
    expect(response.status).toBe(200);
    const result = await json<{
      version: number;
      board?: { placed: string[]; suggestions: string[]; unplaced: string[] };
    }>(response);
    expect(result.board).toEqual({ placed: [], suggestions: [], unplaced: [] });
    const view = await json<{ snapshot: BoardSnapshot }>(
      await t.api(`/api/artifacts/${id}/board/snapshot?version=${result.version}`, { cookie: owner }),
    );
    const frame = view.snapshot.objects.find((object) => object.id === "~rendered01") as Extract<
      BoardObject,
      { kind: "rendered_frame" }
    >;
    expect(frame.pose).toEqual({ x: 40, y: 50, w: 300, h: 600, angle: 0 });
    expect(frame.data.contentHash).toBe(sha("frame-two"));
    expect(view.snapshot.objects.map((object) => object.id).sort()).toEqual(["~rendered01", "~stickyaaa1"]);
    const [row] = await t.server.db.select().from(editDocs).where(eq(editDocs.artifactId, id));
    expect(row?.kind).toBe("board");
    expect(row?.version).toBe(result.version);

    // A new key on an agent-maintained page is placed beside the scene, directly.
    const added = await json<{ board?: { placed: string[] } }>(
      await publishCanvas(sha("frame-three"), "settings"),
    );
    expect(added.board?.placed).toEqual(["settings"]);
    expect(
      await t.server.db.select().from(boardSuggestions).where(eq(boardSuggestions.artifactId, id)),
    ).toHaveLength(0);
  });
});
