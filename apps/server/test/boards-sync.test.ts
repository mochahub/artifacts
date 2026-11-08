import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  addBoardObject,
  type BoardObjectInput,
  boardStamp,
  deleteBoardObject,
  deletedMap,
  newObject,
  objectsMap,
  setBoardText,
  setPlacement,
  setRegister,
  yToBoard,
} from "@artifacts/doc/board";
import { boardBase } from "@artifacts/doc/board-hash";
import { connect, type Provider, type UnsentStore } from "@artifacts/doc/client";
import { Awareness } from "@artifacts/doc/sync";
import { CLI_SCOPES, MANIFEST, PublishPrepared, SYNC_CLOSE } from "@artifacts/schema";
import type { BoardObject } from "@artifacts/schema/boards";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import { artifacts, editDocs, editPresence, tokens } from "../src/db/schema.ts";
import { loadDoc, persistUpdate, withDocLock } from "../src/editing/store.ts";
import { startServer } from "../src/server.ts";
import {
  claim,
  createDatabase,
  OWNER,
  signIn,
  silent,
  testClock,
  testEnv,
  viewerFixture,
} from "./helpers.ts";
import { file } from "./publish-helper.ts";

/** 14, "Sync and holds": the board document over the same socket, on two replicas of one database. */

const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const STYLE = {
  fill: "transparent" as const,
  stroke: "#242424",
  strokeWidth: 2,
  opacity: 1,
  fontSize: 20,
  align: "left" as const,
};

async function replica(url: string) {
  const server = await startServer(testEnv(url), {
    log: process.env.BOARDS_DEBUG
      ? {
          ...silent,
          warn: (m: string, f?: object) => console.error("WARN", m, f),
          info: (m: string, f?: object) => m !== "request" && console.error("INFO", m, f),
        }
      : { ...silent },
    clock: testClock(),
    viewerDir: viewerFixture(),
    jobs: false,
    heartbeatMs: 400,
  });
  const base = `http://127.0.0.1:${server.ports.viewer}`;
  const api = (
    path: string,
    init: RequestInit & { json?: unknown; cookie?: string; bearer?: string } = {},
  ) => {
    const { json: body, cookie, bearer, ...rest } = init;
    const headers: Record<string, string> = {
      Host: "viewer.test",
      ...(rest.headers as Record<string, string>),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) {
      headers.Cookie = cookie;
      if (rest.method && rest.method !== "GET") headers.Origin = "http://viewer.test";
    }
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    return fetch(`${base}${path}`, {
      ...rest,
      headers,
      body: body !== undefined ? JSON.stringify(body) : rest.body,
    });
  };
  return { server, api, port: server.ports.viewer, stop: () => server.stop() };
}
type Replica = Awaited<ReturnType<typeof replica>>;

const memoryStore = (): UnsentStore => {
  const map = new Map<string, Uint8Array[]>();
  return {
    get: async (key) => map.get(key) ?? [],
    set: async (key, updates) => void (updates.length ? map.set(key, updates) : map.delete(key)),
    keys: async (prefix) => [...map.keys()].filter((key) => key.startsWith(prefix)),
  };
};
const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(25);
  }
};

type Client = { ydoc: Y.Doc; awareness: Awareness; provider: Provider; codes: number[] };

setDefaultTimeout(30_000);

describe("board sync", () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let a: Replica;
  let b: Replica;
  let token: string;
  let cookie: string;
  let id: string;
  const clients: Client[] = [];

  const open = async (r: Replica): Promise<Client> => {
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    const codes: number[] = [];
    const provider = connect(id, 0, ydoc, awareness, {
      url: `ws://127.0.0.1:${r.port}/api/artifacts/${id}/doc/sync?epoch=0`,
      socket: (to) =>
        new WebSocket(to, {
          headers: { Cookie: cookie, Origin: "http://viewer.test", Host: "viewer.test" },
        } as never),
      store: memoryStore(),
    });
    provider.on("status", (_status, code) => {
      if (code) codes.push(code);
    });
    const client = { ydoc, awareness, provider, codes };
    clients.push(client);
    await until(() => provider.synced && provider.author !== null);
    return client;
  };
  const me = (client: Client) => boardStamp(client.provider.author as string);
  const objectOf = (doc: Y.Doc, oid: string) => yToBoard(doc).objects.find((o) => o.id === oid);
  const persisted = async () => {
    const { ydoc } = await loadDoc(a.server.deps, id);
    return ydoc;
  };

  beforeAll(async () => {
    database = await createDatabase();
    a = await replica(database.url);
    b = await replica(database.url);
    ({ token } = await claim(a as never));
    cookie = await signIn(a as never, OWNER.email, OWNER.password);
    await a.server.db.update(tokens).set({ scopes: [...CLI_SCOPES] });
    await a.api("/api/wikis", { method: "POST", bearer: token, json: { slug: "brain", name: "Brain" } });
    const render = file("__renders/a.webp", "render-one", "image/webp");
    const page = file("index.html", "<h1>one</h1>");
    const manifest = file(
      MANIFEST,
      JSON.stringify({ title: "Sketch", pages: [{ id: "mocks", kind: "canvas", boards: [{ id: "main" }] }] }),
      "application/json",
    );
    const files = [page, manifest, render];
    const prepared = await a.api("/api/publish/prepare", {
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
    const committed = await a.api("/api/publish/commit", {
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
          {
            key: "mocks",
            kind: "canvas",
            title: "Mocks",
            group: null,
            position: 0,
            meta: { boards: [{ key: "main", title: "Main flow", x: 100, y: 50, w: 900, h: 1000 }] },
          },
        ],
        frames: [
          {
            pageKey: "mocks",
            boardKey: "main",
            frameKey: "live-view",
            title: "Live view",
            device: "iphone",
            x: 140,
            y: 110,
            w: 393,
            h: 852,
            contentHash: sha("frame-one"),
            renders: { "1x": render.sha256, "2x": render.sha256, "3x": render.sha256, thumb: render.sha256 },
            livePath: "index.html",
          },
        ],
        blocks: [],
      },
    });
    expect(committed.status).toBe(200);
    const [row] = await a.server.db.select({ id: artifacts.id }).from(artifacts).limit(1);
    id = row?.id as string;
  });

  afterAll(async () => {
    for (const client of clients) client.provider.destroy();
    await a?.stop();
    await b?.stop();
    await database?.drop();
  });

  test("first sync seeds a board draft: groups as frames, CLI frames as rendered children in place", async () => {
    const client = await open(a);
    const [row] = await a.server.db.select().from(editDocs).where(eq(editDocs.artifactId, id));
    expect(row?.kind).toBe("board");
    const board = yToBoard(client.ydoc);
    const group = board.objects.find((o) => o.kind === "frame");
    const frame = board.objects.find((o) => o.kind === "rendered_frame");
    expect(group?.label).toBe("Main flow");
    expect(group?.pose).toEqual({ x: 100, y: 50, w: 900, h: 1000, angle: 0 });
    if (frame?.kind !== "rendered_frame") throw new Error("no rendered frame");
    expect(frame.parent).toBe(group?.id ?? "");
    expect(frame.pose).toEqual({ x: 40, y: 60, w: 393, h: 852, angle: 0 });
    expect(frame.data.source).toEqual({ page: "mocks", board: "main", frame: "live-view" });
    client.provider.destroy();
  });

  test("a person's sticky is persisted before the other replica's editor sees it", async () => {
    const one = await open(a);
    const two = await open(b);
    const sticky = newObject(
      {
        id: "~sticky0001",
        kind: "sticky",
        pose: { x: 0, y: 0, w: 200, h: 200, angle: 0 },
        parent: null,
        order: "a5",
        label: "",
        style: STYLE,
        text: "Hi",
      } as BoardObjectInput,
      me(one),
    );
    addBoardObject(one.ydoc, sticky);
    await until(() => objectOf(two.ydoc, "~sticky0001") !== undefined);
    expect(objectOf(await persisted(), "~sticky0001")?.attribution.created.a).toBe(one.provider.author ?? "");
    expect(one.codes).toEqual([]);
  });

  test("a person dragging while an agent edits the same object: both land, one whole pose", async () => {
    const person = await open(a);
    const viewer = await open(b);
    await until(() => objectOf(person.ydoc, "~sticky0001") !== undefined);
    setPlacement(
      person.ydoc,
      "~sticky0001",
      { pose: { x: 300, y: 310, w: 220, h: 200, angle: 0.2 }, parent: null },
      me(person),
    );
    // The agent's operation lands on replica B, through the store, as worker 4's batch applier does.
    await withDocLock(b.server.deps, id, async (lock) => {
      const { ydoc } = await loadDoc(b.server.deps, id, lock);
      const before = Y.encodeStateVector(ydoc);
      setBoardText(ydoc, "~sticky0001", "Hi there", { a: "a1", t: boardStamp("a1").t });
      setPlacement(
        ydoc,
        "~sticky0001",
        { pose: { x: -50, y: -50, w: 100, h: 100, angle: 0 }, parent: null },
        boardStamp("a1"),
      );
      await persistUpdate(
        b.server.deps,
        id,
        Y.encodeStateAsUpdate(ydoc, before),
        { origin: "agent", personId: null, agent: "Claude Code", tokenId: null },
        lock,
        lock.row?.epoch,
      );
    });
    const done = (doc: Y.Doc) =>
      (objectOf(doc, "~sticky0001") as { text?: string } | undefined)?.text === "Hi there";
    await until(() => done(person.ydoc) && done(viewer.ydoc));
    await until(async () => {
      const db = yToBoard(await persisted());
      return (
        JSON.stringify(db) === JSON.stringify(yToBoard(person.ydoc)) &&
        JSON.stringify(db) === JSON.stringify(yToBoard(viewer.ydoc))
      );
    });
    const pose = objectOf(person.ydoc, "~sticky0001")?.pose;
    expect([
      JSON.stringify({ x: 300, y: 310, w: 220, h: 200, angle: 0.2 }),
      JSON.stringify({ x: -50, y: -50, w: 100, h: 100, angle: 0 }),
    ]).toContain(JSON.stringify(pose));
  });

  test("forged authors, client rendered frames, foreign tombstone clears and meta changes close 4400, unpersisted", async () => {
    const attempts: ((client: Client) => void)[] = [
      (c) => setRegister(c.ydoc, "~sticky0001", "label", "forged", { a: "a1", t: boardStamp("a1").t }),
      (c) => {
        const frame = yToBoard(c.ydoc).objects.find((o) => o.kind === "rendered_frame") as BoardObject;
        addBoardObject(
          c.ydoc,
          newObject(
            {
              ...frame,
              id: "~fakerender",
              data: {
                ...(frame as { data: object }).data,
                source: { page: "mocks", board: "main", frame: "other" },
                livePath: "javascript:alert(1)",
              },
            } as never,
            me(c),
          ),
        );
      },
      (c) => c.ydoc.getMap("board").set("page", "other"),
      // An article's fragment can't enter a board document.
      (c) => c.ydoc.getXmlFragment("doc").insert(0, [new Y.XmlText("x")]),
      (c) => objectsMap(c.ydoc).get("~sticky0001")?.set("kind", "text"),
      (c) => {
        const frame = yToBoard(c.ydoc).objects.find((o) => o.kind === "rendered_frame") as BoardObject;
        setRegister(
          c.ydoc,
          frame.id,
          "data",
          { ...(frame as { data: object }).data, livePath: "javascript:alert(1)" },
          me(c),
        );
      },
    ];
    for (const attempt of attempts) {
      const client = await open(a);
      const before = JSON.stringify(yToBoard(await persisted()));
      attempt(client);
      await until(() => client.codes.includes(SYNC_CLOSE.invalidUpdate));
      client.provider.destroy();
      expect(JSON.stringify(yToBoard(await persisted()))).toBe(before);
    }
    // A tombstone someone else set can't be cleared over the socket.
    await withDocLock(b.server.deps, id, async (lock) => {
      const { ydoc } = await loadDoc(b.server.deps, id, lock);
      const before = Y.encodeStateVector(ydoc);
      addBoardObject(
        ydoc,
        newObject(
          {
            id: "~agentnote1",
            kind: "text",
            pose: { x: 0, y: 900, w: 100, h: 40, angle: 0 },
            parent: null,
            order: "a6",
            label: "",
            style: STYLE,
            text: "agent",
          } as never,
          boardStamp("a1"),
        ),
      );
      deleteBoardObject(ydoc, "~agentnote1", boardStamp("a1"));
      await persistUpdate(
        b.server.deps,
        id,
        Y.encodeStateAsUpdate(ydoc, before),
        { origin: "agent", personId: null, agent: "Claude Code", tokenId: null },
        lock,
        lock.row?.epoch,
      );
    });
    const client = await open(a);
    await until(() => deletedMap(client.ydoc).has("~agentnote1"));
    deletedMap(client.ydoc).delete("~agentnote1");
    await until(() => client.codes.includes(SYNC_CLOSE.invalidUpdate));
    client.provider.destroy();
    expect(yToBoard(await persisted()).deleted.map((d) => d.id)).toContain("~agentnote1");
  });

  test("a person's own delete and undo-restore round-trips through the server", async () => {
    const client = await open(b);
    deleteBoardObject(client.ydoc, "~sticky0001", me(client));
    await until(async () => objectOf(await persisted(), "~sticky0001") === undefined);
    deletedMap(client.ydoc).delete("~sticky0001");
    await until(async () => objectOf(await persisted(), "~sticky0001") !== undefined);
    expect(client.codes).toEqual([]);
  });

  test("Delegate to Write bypasses the one-second presence throttle", async () => {
    for (const previous of clients) previous.provider.destroy();
    await until(
      async () =>
        (await a.server.db.select().from(editPresence).where(eq(editPresence.artifactId, id))).length === 0,
    );
    const client = await open(b);
    client.provider.setMode("delegate");
    await until(async () =>
      (await a.server.db.select().from(editPresence).where(eq(editPresence.artifactId, id))).every(
        (row) => row.mode === "delegate",
      ),
    );
    client.provider.setMode("write");
    await until(
      async () =>
        (await a.server.db.select().from(editPresence).where(eq(editPresence.artifactId, id))).some(
          (row) => row.mode === "write",
        ),
      300,
    );
  });

  test("object holds reach edit_presence.objects, from either replica", async () => {
    for (const previous of clients) previous.provider.destroy();
    await until(
      async () =>
        (await a.server.db.select().from(editPresence).where(eq(editPresence.artifactId, id))).length === 0,
    );
    const client = await open(b);
    client.provider.setMode("delegate");
    client.awareness.setLocalState({
      user: { author: "", name: "", kind: "person", color: "#123456" },
      mode: "delegate",
      objects: ["~sticky0001"],
      pending: [],
      cursor: { x: 1, y: 2 },
    });
    await until(async () => {
      const rows = await a.server.db
        .select({ objects: editPresence.objects })
        .from(editPresence)
        .where(and(eq(editPresence.artifactId, id)));
      return (
        rows.some((row) => row.objects.includes("~sticky0001")) &&
        (await a.server.db.select().from(editPresence).where(eq(editPresence.artifactId, id))).every(
          (row) => row.mode === "delegate",
        )
      );
    });
    expect(
      (
        await a.api(`/api/artifacts/${id}/doc/maintained`, {
          method: "PUT",
          cookie,
          json: { agentMaintained: true },
        })
      ).status,
    ).toBe(200);
    const before = yToBoard(await persisted()).objects.find((o) => o.id === "~sticky0001");
    const response = await a.api(`/api/artifacts/${id}/board/ops`, {
      method: "POST",
      bearer: token,
      json: {
        epoch: 1,
        requestId: Bun.randomUUIDv7(),
        bases: { "~sticky0001": boardBase(before as BoardObject) },
        ops: [{ op: "delete", object: "~sticky0001" }],
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "suggested", reason: "held" });
    expect(yToBoard(await persisted()).objects.find((o) => o.id === "~sticky0001")).toEqual(before);
    client.provider.destroy();
    await until(async () => {
      const rows = await a.server.db.select().from(editPresence).where(eq(editPresence.artifactId, id));
      return !rows.some((row) => row.objects.includes("~sticky0001"));
    });
  });
});
