import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, type Provider, type UnsentStore } from "@artifacts/doc/client";
import { Awareness } from "@artifacts/doc/sync";
import { FRAGMENT, topBlocks } from "@artifacts/doc/ydoc";
import {
  CLI_SCOPES,
  DocState,
  EDIT_MESSAGES_PER_SECOND,
  EDIT_UPDATE_MAX,
  SYNC_MESSAGE,
} from "@artifacts/schema";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import { artifactAccess, editDocs, editPresence, tokens, versions } from "../../src/db/schema.ts";
import type { DocHub } from "../../src/realtime/sync.ts";
import { startServer } from "../../src/server.ts";
import {
  claim,
  createDatabase,
  json,
  mcp,
  OWNER,
  signIn,
  silent,
  testClock,
  testEnv,
  viewerFixture,
} from "../helpers.ts";
import { makeAccount } from "../publish-helper.ts";

/**
 * 13, "Multi-replica": servers on one database, sockets on each, operations on a replica that holds
 * nothing, a lost LISTEN and concurrent checkpoints.
 */

type Replica = Awaited<ReturnType<typeof replica>>;

async function replica(url: string) {
  const clock = testClock();
  const server = await startServer(testEnv(url), {
    log: process.env.B2_DEBUG
      ? {
          ...silent,
          warn: (m: string, f?: object) => console.error("WARN", m, f),
          info: (m: string, f?: object) => m !== "request" && console.error("INFO", m, f),
        }
      : { ...silent },
    clock,
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
  return {
    server,
    clock,
    api,
    port: server.ports.viewer,
    hub: server.deps.docs as unknown as DocHub,
    stop: () => server.stop(),
  };
}

const memoryStore = (): UnsentStore => {
  const map = new Map<string, Uint8Array[]>();
  return {
    get: async (key) => map.get(key) ?? [],
    set: async (key, updates) => void (updates.length ? map.set(key, updates) : map.delete(key)),
    keys: async (prefix) => [...map.keys()].filter((key) => key.startsWith(prefix)),
  };
};

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(25);
  }
};

const text = (ydoc: Y.Doc) => JSON.stringify(ydoc.getXmlFragment(FRAGMENT).toJSON());
/** The words alone, with no author tags between them. */
const plain = (ydoc: Y.Doc) => {
  const walk = (type: Y.XmlElement | Y.XmlFragment | Y.XmlText): string =>
    type instanceof Y.XmlText
      ? (type.toDelta() as { insert: string }[]).map((op) => op.insert).join("")
      : type
          .toArray()
          .map((child) => walk(child as Y.XmlElement))
          .join(" ");
  return walk(ydoc.getXmlFragment(FRAGMENT));
};

type Client = { ydoc: Y.Doc; awareness: Awareness; provider: Provider; codes: number[] };

describe("sync across replicas", () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let a: Replica;
  let b: Replica;
  let c: Replica;
  let token: string;
  let orgId: string;
  let cookie: string;
  let id: string;
  let epoch: number;
  const clients: Client[] = [];

  const open = async (
    r: Replica,
    options: {
      cookie?: string;
      origin?: string;
      store?: UnsentStore;
      blocked?: () => boolean;
      sockets?: WebSocket[];
    } = {},
  ) => {
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    const codes: number[] = [];
    const provider = connect(id, epoch, ydoc, awareness, {
      url: `ws://127.0.0.1:${r.port}/api/artifacts/${id}/doc/sync?epoch=${epoch}`,
      socket: (to) => {
        const socket = new WebSocket(options.blocked?.() ? "ws://127.0.0.1:9/" : to, {
          headers: {
            Cookie: options.cookie ?? cookie,
            Origin: options.origin ?? "http://viewer.test",
            Host: "viewer.test",
          },
        } as never);
        options.sockets?.push(socket);
        return socket;
      },
      store: options.store ?? memoryStore(),
    });
    provider.on("status", (status, code) => {
      if (process.env.B2_DEBUG) console.error("STATUS", status, code);
      if (code) codes.push(code);
    });
    const client = { ydoc, awareness, provider, codes };
    clients.push(client);
    return client;
  };
  const ready = async (client: Client) => {
    await until(() => client.provider.synced && client.provider.author !== null);
    return client;
  };
  /** Types into a top-level block as the editor would: the text marked with the connection's key. */
  const type = (client: Client, index: number, at: number, value: string) => {
    const block = topBlocks(client.ydoc)[index]?.el as Y.XmlElement;
    let xmlText = block.get(0) as Y.XmlText | undefined;
    client.ydoc.transact(() => {
      if (!(xmlText instanceof Y.XmlText)) {
        xmlText = new Y.XmlText();
        block.insert(0, [xmlText]);
      }
      xmlText.insert(Math.min(at, xmlText.length), value, {
        author: { a: client.provider.author, t: Math.floor(Date.now() / 60_000) },
      });
    });
  };
  const ops = (r: Replica, body: object) =>
    r.api(`/api/artifacts/${id}/doc/ops`, {
      method: "POST",
      bearer: token,
      json: { agent: "Claude Code", ...body },
    });
  const read = async (r: Replica) =>
    json<{ blocks: { id: string; base: string; markdown: string }[] }>(
      await r.api(`/api/artifacts/${id}/doc/markdown?draft=1`, { bearer: token }),
    );

  beforeAll(async () => {
    database = await createDatabase();
    a = await replica(database.url);
    b = await replica(database.url);
    c = await replica(database.url);
    ({ token, orgId } = await claim(a as never));
    cookie = await signIn(a as never, OWNER.email, OWNER.password);
    await a.server.db.update(tokens).set({ scopes: [...CLI_SCOPES] });
    expect(
      (await a.api("/api/wikis", { method: "POST", bearer: token, json: { slug: "brain", name: "Brain" } }))
        .status,
    ).toBe(201);
    const published = await mcp(a as never, token, "tools/call", {
      name: "artifacts_publish_article",
      arguments: {
        project: "brain",
        slug: "pricing",
        title: "Pricing",
        summary: "How we price.",
        markdown: "# Pricing\n\nOne.\n\nTwo.\n\nThree.\n",
      },
    });
    expect(published.status).toBe(200);
    const [row] = await a.server.db.select({ id: versions.artifactId }).from(versions).limit(1);
    id = row?.id as string;
    // Agents may edit directly here, so operations land in the draft rather than as suggestions.
    expect(
      (
        await a.api(`/api/artifacts/${id}/doc/maintained`, {
          method: "PUT",
          cookie,
          json: { agentMaintained: true },
        })
      ).status,
    ).toBe(200);
    expect((await a.api(`/api/artifacts/${id}/doc/draft`, { cookie })).status).toBe(200);
    const state = DocState.parse(await json(await a.api(`/api/artifacts/${id}/doc`, { cookie })));
    epoch = state.epoch;
  });

  afterAll(async () => {
    for (const client of clients) client.provider.destroy();
    await Promise.all([a?.stop(), b?.stop(), c?.stop()]);
    await database?.drop();
  });

  test("a socket needs a session from a viewer origin", async () => {
    const tokenSocket = await fetch(`http://127.0.0.1:${a.port}/api/artifacts/${id}/doc/sync`, {
      headers: {
        Host: "viewer.test",
        Authorization: `Bearer ${token}`,
        Upgrade: "websocket",
        Origin: "http://viewer.test",
      },
    });
    expect(tokenSocket.status).toBe(403);
    const elsewhere = await open(a, { origin: "https://evil.example" });
    await until(() => elsewhere.provider.status !== "connecting");
    expect(elsewhere.provider.author).toBeNull();
    elsewhere.provider.destroy();
  });

  test("two replicas with a socket on each converge, and every id is kept", async () => {
    const one = await ready(await open(a));
    const two = await ready(await open(b));
    one.provider.setMode("delegate");
    two.provider.setMode("delegate");
    const ids = topBlocks(one.ydoc).map((block) => block.id);
    expect(ids).toHaveLength(4);
    type(one, 1, 0, "A says hi. ");
    type(two, 2, 0, "B says hi. ");
    await until(() => text(one.ydoc) === text(two.ydoc) && plain(one.ydoc).includes("B says hi"));
    expect(plain(one.ydoc)).toContain("A says hi");
    expect(topBlocks(two.ydoc).map((block) => block.id)).toEqual(ids);
  });

  test("an operation on a replica that holds nothing reaches both, and the agent shows in presence", async () => {
    const [one, two] = clients.slice(-2) as [Client, Client];
    const before = await read(c);
    const last = before.blocks.at(-1) as { id: string };
    const response = await ops(c, {
      ops: [{ op: "insert", after: last.id, markdown: "Added by an agent." }],
    });
    expect(response.status).toBe(200);
    const result = await json<{ results: { outcome: string; block: string }[] }>(response);
    expect(result.results[0]?.outcome).toBe("applied");
    await until(
      () => plain(one.ydoc).includes("Added by an agent") && plain(two.ydoc).includes("Added by an agent"),
    );
    expect(topBlocks(one.ydoc).at(-1)?.id).toBe(result.results[0]?.block);
    await until(() =>
      [...one.awareness.getStates().values()].some(
        (s) => (s as { user?: { kind?: string } }).user?.kind === "agent",
      ),
    );
  });

  test("a person typing in a block holds it: an agent's replace there becomes a suggestion", async () => {
    const [one] = clients.slice(-2) as [Client, Client];
    const page = await read(c);
    const target = page.blocks[1] as { id: string; base: string };
    one.awareness.setLocalStateField("user", { author: "", name: "", kind: "person", color: "#123456" });
    one.awareness.setLocalStateField("mode", "delegate");
    one.awareness.setLocalStateField("pending", []);
    one.awareness.setLocalStateField("block", target.id);
    await Bun.sleep(1500);
    const held = await json<{ results: { outcome: string; reason: string | null }[] }>(
      await ops(c, { ops: [{ op: "replace", block: target.id, base: target.base, markdown: "Rewritten." }] }),
    );
    expect(held.results[0]).toMatchObject({ outcome: "suggested", reason: "held" });
    // Not held any more: the replace applies as a diff inside the block, which keeps its id.
    one.awareness.setLocalStateField("block", null);
    await Bun.sleep(1500);
    const fresh = (await read(c)).blocks[1] as { id: string; base: string };
    const applied = await json<{ results: { outcome: string }[] }>(
      await ops(c, { ops: [{ op: "replace", block: fresh.id, base: fresh.base, markdown: "Rewritten." }] }),
    );
    expect(applied.results[0]?.outcome).toBe("applied");
    await until(() => plain(one.ydoc).includes("Rewritten."));
    expect(topBlocks(one.ydoc)[1]?.id).toBe(fresh.id);
  });

  test("someone writing keeps agents out", async () => {
    const [one, two] = clients.slice(-2) as [Client, Client];
    one.provider.setMode("write");
    await Bun.sleep(300);
    const page = await read(c);
    const refused = await json<{ results: { outcome: string; reason: string | null }[] }>(
      await ops(c, { ops: [{ op: "insert", after: page.blocks[0]?.id ?? null, markdown: "Sneaky." }] }),
    );
    expect(refused.results[0]?.outcome).toBe("refused");
    one.provider.setMode("delegate");
    two.provider.setMode("delegate");
    await Bun.sleep(300);
  });

  test("an update with forged authors is refused and never reaches the others", async () => {
    const [, two] = clients.slice(-2) as [Client, Client];
    const forger = await ready(await open(a));
    const block = topBlocks(forger.ydoc)[0]?.el as Y.XmlElement;
    (block.get(0) as Y.XmlText).insert(0, "Forged ", { author: { a: "a999", t: 1 } });
    await until(() => forger.codes.includes(4400));
    await Bun.sleep(300);
    expect(plain(two.ydoc)).not.toContain("Forged");
  });

  test("a replica whose LISTEN was lost reloads by seq", async () => {
    const [one, two] = clients.slice(-3, -1) as [Client, Client];
    // B stops hearing anything: what A writes now reaches B only through the reload.
    const hub = b.hub as unknown as { client: { end(o: object): Promise<void> } };
    await hub.client.end({ timeout: 1 });
    type(one, 0, 0, "While B was deaf. ");
    await Bun.sleep(500);
    expect(plain(two.ydoc)).not.toContain("While B was deaf");
    await b.hub.reconnect();
    await until(() => plain(two.ydoc).includes("While B was deaf"));
  });

  test("concurrent checkpoints from two replicas make one version", async () => {
    const [one] = clients.slice(-3, -2) as [Client];
    type(one, 0, 0, "Saved. ");
    await Bun.sleep(400);
    const results = await Promise.all(
      [a, b].map(async (r) =>
        json<{ version: number; created: boolean }>(
          await r.api(`/api/artifacts/${id}/doc/checkpoint`, { method: "POST", cookie, json: {} }),
        ),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0]?.version).toBe(results[1]?.version as number);
  });

  test("three writers and an agent converge", async () => {
    const writers = [await ready(await open(a)), await ready(await open(b)), await ready(await open(a))];
    for (const writer of writers) writer.provider.setMode("delegate");
    await Bun.sleep(300);
    const ids = topBlocks(writers[0]?.ydoc as Y.Doc).map((block) => block.id);
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const agentBlock = (await read(c)).blocks.at(-1) as { id: string };
    const agent = ops(c, { ops: [{ op: "insert", after: agentBlock.id, markdown: "The agent's line." }] });
    for (let i = 0; i < 60; i++) {
      const writer = writers[Math.floor(random() * writers.length)] as Client;
      type(writer, Math.floor(random() * 3), Math.floor(random() * 20), String.fromCharCode(97 + (i % 26)));
      if (i % 10 === 0) await Bun.sleep(30);
    }
    expect((await agent).status).toBe(200);
    await until(
      () =>
        writers.every((w) => text(w.ydoc) === text(writers[0]?.ydoc as Y.Doc)) &&
        plain(writers[0]?.ydoc as Y.Doc).includes("The agent's line"),
      10_000,
    );
    const after = topBlocks(writers[0]?.ydoc as Y.Doc).map((block) => block.id);
    for (const kept of ids) expect(after).toContain(kept);
    expect(writers.every((w) => w.codes.length === 0)).toBe(true);
    // And the server's copy is the same document.
    const server = b.hub.heldDoc(id) as Y.Doc;
    await until(() => text(server) === text(writers[0]?.ydoc as Y.Doc));
  });

  test("typing a letter equal to the next one swaps two authors, and the writer keeps syncing", async () => {
    // Two people, so the neighbouring letters have another author than the typist.
    const member = await makeAccount(a as never, orgId, "member");
    await a.server.db.insert(artifactAccess).values({
      orgId,
      artifactId: id,
      personId: member.id,
      permission: "edit",
      grantedBy: member.id,
    });
    const one = await ready(await open(a));
    const two = await ready(await open(b, { cookie: member.cookie }));
    expect(one.provider.author).not.toBe(two.provider.author);
    one.provider.setMode("delegate");
    two.provider.setMode("delegate");
    type(two, 0, 0, "week ");
    await until(() => plain(one.ydoc).includes("week "));
    const block = topBlocks(one.ydoc)[0]?.el as Y.XmlElement;
    const ytext = block.get(0) as Y.XmlText;
    const words = (ytext.toDelta() as { insert: string }[]).map((op) => op.insert).join("");
    const at = words.indexOf("eek");
    // What y-prosemirror sends for an "e" typed before "eek": the new letter goes in after the old one
    // with the old author, and the old one is marked as the typist's.
    one.ydoc.transact(() => {
      ytext.insert(at + 1, "e");
      ytext.format(at, 1, { author: { a: one.provider.author, t: Math.floor(Date.now() / 60_000) } });
    });
    type(one, 0, 0, "Then more. ");
    await until(() => plain(two.ydoc).includes("Then more.") && plain(two.ydoc).includes("weeek"));
    expect(text(one.ydoc)).toBe(text(two.ydoc));
    expect(one.codes).toEqual([]);
    // Both keep writing, from both replicas, and converge.
    type(two, 0, 0, "Two again. ");
    type(one, 1, 0, "One again. ");
    await until(() => text(one.ydoc) === text(two.ydoc) && plain(one.ydoc).includes("Two again."));
    expect([...one.codes, ...two.codes]).toEqual([]);
  });

  /** Two members with edit access, each on their own replica, both letting agents work. */
  const pair = async () => {
    const one = await ready(await open(a));
    const two = await ready(await open(b));
    one.provider.setMode("delegate");
    two.provider.setMode("delegate");
    await Bun.sleep(300);
    return [one, two] as const;
  };

  test("an agent's commit racing a pending flush on the holding replica is never skipped", async () => {
    const [one, two] = await pair();
    const last = (await read(c)).blocks.at(-1) as { id: string };
    for (let round = 0; round < 5; round++) {
      const agent = ops(c, {
        ops: [{ op: "insert", after: last.id, markdown: `Raced by an agent ${round}.` }],
      });
      await Bun.sleep(round * 7);
      type(one, 0, 0, "Racing flush. ");
      expect((await agent).status).toBe(200);
    }
    await until(
      () => plain(two.ydoc).includes("Racing flush.") && plain(two.ydoc).includes("Raced by an agent"),
    );
    // Whichever of A's flush and the agent's commit took the lower seq, A applies both.
    await until(() => plain(one.ydoc).includes("Raced by an agent 4."));
    await until(() => text(one.ydoc) === text(two.ydoc));
    await until(() => text(b.hub.heldDoc(id) as Y.Doc) === text(a.hub.heldDoc(id) as Y.Doc));
    expect(text(one.ydoc)).toBe(text(two.ydoc));
  });

  test("a failed save shows nobody the change, and a reconnect saves it", async () => {
    const [one, two] = await pair();
    const sql = (a.server.db as unknown as { $client: { unsafe(q: string): Promise<unknown> } }).$client;
    await sql.unsafe("alter table edit_updates add constraint b2_refuse check (size < 0) not valid");
    try {
      type(one, 0, 0, "Saved at last. ");
      await until(() => one.codes.includes(1011));
      expect(plain(two.ydoc)).not.toContain("Saved at last.");
      expect(plain(b.hub.heldDoc(id) as Y.Doc)).not.toContain("Saved at last.");
    } finally {
      await sql.unsafe("alter table edit_updates drop constraint b2_refuse");
    }
    await until(() => plain(two.ydoc).includes("Saved at last."), 10_000);
    const draft = await read(c);
    expect(draft.blocks.map((block) => block.markdown).join("\n")).toContain("Saved at last.");
  });

  test("a javascript: link arriving over the socket is refused", async () => {
    const [one, two] = await pair();
    const block = topBlocks(one.ydoc)[0]?.el as Y.XmlElement;
    const minutes = Math.floor(Date.now() / 60_000);
    (block.get(0) as Y.XmlText).insert(0, "Click me ", {
      author: { a: one.provider.author, t: minutes },
      link: { href: "javascript:alert(1)", title: null },
    });
    await until(() => one.codes.includes(4400));
    await Bun.sleep(300);
    expect(plain(two.ydoc)).not.toContain("Click me");
  });

  test("compaction drops deleted text from the snapshot", async () => {
    const [one, two] = await pair();
    const secret = "s3cret-".repeat(30_000);
    type(one, 1, 0, secret);
    await until(() => plain(two.ydoc).includes("s3cret-s3cret-"), 10_000);
    const block = topBlocks(one.ydoc)[1]?.el as Y.XmlElement;
    const ytext = block.get(0) as Y.XmlText;
    const at = (ytext.toDelta() as { insert: string }[])
      .map((op) => op.insert)
      .join("")
      .indexOf("s3cret-");
    ytext.delete(at, secret.length);
    await until(() => !plain(two.ydoc).includes("s3cret-"), 10_000);
    await Bun.sleep(500);
    const { compact } = await import("../../src/editing/store.ts");
    await a.server.db.transaction((tx) => compact(tx as never, id));
    const [row] = await a.server.db
      .select({ snapshot: editDocs.snapshot })
      .from(editDocs)
      .where(eq(editDocs.artifactId, id));
    expect(row?.snapshot.length ?? 0).toBeLessThan(50_000);
    expect(new TextDecoder().decode(row?.snapshot)).not.toContain("s3cret-");
  });

  test("a write made on an old epoch is refused, not stamped with the new one", async () => {
    const { persistUpdate } = await import("../../src/editing/store.ts");
    const [row] = await a.server.db
      .select({ epoch: editDocs.epoch })
      .from(editDocs)
      .where(eq(editDocs.artifactId, id));
    const actor = { origin: "server" as const, personId: null, agent: null, tokenId: null };
    await expect(
      persistUpdate(a.server.deps, id, new Uint8Array([0, 0]), actor, undefined, (row?.epoch ?? 1) - 1),
    ).rejects.toThrow();
  });

  /** A bare socket, to send what no well-behaved client would. Resolves once `hello` arrived. */
  const raw = async (r: Replica, who = cookie) => {
    const socket = new WebSocket(`ws://127.0.0.1:${r.port}/api/artifacts/${id}/doc/sync?epoch=${epoch}`, {
      headers: { Cookie: who, Origin: "http://viewer.test", Host: "viewer.test" },
    } as never);
    socket.binaryType = "arraybuffer";
    const closed = new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve(event.code);
    });
    await new Promise<void>((resolve) => {
      socket.onmessage = (event) => {
        if (new Uint8Array(event.data as ArrayBuffer)[0] === SYNC_MESSAGE.control) resolve();
      };
    });
    return { socket, closed };
  };

  test("past EDIT_MESSAGES_PER_SECOND a socket closes with 4429", async () => {
    const { socket, closed } = await raw(a);
    for (let i = 0; i <= EDIT_MESSAGES_PER_SECOND + 5; i++)
      socket.send(new Uint8Array([SYNC_MESSAGE.queryAwareness]));
    expect(await closed).toBe(4429);
  });

  test("a message past EDIT_UPDATE_MAX closes with 4413", async () => {
    const { socket, closed } = await raw(a);
    socket.send(new Uint8Array(EDIT_UPDATE_MAX + 16));
    expect(await closed).toBe(4413);
  });

  test("losing edit access mid-session closes with 4403 at the next heartbeat", async () => {
    const member = await makeAccount(a as never, orgId, "member");
    await a.server.db.insert(artifactAccess).values({
      orgId,
      artifactId: id,
      personId: member.id,
      permission: "edit",
      grantedBy: member.id,
    });
    const { closed } = await raw(b, member.cookie);
    await a.server.db
      .delete(artifactAccess)
      .where(and(eq(artifactAccess.personId, member.id), eq(artifactAccess.artifactId, id)));
    expect(await closed).toBe(4403);
  });

  test("a publish outside the draft resets editors; offline changes stay in the store for the dialog", async () => {
    for (const client of clients.splice(0)) client.provider.destroy();
    await Bun.sleep(300);
    const store = memoryStore();
    const sockets: WebSocket[] = [];
    let blocked = false;
    const offline = await ready(await open(a, { store, sockets, blocked: () => blocked }));
    const controls: string[] = [];
    (offline.provider as unknown as { on(e: "control", l: (c: { t: string }) => void): void }).on(
      "control",
      (c) => controls.push(c.t),
    );
    blocked = true;
    // The network drops: Bun's client ends the connection without a close handshake.
    const live = sockets.at(-1) as WebSocket & { terminate?(): void };
    if (live.terminate) live.terminate();
    else live.close();
    await until(() => offline.provider.status === "offline");
    type(offline, 0, 0, "Written offline. ");
    await until(() => offline.provider.author === null);
    const key = `edit:${id}:${epoch}`;
    await Bun.sleep(500);
    expect((await store.get(key)).length).toBeGreaterThan(0);
    // Nobody is present now, so a publish lands: a handoff checkpoint, then the new version, then reset.
    const published = await mcp(a as never, token, "tools/call", {
      name: "artifacts_publish_article",
      arguments: {
        project: "brain",
        slug: "pricing",
        title: "Pricing",
        summary: "How we price.",
        markdown: "# Pricing\n\nNew.\n",
      },
    });
    expect(((await published.json()) as { result: { isError?: boolean } }).result.isError).toBeFalsy();
    blocked = false;
    await until(() => offline.provider.status === "stopped", 40_000);
    expect(offline.codes).toContain(4409);
    expect(controls).toContain("reset");
    // Nobody is left behind: no presence row and no heartbeat outlives the reset.
    await Bun.sleep(1000);
    expect(await a.server.db.select().from(editPresence).where(eq(editPresence.artifactId, id))).toEqual([]);
    const kept = new Y.Doc();
    for (const update of await store.get(key)) Y.applyUpdate(kept, update);
    expect(plain(kept)).toContain("Written offline.");
  }, 60_000);

  test("a draft past EDIT_DOC_MAX refuses growth with too_large and 4413", async () => {
    expect((await a.api(`/api/artifacts/${id}/doc/draft`, { cookie })).status).toBe(200);
    epoch = DocState.parse(await json(await a.api(`/api/artifacts/${id}/doc`, { cookie }))).epoch;
    const big = await ready(await open(a));
    big.provider.setMode("delegate");
    const chunk = "x".repeat(EDIT_UPDATE_MAX - 4096);
    for (let i = 0; i < 6 && !big.codes.includes(4413); i++) {
      type(big, 0, 0, chunk);
      await Bun.sleep(400);
    }
    await until(() => big.codes.includes(4413), 10_000);
  }, 30_000);
});
