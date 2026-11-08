import { randomUUID } from "node:crypto";
import {
  ASSETS,
  BOARD,
  BOARD_SHARES,
  boardAuthorCounts,
  DELETED,
  OBJECTS,
  REGISTERS,
  rebalanceBoard,
  repairBoard,
  TEXT_KINDS,
  validateBoard,
} from "@artifacts/doc/board";
import { isBoardObjectId } from "@artifacts/doc/board-ids";
import {
  Awareness,
  applyAwarenessUpdate,
  awarenessMessage,
  controlMessage,
  decodeAwareness,
  encodeAwareness,
  encodeAwarenessUpdate,
  readMessage,
  removeAwarenessStates,
  SYNC_STEP,
  savedMessage,
  syncStep1,
  syncStep2,
  syncUpdate,
} from "@artifacts/doc/sync";
import { FRAGMENT, fixIds, SERVER_ORIGIN, TOO_MANY_BLOCKS, validate } from "@artifacts/doc/ydoc";
import { BoardAwarenessState } from "@artifacts/schema/boards";
import {
  AGENT_PRESENCE_MS,
  EDIT_COALESCE_MS,
  EDIT_DOC_MAX,
  EDIT_EDITORS_MAX,
  EDIT_HEARTBEAT_MS,
  EDIT_MESSAGES_PER_SECOND,
  EDIT_NOTIFY_AWARENESS_MAX,
  EDIT_SOCKETS_PER_PERSON,
  EDIT_UPDATE_MAX,
  HEX_COLOR,
} from "@artifacts/schema/constants";
import {
  AwarenessState,
  type EditMode,
  EditMode as EditModeSchema,
  SYNC_CLOSE,
  type SyncControl,
} from "@artifacts/schema/editing";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { and, asc, eq, gt, inArray, isNotNull } from "drizzle-orm";
import postgres from "postgres";
import * as Y from "yjs";
import { findArtifact } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { currentCaller } from "../auth/resolve.ts";
import type { OrgRow } from "../db/index.ts";
import { lockArtifact } from "../db/locks.ts";
import { boardAssets, editAtoms, editDocs, editPresence, editUpdates, people } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { authorKey, type DocKind, editActor, editability, loadDoc, persistUpdate } from "../editing/store.ts";
import { ApiError } from "../http/errors.ts";
import type { RouteContext } from "../http/routes.ts";
import type { Logger } from "../log.ts";

/**
 * The draft's live sync (13, "Sync"): y-protocols over Bun's WebSocket on the viewer port, every update
 * checked and persisted before anyone else sees it, and `NOTIFY artifacts_docs` between replicas.
 */

const CHANNEL = "artifacts_docs";
const PING_MS = 30_000;
/** A replica keeps a document this long after its last local editor leaves. */
const HOLD_MS = 60_000;
/** A connection whose send buffer passes this is too far behind to catch up: 1013, and it reconnects. */
const SEND_BUFFER_MAX = 4 * 1024 * 1024;
const PRESENCE_WRITE_MS = 1000;
/** Agents renew their awareness state well inside y-protocols' 30-second timeout. */
const AGENT_RENEW_MS = 15_000;
const REMOTE = "remote";
/** An update the live document may relay: a connection's (persisted first), the catch-up's or the server's. */
const persistedOrigin = (origin: unknown) =>
  origin === REMOTE ||
  origin === SERVER_ORIGIN ||
  (typeof origin === "object" && origin !== null && "ws" in origin && "personId" in origin);
const AGENT_COLOR = "#2f5fb3";

type PersonCaller = Extract<Caller, { kind: "person" }>;
type Note = { d: string; s: number; r: string; k: "u" | "a" | "c" | "q"; a?: string };

export type SyncData = {
  artifactId: string;
  org: OrgRow;
  caller: PersonCaller;
  epoch: number | null;
  id: string;
};

type Conn = {
  ws: ServerWebSocket<SyncData>;
  id: string;
  personId: string;
  name: string;
  author: string;
  mode: EditMode;
  block: string | null;
  pending: string[];
  /** Board holds: selected/dragged/edited objects and unsent object changes (14, "Sync and holds"). */
  objects: string[];
  /** Awareness client ids this connection introduced: it may update only these. */
  clients: Set<number>;
  /** Checked updates not yet persisted. They are in the shadow, never in the document editors see. */
  updates: Uint8Array[];
  /** Updates accepted on this connection, and how many of them are persisted: `saved` says the latter. */
  accepted: number;
  saving: Promise<void>;
  flush: Timer | null;
  window: { start: number; count: number };
  presence: { chain: Promise<void>; mode: EditMode; at: number; timer: Timer | null; written: string };
  heartbeat: Timer | null;
  ready: boolean;
  /** Messages that arrived before `hello`: replayed once the document is held. */
  early: Uint8Array[];
  closed: boolean;
};

type AgentState = { client: number; clock: number; until: number; renew: Timer | null; state: unknown };

type Held = {
  artifactId: string;
  orgId: string;
  /** Which validator, model and author counts this document uses: the row's kind, never guessed. */
  kind: DocKind;
  epoch: number;
  version: number;
  /** The document every editor sees. */
  ydoc: Y.Doc;
  /** A copy each client update is tried on first, so a bad one never reaches `ydoc`. */
  shadow: Y.Doc;
  awareness: Awareness;
  conns: Set<Conn>;
  owners: Map<number, Conn>;
  lastSeq: number;
  /** Work on this document, one at a time: updates, catch-ups. */
  chain: Promise<void>;
  release: Timer | null;
  /** Article atom hashes, or a board's validated image hashes. */
  atoms: Set<string>;
  /** The most characters each author key has had: a key other than the writer's may not gain past it. */
  high: Map<string, number>;
  size: number;
  collect: Collector | null;
};

type Collector = {
  touched: Set<string>;
  problem: string | null;
  foreign: boolean;
  own: string;
  /** Board image hashes the update added to `assets`. */
  assets: Set<string>;
};

/** Characters per author key, by the document's kind. */
const countsOf = (kind: DocKind, ydoc: Y.Doc) =>
  kind === "board" ? boardAuthorCounts(ydoc) : authorCounts(ydoc);
const AUTHOR_KEY = /^a[1-9][0-9]*$/;
const FUTURE_MS = 10 * 60_000;

/** A board register or tombstone stamped by this connection, at a believable time. */
function ownStamp(value: unknown, own: string): string | null {
  const stamp = value as { a?: unknown; t?: unknown } | null;
  if (!stamp || typeof stamp !== "object" || typeof stamp.a !== "string" || typeof stamp.t !== "string")
    return "a change without an author";
  if (stamp.a !== own) return "a change marked with someone else's key";
  const at = Date.parse(stamp.t);
  if (Number.isNaN(at) || at > Date.now() + FUTURE_MS) return "an author time in the future";
  return null;
}

/** Board text a client inserted: its own key, or a known key that may not grow (as articles). */
function checkBoardText(
  attributes: Record<string, unknown> | undefined,
  collect: Collector,
  allowed: (key: string) => boolean,
): string | null {
  const author = attributes?.author as { a?: unknown; t?: unknown } | undefined;
  if (!author || typeof author.a !== "string" || !AUTHOR_KEY.test(author.a)) return "text without an author";
  if (
    typeof author.t !== "string" ||
    Number.isNaN(Date.parse(author.t)) ||
    Date.parse(author.t) > Date.now() + FUTURE_MS
  )
    return "an author time in the future";
  if (author.a !== collect.own) {
    if (!allowed(author.a)) return "text marked with someone else's key";
    collect.foreign = true;
  }
  return null;
}

/** A whole new object map from a client: its own id, made entirely by this connection. */
function checkNewObject(id: string, map: unknown, collect: Collector): string | null {
  if (!(map instanceof Y.Map)) return "an object that isn't a map";
  if (!isBoardObjectId(id) || map.get("id") !== id) return "an object with the wrong id";
  const kind = map.get("kind");
  // Rendered frames are the server's: only publishing makes or changes them.
  if (kind === "rendered_frame") return "a rendered frame from a client";
  const created = ownStamp(map.get("created"), collect.own);
  if (created) return created;
  for (const key of REGISTERS) {
    const problem = ownStamp(map.get(key), collect.own);
    if (problem) return problem;
  }
  const text = map.get("text");
  if (text !== undefined) {
    if (!(text instanceof Y.Text) || !TEXT_KINDS.has(kind as never)) return "text on an object without text";
    for (const op of text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
      if (typeof op.insert !== "string") return "an embed in text";
      const author = op.attributes?.author as { a?: unknown } | undefined;
      if (author?.a !== collect.own) return "a new object with someone else's text";
      const problem = checkBoardText(op.attributes, collect, () => false);
      if (problem) return problem;
    }
  }
  return null;
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromBase64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));
const minutesNow = () => Math.floor(Date.now() / 60_000);

/** Characters per author key over the whole document. */
function authorCounts(ydoc: Y.Doc): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (type: Y.XmlElement | Y.XmlFragment | Y.XmlText) => {
    if (type instanceof Y.XmlText) {
      for (const op of type.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
        const a = (op.attributes?.author as { a?: string } | undefined)?.a;
        if (a && typeof op.insert === "string") counts.set(a, (counts.get(a) ?? 0) + op.insert.length);
      }
      return;
    }
    for (const child of type.toArray()) walk(child as Y.XmlElement | Y.XmlText);
  };
  walk(ydoc.getXmlFragment(FRAGMENT));
  return counts;
}

/** The top-level block a type sits in, or null for the fragment itself. */
function topOf(type: Y.AbstractType<unknown>, fragment: Y.XmlFragment): Y.XmlElement | null {
  let at: Y.AbstractType<unknown> | null = type;
  while (at && at.parent !== fragment) {
    if (at === fragment) return null;
    at = at.parent as Y.AbstractType<unknown> | null;
  }
  return at instanceof Y.XmlElement ? at : null;
}

/** Checks the authors on text a client inserted (13, "Attribution"). Returns a problem, or null. */
function checkInsertedText(
  attributes: Record<string, unknown> | undefined,
  collect: Collector,
  allowed: (key: string) => boolean,
): string | null {
  const author = attributes?.author as { a?: unknown; t?: unknown } | undefined;
  if (!author || typeof author.a !== "string") return "text without an author";
  if (typeof author.t !== "number" || author.t > minutesNow() + 10) return "an author time in the future";
  if (author.a !== collect.own) {
    if (!allowed(author.a)) return "text marked with someone else's key";
    collect.foreign = true;
  }
  return null;
}

function checkNewType(
  type: Y.AbstractType<unknown>,
  collect: Collector,
  allowed: (key: string) => boolean,
): string | null {
  if (type instanceof Y.XmlText) {
    for (const op of type.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
      if (typeof op.insert !== "string") return "an embed in text";
      const problem = checkInsertedText(op.attributes, collect, allowed);
      if (problem) return problem;
    }
    return null;
  }
  if (type instanceof Y.XmlElement) {
    for (const child of type.toArray()) {
      const problem = checkNewType(child as Y.AbstractType<unknown>, collect, allowed);
      if (problem) return problem;
    }
    return null;
  }
  return "an unexpected shared type";
}

/**
 * The hub: holds documents with local editors, and fans updates, awareness and control messages out
 * between replicas (13, "Replicas"). It follows `Events`: LISTEN at boot, a ping to itself, and a
 * reconnect when the listener goes quiet, after which every held document reloads by seq.
 */
export class DocHub {
  readonly replica = randomUUID().slice(0, 8);
  private client: postgres.Sql;
  private deps: Deps | null = null;
  private readonly held = new Map<string, Held>();
  private readonly loading = new Map<string, Promise<Held>>();
  private readonly perPerson = new Map<string, number>();
  private readonly agents = new Map<string, Map<string, AgentState>>();
  private timer: Timer | null = null;
  private heard = Date.now();
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
    private readonly pingMs = PING_MS,
  ) {
    this.client = this.connect();
  }

  private connect() {
    return postgres(this.url, { max: 1, onnotice: () => {} });
  }

  attach(deps: Deps) {
    this.deps = deps;
  }

  private get d(): Deps {
    if (!this.deps) throw new Error("DocHub used before attach");
    return this.deps;
  }

  private listen() {
    return this.client.listen(CHANNEL, (payload) => {
      this.heard = Date.now();
      try {
        this.receive(JSON.parse(payload) as Note);
      } catch (error) {
        this.log.warn("bad docs notification", { error: String(error) });
      }
    });
  }

  async start() {
    await this.listen();
    this.timer = setInterval(() => {
      void this.client
        .notify(CHANNEL, JSON.stringify({ d: "", s: 0, r: this.replica, k: "q" }))
        .catch(() => {});
      if (Date.now() - this.heard > this.pingMs * 3) this.reconnect().catch(() => {});
    }, this.pingMs);
    this.timer.unref();
  }

  /** After an outage: listen again, reload every held document by seq, and ask for awareness again. */
  async reconnect() {
    const old = this.client;
    const client = this.connect();
    this.client = client;
    this.heard = Date.now();
    old.end({ timeout: 1 }).catch(() => {});
    await this.listen();
    if (client !== this.client) return;
    this.heard = Date.now();
    for (const held of this.held.values()) {
      this.catchUp(held);
      this.send({ d: held.artifactId, s: held.lastSeq, r: this.replica, k: "q" });
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const held of this.held.values()) {
      for (const conn of held.conns) this.close(conn, SYNC_CLOSE.restarting, "restarting");
      this.drop(held);
    }
    for (const states of this.agents.values())
      for (const agent of states.values()) clearInterval(agent.renew ?? undefined);
    await this.client.end({ timeout: 1 });
  }

  private send(note: Note) {
    void this.client.notify(CHANNEL, JSON.stringify(note)).catch(() => {});
  }

  /**
   * Tells editors on every replica (13, "Replicas"): `u` after an update was persisted (`{ seq }`), `c`
   * a control message, `a` an awareness update. Worker code calls it after its transaction commits.
   */
  notify(artifactId: string, kind: "u" | "a" | "c", payload: unknown) {
    if (kind === "u") {
      const seq = Number((payload as { seq?: number }).seq ?? 0);
      const held = this.held.get(artifactId);
      if (held) this.catchUp(held);
      this.send({ d: artifactId, s: seq, r: this.replica, k: "u" });
    } else if (kind === "c") {
      this.control(artifactId, payload as SyncControl);
      this.send({
        d: artifactId,
        s: 0,
        r: this.replica,
        k: "c",
        a: toBase64(new TextEncoder().encode(JSON.stringify(payload))),
      });
    } else {
      const bytes = payload as Uint8Array;
      const held = this.held.get(artifactId);
      if (held) applyAwarenessUpdate(held.awareness, bytes, REMOTE);
      if (bytes.length <= EDIT_NOTIFY_AWARENESS_MAX)
        this.send({ d: artifactId, s: 0, r: this.replica, k: "a", a: toBase64(bytes) });
    }
  }

  private receive(note: Note) {
    if (note.r === this.replica) return;
    if (note.k === "q") {
      if (!note.d) return;
      const held = this.held.get(note.d);
      if (!held) return;
      const mine = [...held.owners.keys()].filter((client) => held.awareness.getStates().has(client));
      for (const states of [this.agents.get(note.d)])
        for (const agent of states?.values() ?? []) mine.push(agent.client);
      if (mine.length) this.publishAwareness(held, encodeAwarenessUpdate(held.awareness, mine));
      return;
    }
    const held = this.held.get(note.d);
    if (note.k === "u") {
      if (held && note.s > held.lastSeq) this.catchUp(held);
    } else if (note.k === "c" && note.a) {
      this.control(note.d, JSON.parse(new TextDecoder().decode(fromBase64(note.a))) as SyncControl);
    } else if (note.k === "a" && note.a && held) {
      applyAwarenessUpdate(held.awareness, fromBase64(note.a), REMOTE);
    }
  }

  /** A control message for every local editor of the page. `reset` ends their sessions on this epoch. */
  private control(artifactId: string, control: SyncControl) {
    const held = this.held.get(artifactId);
    if (!held) return;
    const message = controlMessage(control);
    for (const conn of held.conns) this.write(conn, message);
    if (control.t === "reset") {
      for (const conn of [...held.conns]) this.close(conn, SYNC_CLOSE.reset, "reset");
      this.drop(held);
    }
    if (control.t === "checkpoint") held.version = control.version;
  }

  private publishAwareness(held: Held, update: Uint8Array) {
    if (update.length <= EDIT_NOTIFY_AWARENESS_MAX)
      this.send({ d: held.artifactId, s: 0, r: this.replica, k: "a", a: toBase64(update) });
  }

  /** Reads updates this replica hasn't applied, in seq order, from the snapshot if it fell behind it. */
  private catchUp(held: Held) {
    held.chain = held.chain
      .then(async () => {
        if (!this.held.has(held.artifactId)) return;
        const deps = this.d;
        const [row] = await deps.db
          .select({ epoch: editDocs.epoch, snapshotSeq: editDocs.snapshotSeq, version: editDocs.version })
          .from(editDocs)
          .where(eq(editDocs.artifactId, held.artifactId));
        if (!row) return;
        if (row.epoch !== held.epoch) {
          this.control(held.artifactId, { t: "reset", epoch: row.epoch, version: row.version });
          return;
        }
        if (held.lastSeq < row.snapshotSeq) {
          const [snap] = await deps.db
            .select({ snapshot: editDocs.snapshot, snapshotSeq: editDocs.snapshotSeq })
            .from(editDocs)
            .where(eq(editDocs.artifactId, held.artifactId));
          if (snap && snap.snapshot.length > 0) {
            this.applyRemote(held, snap.snapshot);
            held.lastSeq = Math.max(held.lastSeq, snap.snapshotSeq);
          }
        }
        const rows = await deps.db
          .select({ seq: editUpdates.seq, update: editUpdates.update })
          .from(editUpdates)
          .where(
            and(
              eq(editUpdates.artifactId, held.artifactId),
              eq(editUpdates.epoch, held.epoch),
              gt(editUpdates.seq, held.lastSeq),
            ),
          )
          .orderBy(asc(editUpdates.seq));
        for (const { seq, update } of rows) {
          this.applyRemote(held, update);
          held.lastSeq = Math.max(held.lastSeq, seq);
        }
        // Words other replicas and operations added count toward each author's most, as local ones do.
        if (rows.length > 0)
          for (const [key, n] of countsOf(held.kind, held.ydoc))
            held.high.set(key, Math.max(held.high.get(key) ?? 0, n));
      })
      .catch((error) => this.log.warn("couldn't catch a draft up", { error: String(error) }));
  }

  /** An update from the database: to both copies, and to local editors if it changed anything. */
  private applyRemote(held: Held, update: Uint8Array) {
    Y.applyUpdate(held.shadow, update, REMOTE);
    Y.applyUpdate(held.ydoc, update, REMOTE);
    held.size += update.length;
  }

  /** Holds a document: loads it once, however many sockets open at once. */
  private hold(artifactId: string): Promise<Held> {
    const held = this.held.get(artifactId);
    if (held) {
      if (held.release) clearTimeout(held.release);
      held.release = null;
      return Promise.resolve(held);
    }
    const loading = this.loading.get(artifactId);
    if (loading) return loading;
    const promise = this.load(artifactId).finally(() => this.loading.delete(artifactId));
    this.loading.set(artifactId, promise);
    return promise;
  }

  private async load(artifactId: string): Promise<Held> {
    const deps = this.d;
    const { ydoc, row } = await loadDoc(deps, artifactId);
    const kind: DocKind = row.kind === "board" ? "board" : "article";
    const atoms =
      kind === "board"
        ? await deps.db
            .select({ hash: boardAssets.hash })
            .from(boardAssets)
            .where(and(eq(boardAssets.artifactId, artifactId), isNotNull(boardAssets.validatedAt)))
        : await deps.db
            .select({ hash: editAtoms.hash })
            .from(editAtoms)
            .where(eq(editAtoms.artifactId, artifactId));
    const shadow = new Y.Doc();
    const state = Y.encodeStateAsUpdate(ydoc);
    Y.applyUpdate(shadow, state);
    const awareness = new Awareness(new Y.Doc());
    awareness.setLocalState(null);
    const held: Held = {
      artifactId,
      orgId: row.orgId,
      kind,
      epoch: row.epoch,
      version: row.version,
      ydoc,
      shadow,
      awareness,
      conns: new Set(),
      owners: new Map(),
      lastSeq: row.seq,
      chain: Promise.resolve(),
      release: null,
      atoms: new Set(atoms.map((atom) => atom.hash)),
      high: countsOf(kind, ydoc),
      size: state.length,
      collect: null,
    };
    this.watch(held);
    // Only persisted updates reach this document, and each one goes to every editor once: whichever of
    // the writer's own commit or the catch-up that reads it back applies it first.
    // Only those: a transaction Yjs runs itself after one of them (its author-format tidy-up, origin
    // null) was never persisted, and every client makes the same one locally, so it isn't relayed.
    ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      if (!persistedOrigin(origin)) return;
      const message = syncUpdate(update);
      for (const conn of held.conns) if (conn !== origin) this.write(conn, message);
    });
    awareness.on(
      "update",
      (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = [...changes.added, ...changes.updated, ...changes.removed];
        if (changed.length === 0) return;
        const update = encodeAwarenessUpdate(awareness, changed);
        const message = awarenessMessage(update);
        for (const conn of held.conns) if (conn !== origin) this.write(conn, message);
        if (origin !== REMOTE && origin !== "timeout") this.publishAwareness(held, update);
      },
    );
    this.held.set(artifactId, held);
    return held;
  }

  /** Collects what a client update touched on the shadow, and checks its authors as it lands. */
  private watch(held: Held) {
    if (held.kind === "board") return this.watchBoard(held);
    const fragment = held.shadow.getXmlFragment(FRAGMENT);
    fragment.observeDeep((events) => {
      const collect = held.collect;
      if (!collect) return;
      const allowed = (key: string) => key === collect.own || (held.high.get(key) ?? 0) > 0;
      for (const event of events) {
        const top = topOf(event.target, fragment);
        if (top) collect.touched.add(String(top.getAttribute("id") ?? ""));
        if (collect.problem) continue;
        if (event.target instanceof Y.XmlText) {
          for (const op of event.delta as {
            insert?: unknown;
            retain?: number;
            attributes?: Record<string, unknown>;
          }[]) {
            if (typeof op.insert === "string")
              collect.problem = checkInsertedText(op.attributes, collect, allowed);
            else if (op.insert !== undefined) collect.problem = "an embed in text";
            else if (op.retain !== undefined && op.attributes && "author" in op.attributes)
              // y-prosemirror diffs text by characters, so typing a letter equal to the next one marks
              // the old letter as the typist's and inserts the new one with the old author. What counts
              // is the authorship that results: a known key, and no key but the writer's gaining words.
              collect.problem =
                op.attributes.author === null
                  ? "text left without an author"
                  : checkInsertedText(op.attributes, collect, allowed);
            if (collect.problem) break;
          }
        } else {
          for (const item of event.changes.added) {
            const content = item.content as { type?: Y.AbstractType<unknown> };
            if (!content.type) {
              collect.problem = "content that isn't a shared type";
              break;
            }
            if (event.target === fragment && content.type instanceof Y.XmlElement)
              collect.touched.add(String(content.type.getAttribute("id") ?? ""));
            collect.problem = checkNewType(content.type as Y.AbstractType<unknown>, collect, allowed);
            if (collect.problem) break;
          }
        }
      }
    });
  }

  /**
   * The board's check as an update lands on the shadow (14, "Per-object attribution must travel in
   * updates"): objects are added whole by this connection and never replaced or removed; ids, kinds,
   * creation stamps and text slots never change; every changed register carries this connection's key;
   * rendered frames and stroke points are never a client's to change; a tombstone is this connection's
   * to add, and only its own to clear (its undo); board meta never changes; images are only added.
   */
  private watchBoard(held: Held) {
    const shadow = held.shadow;
    const objects = shadow.getMap<Y.Map<unknown>>(OBJECTS);
    const deleted = shadow.getMap<{ a?: string }>(DELETED);
    const fail = (collect: Collector, problem: string | null) => {
      if (problem && !collect.problem) collect.problem = problem;
    };
    objects.observeDeep((events) => {
      const collect = held.collect;
      if (!collect) return;
      const allowed = (key: string) => key === collect.own || (held.high.get(key) ?? 0) > 0;
      for (const event of events) {
        if (collect.problem) return;
        if (event.target === objects) {
          for (const [id, change] of (event as Y.YMapEvent<unknown>).changes.keys) {
            collect.touched.add(id);
            if (change.action !== "add") fail(collect, "objects are deleted with a tombstone, never removed");
            else fail(collect, checkNewObject(id, objects.get(id), collect));
          }
          continue;
        }
        if (event.target instanceof Y.Text) {
          const map = event.target.parent;
          if (!(map instanceof Y.Map) || map.parent !== objects) {
            fail(collect, "text outside an object");
            continue;
          }
          collect.touched.add(String(map.get("id")));
          for (const op of event.delta as {
            insert?: unknown;
            retain?: number;
            attributes?: Record<string, unknown>;
          }[]) {
            if (typeof op.insert === "string") fail(collect, checkBoardText(op.attributes, collect, allowed));
            else if (op.insert !== undefined) fail(collect, "an embed in text");
            else if (op.retain !== undefined && op.attributes)
              // Yjs' own format cleanup may drop an author mark (null): the model projects that span to
              // its neighbour's author. Any other formatting is refused; a new author must be allowed.
              fail(
                collect,
                Object.keys(op.attributes).some((k) => k !== "author")
                  ? "text with formatting other than its author"
                  : op.attributes.author === null
                    ? null
                    : checkBoardText(op.attributes, collect, allowed),
              );
          }
          continue;
        }
        const map = event.target;
        if (!(map instanceof Y.Map) || map.parent !== objects) {
          fail(collect, "a change outside an object's fields");
          continue;
        }
        const id = String(map.get("id"));
        collect.touched.add(id);
        const kind = map.get("kind");
        for (const [key, change] of (event as Y.YMapEvent<unknown>).changes.keys) {
          if (!(REGISTERS as readonly string[]).includes(key) || change.action !== "update") {
            fail(collect, `an object's ${key} can't change`);
            continue;
          }
          if (key === "data" && (kind === "rendered_frame" || kind === "stroke"))
            fail(
              collect,
              kind === "stroke" ? "a stroke's points can't change" : "a rendered frame is published",
            );
          fail(collect, ownStamp(map.get(key), collect.own));
        }
      }
    });
    deleted.observe((event) => {
      const collect = held.collect;
      if (!collect) return;
      for (const [id, change] of event.changes.keys) {
        collect.touched.add(id);
        if (change.action === "add") fail(collect, ownStamp(deleted.get(id), collect.own));
        else if (change.action === "delete") {
          // Clearing a tombstone is an undo of this connection's own deletion, checked from the old value.
          const old = change.oldValue as { a?: string } | undefined;
          if (old?.a !== collect.own) fail(collect, "a deletion that isn't yours to undo");
          // A checkpoint removed the hidden object itself; nothing is left to restore.
          else if (!objects.has(id)) fail(collect, "that object was removed at a checkpoint");
        } else fail(collect, "a tombstone can't change");
      }
    });
    shadow.getMap(BOARD).observe(() => {
      if (held.collect) fail(held.collect, "a board's page can't change");
    });
    const assets = shadow.getMap(ASSETS);
    assets.observe((event) => {
      const collect = held.collect;
      if (!collect) return;
      for (const [hash, change] of event.changes.keys) {
        if (change.action !== "add") fail(collect, "an image's metadata can't change");
        else collect.assets.add(hash);
      }
    });
  }

  /** Images this artifact validated since the document was held, on any replica. */
  private async refreshAssets(held: Held, wanted: string[]) {
    const missing = wanted.filter((hash) => !held.atoms.has(hash));
    if (missing.length === 0) return;
    const rows = await this.d.db
      .select({ hash: boardAssets.hash })
      .from(boardAssets)
      .where(
        and(
          eq(boardAssets.artifactId, held.artifactId),
          inArray(boardAssets.hash, missing),
          isNotNull(boardAssets.validatedAt),
        ),
      );
    for (const row of rows) held.atoms.add(row.hash);
  }

  private drop(held: Held) {
    if (this.held.get(held.artifactId) !== held) return;
    this.held.delete(held.artifactId);
    if (held.release) clearTimeout(held.release);
    // Every connection leaves properly: timers stop and presence rows go. Their unsaved updates belong
    // to the old epoch and aren't written; the clients keep them.
    for (const conn of [...held.conns]) {
      this.close(conn, SYNC_CLOSE.reset, "reset");
      this.leave(held, conn, false);
    }
    held.awareness.destroy();
    held.ydoc.destroy();
    held.shadow.destroy();
  }

  private write(conn: Conn, message: Uint8Array) {
    if (conn.closed) return;
    conn.ws.send(message);
    if (conn.ws.getBufferedAmount() > SEND_BUFFER_MAX) this.close(conn, 1013, "too far behind");
  }

  private close(conn: Conn, code: number, reason: string) {
    if (conn.closed) return;
    conn.closed = true;
    try {
      conn.ws.close(code, reason);
    } catch {}
  }

  // Sockets.

  async open(ws: ServerWebSocket<SyncData>) {
    const deps = this.d;
    const { artifactId, caller } = ws.data;
    const conn: Conn = {
      ws,
      id: ws.data.id,
      personId: caller.person.id,
      name: caller.person.name,
      author: "",
      mode: "write",
      block: null,
      pending: [],
      objects: [],
      clients: new Set(),
      updates: [],
      accepted: 0,
      saving: Promise.resolve(),
      flush: null,
      window: { start: Date.now(), count: 0 },
      presence: { chain: Promise.resolve(), mode: "write", at: 0, timer: null, written: "" },
      heartbeat: null,
      ready: false,
      early: [],
      closed: false,
    };
    (ws.data as SyncData & { conn?: Conn }).conn = conn;
    const count = (this.perPerson.get(conn.personId) ?? 0) + 1;
    this.perPerson.set(conn.personId, count);
    if (count > EDIT_SOCKETS_PER_PERSON) return this.close(conn, SYNC_CLOSE.rateLimited, "too many sockets");
    try {
      const artifact = await findArtifact(deps, ws.data.org.id, artifactId);
      const editable = artifact ? await editability(deps, artifact) : null;
      if (!artifact || !editable?.editable || !can(caller, "artifact.edit", artifact))
        return this.close(conn, SYNC_CLOSE.notFound, "not found");
      const held = await this.hold(artifactId);
      if (conn.closed) return this.leave(held, conn);
      // A board update can't enter an article document, nor the other way round.
      if (held.kind !== editable.kind) return this.close(conn, SYNC_CLOSE.notFound, "not found");
      if (held.conns.size >= EDIT_EDITORS_MAX)
        return this.close(conn, SYNC_CLOSE.rateLimited, "too many editors");
      // Epoch 0 is what DocState says before the first seed: that draft is the one just loaded.
      if (ws.data.epoch !== null && ws.data.epoch !== 0 && ws.data.epoch !== held.epoch) {
        this.write(conn, controlMessage({ t: "reset", epoch: held.epoch, version: held.version }));
        return this.close(conn, SYNC_CLOSE.reset, "reset");
      }
      held.conns.add(conn);
      conn.author = await authorKey(deps, artifactId, editActor(caller, null), []);
      if (conn.closed || this.held.get(artifactId) !== held) return this.leave(held, conn);
      await deps.db
        .insert(editPresence)
        .values({
          artifactId,
          connectionId: conn.id,
          orgId: held.orgId,
          personId: conn.personId,
          mode: conn.mode,
          blocks: [],
          replica: this.replica,
          seenAt: deps.clock.now(),
        })
        .onConflictDoNothing();
      // Closed or reset while the row was written: leave() deletes it again.
      if (conn.closed || this.held.get(artifactId) !== held) return this.leave(held, conn);
      this.write(
        conn,
        controlMessage({
          t: "hello",
          author: conn.author,
          epoch: held.epoch,
          seq: held.lastSeq,
          version: held.version,
          canAccept: can(caller, "artifact.accept", artifact),
        }),
      );
      this.write(conn, syncStep1(held.ydoc));
      const states = [...held.awareness.getStates().keys()];
      if (states.length) this.write(conn, awarenessMessage(encodeAwarenessUpdate(held.awareness, states)));
      conn.ready = true;
      conn.heartbeat = setInterval(
        () => void this.beat(held, conn),
        deps.events.heartbeatMs ?? EDIT_HEARTBEAT_MS,
      );
      for (const message of conn.early.splice(0)) this.message(ws, message);
    } catch (error) {
      this.log.warn("couldn't open a sync socket", { error: String(error) });
      this.close(
        conn,
        error instanceof ApiError && error.code === "conflict" ? SYNC_CLOSE.notFound : 1011,
        "error",
      );
    }
  }

  /** Every heartbeat: still signed in, still allowed to edit (else 4403), and presence kept fresh. */
  private async beat(held: Held, conn: Conn) {
    const deps = this.d;
    if (conn.closed || this.held.get(held.artifactId) !== held) {
      if (conn.heartbeat) clearInterval(conn.heartbeat);
      return;
    }
    try {
      const { org, caller, artifactId } = conn.ws.data;
      const [fresh, artifact] = await Promise.all([
        currentCaller(deps, org, caller),
        findArtifact(deps, org.id, artifactId),
      ]);
      if (!fresh || !artifact || !can(fresh, "artifact.edit", artifact))
        return this.close(conn, SYNC_CLOSE.lostAccess, "lost access");
      await this.writePresence(held, conn, true);
    } catch (error) {
      this.log.warn("sync heartbeat failed", { error: String(error) });
    }
  }

  /** Writes the presence row, in order with this connection's other writes. */
  private writePresence(held: Held, conn: Conn, force = false): Promise<void> {
    const next = conn.presence.chain.catch(() => {}).then(() => this.savePresence(held, conn, force));
    conn.presence.chain = next;
    return next;
  }

  /**
   * A caret or pending change is written at most once a second. A mode change is written at once, and a
   * switch to Write or Pair under the page's lock, which an agent's op holds while it applies: an op that
   * hasn't committed by then reads the new mode (13, "Policy").
   */
  private async savePresence(held: Held, conn: Conn, force: boolean) {
    if (conn.closed || this.held.get(held.artifactId) !== held) return;
    const blocks = [conn.block, ...conn.pending].filter((block): block is string => Boolean(block));
    const written = JSON.stringify([conn.mode, blocks, conn.objects]);
    if (!force && written === conn.presence.written) return;
    const mode = conn.mode;
    const moded = mode !== conn.presence.mode;
    const wait = conn.presence.at + PRESENCE_WRITE_MS - Date.now();
    if (!force && !moded && wait > 0) {
      conn.presence.timer ??= setTimeout(() => {
        conn.presence.timer = null;
        void this.writePresence(held, conn).catch(() => {});
      }, wait);
      return;
    }
    conn.presence.at = Date.now();
    conn.presence.written = written;
    const row = and(eq(editPresence.artifactId, held.artifactId), eq(editPresence.connectionId, conn.id));
    const values = {
      mode,
      objects: [...new Set(conn.objects)],
      blocks: [...new Set(blocks)].slice(0, 51),
      seenAt: this.d.clock.now(),
    };
    try {
      if (moded && mode !== "delegate")
        await this.d.db.transaction(async (tx) => {
          await lockArtifact(tx, held.artifactId, "content");
          await tx.update(editPresence).set(values).where(row);
        });
      else await this.d.db.update(editPresence).set(values).where(row);
      conn.presence.mode = mode;
    } catch (error) {
      // Not written: the next change or heartbeat writes it again.
      conn.presence.written = "";
      throw error;
    }
  }

  message(ws: ServerWebSocket<SyncData>, raw: string | Buffer | Uint8Array) {
    const conn = (ws.data as SyncData & { conn?: Conn }).conn;
    if (!conn || conn.closed) return;
    if (typeof raw === "string") return this.close(conn, SYNC_CLOSE.invalidUpdate, "binary only");
    const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (data.length > EDIT_UPDATE_MAX) return this.close(conn, SYNC_CLOSE.tooLarge, "too large");
    const now = Date.now();
    if (now - conn.window.start >= 1000) conn.window = { start: now, count: 0 };
    if (++conn.window.count > EDIT_MESSAGES_PER_SECOND) {
      this.write(conn, controlMessage({ t: "error", code: "rate_limited", message: "Too many messages." }));
      return this.close(conn, SYNC_CLOSE.rateLimited, "rate limited");
    }
    if (!conn.ready) {
      conn.early.push(data);
      return;
    }
    const held = this.held.get(ws.data.artifactId);
    if (!held?.conns.has(conn)) return;
    let incoming: ReturnType<typeof readMessage>;
    try {
      incoming = readMessage(data);
    } catch {
      return this.close(conn, SYNC_CLOSE.invalidUpdate, "malformed");
    }
    switch (incoming.type) {
      case "sync":
        if (incoming.step === SYNC_STEP.step1) this.write(conn, syncStep2(held.ydoc, incoming.payload));
        else if (incoming.step === SYNC_STEP.step2 || incoming.step === SYNC_STEP.update)
          this.update(held, conn, incoming.payload);
        return;
      case "awareness":
        return this.awareness(held, conn, incoming.update);
      case "queryAwareness": {
        const states = [...held.awareness.getStates().keys()];
        if (states.length) this.write(conn, awarenessMessage(encodeAwarenessUpdate(held.awareness, states)));
        return;
      }
      case "control": {
        const mode = EditModeSchema.safeParse((incoming.json as { t?: string; mode?: unknown })?.mode);
        if ((incoming.json as { t?: string })?.t === "mode" && mode.success) {
          conn.mode = mode.data;
          void this.writePresence(held, conn).catch(() => {});
        }
        return;
      }
      default:
        return;
    }
  }

  /** A client's update (13, "Writing an update"): checked on the shadow, applied, coalesced, persisted. */
  private update(held: Held, conn: Conn, update: Uint8Array) {
    held.chain = held.chain.then(async () => {
      if (conn.closed || !this.held.has(held.artifactId)) return;
      const collect: Collector = {
        touched: new Set(),
        problem: null,
        foreign: false,
        own: conn.author,
        assets: new Set(),
      };
      held.collect = collect;
      try {
        Y.applyUpdate(held.shadow, update, conn);
      } catch {
        collect.problem = "an update that doesn't decode";
      } finally {
        held.collect = null;
      }
      let problem = collect.problem;
      let overBlocks = false;
      if (!problem && held.kind === "article") {
        for (const name of held.shadow.share.keys())
          if (name !== FRAGMENT && BOARD_SHARES.has(name)) problem = "a board change in an article";
        if (!problem && collect.touched.size > 0) {
          const result = validate(held.shadow, collect.touched, { atoms: (hash) => held.atoms.has(hash) });
          if (!result.ok) {
            problem = result.reason;
            overBlocks = result.reason === TOO_MANY_BLOCKS;
          }
        }
      } else if (!problem) {
        // Shared types, graph and limits on every update; each touched object in full.
        const check = () => validateBoard(held.shadow, { assets: held.atoms, touched: collect.touched });
        let result = check();
        if (!result.ok && /image/.test(result.reason)) {
          // Committed on another replica a moment ago: look again before refusing.
          const images = [
            ...collect.assets,
            ...[...collect.touched].flatMap((id) => {
              const data = held.shadow.getMap<Y.Map<unknown>>(OBJECTS).get(id)?.get("data") as
                | { value?: { asset?: unknown } }
                | undefined;
              return typeof data?.value?.asset === "string" ? [data.value.asset] : [];
            }),
          ];
          await this.refreshAssets(held, images);
          if (conn.closed || this.held.get(held.artifactId) !== held) return;
          result = check();
        }
        if (!result.ok) {
          problem = result.reason;
          overBlocks = result.reason === "too many objects";
        }
      }
      let counts: Map<string, number> | null = null;
      if (!problem && collect.foreign) {
        counts = countsOf(held.kind, held.shadow);
        for (const [key, n] of counts)
          if (key !== conn.author && n > (held.high.get(key) ?? 0))
            problem = "text marked with someone else's key";
      }
      let tooLarge = false;
      if (!problem && held.size + update.length > EDIT_DOC_MAX) {
        held.size = Y.encodeStateAsUpdate(held.shadow).length;
        tooLarge = held.size > EDIT_DOC_MAX;
      }
      if (overBlocks) tooLarge = true;
      if (problem || tooLarge) {
        // The shadow took the bad update: start it again from the document everyone sees.
        held.shadow.destroy();
        held.shadow = this.rebuildShadow(held);
        this.watch(held);
        if (tooLarge) {
          this.write(
            conn,
            controlMessage({
              t: "error",
              code: "too_large",
              message: overBlocks
                ? held.kind === "board"
                  ? "This board has too many objects."
                  : "This page has too many blocks."
                : "This page is too large to grow.",
            }),
          );
          return this.close(conn, SYNC_CLOSE.tooLarge, "too large");
        }
        this.log.info("refused a draft update", { artifact: held.artifactId, reason: problem });
        this.write(
          conn,
          controlMessage({ t: "error", code: "invalid_update", message: problem ?? "invalid" }),
        );
        return this.close(conn, SYNC_CLOSE.invalidUpdate, "invalid update");
      }
      held.size += update.length;
      if (counts) for (const [key, n] of counts) held.high.set(key, Math.max(held.high.get(key) ?? 0, n));
      else if (collect.touched.size > 0) {
        // Own words only: the writer's count can only have grown.
        const own = countsOf(held.kind, held.shadow).get(conn.author) ?? 0;
        held.high.set(conn.author, Math.max(held.high.get(conn.author) ?? 0, own));
      }
      conn.updates.push(update);
      conn.accepted += 1;
      conn.flush ??= setTimeout(() => this.flush(held, conn), EDIT_COALESCE_MS);
    });
  }

  /** The document editors see, plus every connection's checked but unsaved updates. */
  private rebuildShadow(held: Held) {
    const shadow = new Y.Doc();
    Y.applyUpdate(shadow, Y.encodeStateAsUpdate(held.ydoc));
    for (const conn of held.conns) for (const update of conn.updates) Y.applyUpdate(shadow, update);
    return shadow;
  }

  /**
   * Ids (13, "The server's check"): a block with none, a malformed one or a copy is fixed by the
   * server as its own update, worked out on a copy and persisted before anyone sees it.
   */
  private async fixIdsPersisted(held: Held) {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(held.ydoc));
    const before = Y.encodeStateVector(copy);
    if (fixIds(copy).length === 0) return copy.destroy();
    const fix = Y.encodeStateAsUpdate(copy, before);
    copy.destroy();
    try {
      await persistUpdate(
        this.d,
        held.artifactId,
        fix,
        { origin: "server", personId: null, agent: null, tokenId: null },
        undefined,
        held.epoch,
      );
      if (this.held.get(held.artifactId) !== held) return;
      Y.applyUpdate(held.shadow, fix, SERVER_ORIGIN);
      Y.applyUpdate(held.ydoc, fix, SERVER_ORIGIN);
    } catch (error) {
      this.log.warn("couldn't persist an id fix", { error: String(error) });
    }
  }

  /**
   * A board's referential projection (14, "Z-order and containment"): concurrent cycles, hidden parents
   * and connectors bound to deleted targets are repaired by the server as its own update, worked out on
   * a copy and persisted before anyone sees it, keeping every register's existing stamp.
   */
  private async repairPersisted(held: Held) {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(held.ydoc));
    // The projection, then any sibling group whose order keys are nearly exhausted, as one repair.
    const fixes = [repairBoard(copy), rebalanceBoard(copy)].filter((u): u is Uint8Array => u !== null);
    copy.destroy();
    if (fixes.length === 0) return;
    const fix = fixes.length === 1 ? (fixes[0] as Uint8Array) : Y.mergeUpdates(fixes);
    try {
      await persistUpdate(
        this.d,
        held.artifactId,
        fix,
        { origin: "server", personId: null, agent: null, tokenId: null },
        undefined,
        held.epoch,
      );
      if (this.held.get(held.artifactId) !== held) return;
      Y.applyUpdate(held.shadow, fix, SERVER_ORIGIN);
      Y.applyUpdate(held.ydoc, fix, SERVER_ORIGIN);
    } catch (error) {
      this.log.warn("couldn't persist a board repair", { error: String(error) });
    }
  }

  /**
   * Persists a connection's checked updates, one batch at a time and in order (13, "Writing an update").
   * Only then do they reach the document editors see, and the writer hears `saved`. `lastSeq` isn't
   * moved here: the catch-up reads every seq after the last one it applied, so another writer's commit
   * just before this one is never skipped.
   */
  private flush(held: Held, conn: Conn, final = false) {
    conn.flush = null;
    const updates = conn.updates.splice(0);
    if (updates.length === 0) return;
    const count = conn.accepted;
    const merged = updates.length === 1 ? (updates[0] as Uint8Array) : Y.mergeUpdates(updates);
    const { caller } = conn.ws.data;
    conn.saving = conn.saving.then(async () => {
      try {
        await persistUpdate(this.d, held.artifactId, merged, editActor(caller, null), undefined, held.epoch);
      } catch (error) {
        this.log.warn("couldn't persist a draft update", { error: String(error) });
        // Nothing unsaved was ever shown. The client keeps the change (no `saved`), reconnects, and
        // sends it again; the shadow forgets it, and whatever this connection sent after it.
        conn.updates.splice(0);
        if (this.held.get(held.artifactId) === held) {
          held.shadow.destroy();
          held.shadow = this.rebuildShadow(held);
          this.watch(held);
        }
        this.close(conn, 1011, "couldn't save");
        return;
      }
      if (this.held.get(held.artifactId) !== held) return;
      Y.applyUpdate(held.ydoc, merged, conn);
      if (!final) this.write(conn, savedMessage(count));
      if (held.kind === "board") await this.repairPersisted(held);
      else await this.fixIdsPersisted(held);
    });
  }

  /** Awareness from a client: only its own client ids, and with the server's record of who it is. */
  private awareness(held: Held, conn: Conn, update: Uint8Array) {
    let entries: ReturnType<typeof decodeAwareness>;
    try {
      entries = decodeAwareness(update);
    } catch {
      return this.close(conn, SYNC_CLOSE.invalidUpdate, "malformed awareness");
    }
    const kept: typeof entries = [];
    for (const entry of entries) {
      const owner = held.owners.get(entry.client);
      if (owner && owner !== conn) continue;
      if (!owner) {
        if (conn.clients.size >= 4) continue;
        held.owners.set(entry.client, conn);
        conn.clients.add(entry.client);
      }
      if (entry.state === null) {
        kept.push(entry);
        conn.objects = [];
        continue;
      }
      if (held.kind === "board") {
        const board = BoardAwarenessState.safeParse(entry.state);
        if (!board.success) continue;
        // Protections are never silently truncated: over 50 held objects, the state is refused whole.
        const objects = [...new Set([...board.data.objects, ...board.data.pending])];
        if (objects.length > 50) continue;
        const color = HEX_COLOR.test(board.data.user.color) ? board.data.user.color : "#555555";
        kept.push({
          ...entry,
          state: {
            ...board.data,
            mode: conn.mode,
            user: { author: conn.author, name: conn.name, kind: "person", color },
          },
        });
        conn.objects = objects;
        continue;
      }
      const parsed = AwarenessState.safeParse(entry.state);
      if (!parsed.success) continue;
      const color = HEX_COLOR.test(parsed.data.user.color) ? parsed.data.user.color : "#555555";
      kept.push({
        ...entry,
        state: {
          ...parsed.data,
          mode: conn.mode,
          user: { author: conn.author, name: conn.name, kind: "person", color },
        },
      });
      conn.block = parsed.data.block;
      conn.pending = parsed.data.pending;
    }
    if (kept.length === 0) return;
    applyAwarenessUpdate(held.awareness, encodeAwareness(kept), conn);
    void this.writePresence(held, conn).catch(() => {});
  }

  closeSocket(ws: ServerWebSocket<SyncData>) {
    const conn = (ws.data as SyncData & { conn?: Conn }).conn;
    if (!conn) return;
    conn.closed = true;
    const count = (this.perPerson.get(conn.personId) ?? 1) - 1;
    if (count > 0) this.perPerson.set(conn.personId, count);
    else this.perPerson.delete(conn.personId);
    const held = this.held.get(ws.data.artifactId);
    if (held) this.leave(held, conn);
  }

  private leave(held: Held, conn: Conn, save = true) {
    if (conn.heartbeat) clearInterval(conn.heartbeat);
    conn.heartbeat = null;
    if (conn.presence.timer) clearTimeout(conn.presence.timer);
    conn.presence.timer = null;
    if (conn.flush) clearTimeout(conn.flush);
    if (save && conn.updates.length > 0) this.flush(held, conn, true);
    else conn.updates.splice(0);
    held.conns.delete(conn);
    const clients = [...conn.clients];
    for (const client of clients) held.owners.delete(client);
    if (clients.length) removeAwarenessStates(held.awareness, clients, "close");
    if (!this.stopped)
      void this.d.db
        .delete(editPresence)
        .where(and(eq(editPresence.artifactId, held.artifactId), eq(editPresence.connectionId, conn.id)))
        .catch(() => {});
    if (held.conns.size === 0 && !held.release && !this.stopped && this.held.get(held.artifactId) === held)
      held.release = setTimeout(() => {
        if (held.conns.size === 0) this.drop(held);
      }, HOLD_MS);
  }

  /**
   * An agent at work on a page (13, "Agents in presence"): a server-held awareness state, with its own
   * reserved client id, renewed until `AGENT_PRESENCE_MS` after its last operation.
   */
  agentPresence(
    artifactId: string,
    author: { name?: string | null; personId?: string | null; key?: string },
    block: string | null,
    run: string | null,
    /** On a board: the objects the agent is working on (14), shown instead of a block. */
    objects?: string[],
  ) {
    void this.agentPresenceAsync(artifactId, author, block, run, objects).catch((error) =>
      this.log.warn("couldn't show an agent's presence", { error: String(error) }),
    );
  }

  private async agentPresenceAsync(
    artifactId: string,
    author: { name?: string | null; personId?: string | null; key?: string },
    block: string | null,
    run: string | null,
    objects?: string[],
  ) {
    const name = author.name?.trim() || "Agent";
    const id = `${name}\u0000${author.personId ?? ""}`;
    let forName: string | null = null;
    if (author.personId) {
      const [person] = await this.d.db
        .select({ name: people.name })
        .from(people)
        .where(eq(people.id, author.personId))
        .limit(1);
      forName = person?.name ?? null;
    }
    const states = this.agents.get(artifactId) ?? new Map<string, AgentState>();
    this.agents.set(artifactId, states);
    let agent = states.get(id);
    if (!agent) {
      // Reserved ids sit above 2^31, where Yjs' random 32-bit client ids rarely land, and are stable per agent.
      let hash = 2166136261;
      for (const char of `${artifactId}${id}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
      agent = { client: 0x80000000 + (hash & 0x7fffffff), clock: 0, until: 0, renew: null, state: null };
      states.set(id, agent);
    }
    agent.until = Date.now() + AGENT_PRESENCE_MS;
    const user = { author: author.key ?? "", name, kind: "agent", color: AGENT_COLOR };
    agent.state = objects
      ? {
          user,
          mode: "delegate",
          objects: [...new Set(objects)].slice(0, 50),
          pending: [],
          cursor: null,
          for: forName,
          run,
        }
      : { user, mode: "delegate", block, pending: [], for: forName, run };
    const publish = () => {
      const current = agent as AgentState;
      current.clock += 1;
      const ended = Date.now() >= current.until;
      const update = encodeAwareness([
        { client: current.client, clock: current.clock, state: ended ? null : current.state },
      ]);
      this.notify(artifactId, "a", update);
      if (ended) {
        if (current.renew) clearInterval(current.renew);
        states.delete(id);
        if (states.size === 0) this.agents.delete(artifactId);
      }
    };
    publish();
    if (!agent.renew) {
      agent.renew = setInterval(publish, Math.min(AGENT_RENEW_MS, AGENT_PRESENCE_MS));
      agent.renew.unref();
    }
  }

  /** For tests: what this replica holds. */
  heldDoc(artifactId: string) {
    return this.held.get(artifactId)?.ydoc ?? null;
  }
}

/** Bun's WebSocket handler for the viewer server (13, "Limits"). */
export function syncSocket(hub: DocHub): WebSocketHandler<SyncData> {
  return {
    // Past EDIT_UPDATE_MAX the handler closes with 4413; Bun's own limit, above it, would say 1009.
    maxPayloadLength: EDIT_UPDATE_MAX * 2,
    idleTimeout: 120,
    sendPings: true,
    backpressureLimit: SEND_BUFFER_MAX * 2,
    closeOnBackpressureLimit: true,
    open: (ws) => void hub.open(ws),
    message: (ws, message) => hub.message(ws, message),
    close: (ws) => hub.closeSocket(ws),
  };
}

/**
 * `GET /api/artifacts/:id/doc/sync?epoch=<n>`, after the `artifact.edit` guard: session cookies only,
 * from a viewer origin, then the upgrade. Whether the page is editable is checked once it's open.
 */
export function syncRoute(deps: Deps) {
  return async (c: RouteContext<Caller, { id: string }>) => {
    const caller = c.var.caller;
    if (caller.kind !== "person")
      throw new ApiError("forbidden", "Agents edit by operation, not over the socket.");
    const origin = c.req.header("origin");
    if (!origin || !(await deps.origins()).includes(origin))
      return c.json({ error: { code: "forbidden", message: "Not from this site." } }, 403);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
      return c.json({ error: { code: "bad_request", message: "Open this as a WebSocket." } }, 426);
    const epochParam = c.req.query("epoch");
    const epoch = epochParam && /^\d{1,9}$/.test(epochParam) ? Number(epochParam) : null;
    const server = c.env as { upgrade?(request: Request, options: { data: SyncData }): boolean } | undefined;
    const data: SyncData = { artifactId: c.var.resource.id, org: c.var.org, caller, epoch, id: randomUUID() };
    if (!server?.upgrade?.(c.req.raw, { data }))
      return c.json({ error: { code: "bad_request", message: "Couldn't open the socket." } }, 400);
    return new Response(null);
  };
}
