import type { EditMode, SyncControl } from "@artifacts/schema/editing";
import * as Y from "yjs";
import { parseControl, SYNC_CLOSE } from "./control.ts";
import {
  type Awareness,
  applyAwarenessUpdate,
  awarenessMessage,
  controlMessage,
  encodeAwarenessUpdate,
  readMessage,
  readSaved,
  removeAwarenessStates,
  SYNC_STEP,
  syncStep1,
  syncStep2,
  syncUpdate,
} from "./sync.ts";

/**
 * The editor's sync client (13, "The client"): our socket's messages over a plain WebSocket, with no
 * y-websocket. It reconnects with backoff, keeps editing offline, and keeps unsent changes in a store
 * under `edit:<artifactId>:<epoch>`, so a reload while offline loses nothing. No DOM: the viewer's
 * provider gives it the URL, IndexedDB and the browser's `online` event; tests give it Bun's WebSocket.
 */

export type ProviderStatus = "connecting" | "online" | "offline" | "stopped";
type Hello = Extract<SyncControl, { t: "hello" }>;
type Events = {
  hello: (hello: Hello) => void;
  control: (control: SyncControl) => void;
  status: (status: ProviderStatus, code?: number) => void;
  synced: () => void;
};

export type Provider = {
  readonly status: ProviderStatus;
  /** This connection's author key, from `hello`: what the editor marks typing with. Null until then. */
  readonly author: string | null;
  readonly synced: boolean;
  on<K extends keyof Events>(event: K, listener: Events[K]): () => void;
  setMode(mode: EditMode): void;
  /** Stops for good: closes the socket and stops reconnecting. Unsent changes stay in the store. */
  destroy(): void;
};

/** Where unsent updates wait. IndexedDB in the browser; tests pass a map. */
export type UnsentStore = {
  get(key: string): Promise<Uint8Array[]>;
  set(key: string, updates: Uint8Array[]): Promise<void>;
  keys(prefix: string): Promise<string[]>;
};

export type ConnectOptions = {
  url: string;
  socket?: (url: string) => WebSocket;
  store?: UnsentStore | null;
  /** Calls back when the device comes back online, to reconnect at once. Returns the unsubscribe. */
  online?: (listener: () => void) => () => void;
};

const BATCH_MS = 50;
const AWARENESS_MS = 100;
const PERSIST_MS = 300;
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 30_000;
/** Closes that a retry can't fix: the page is gone, access ended, the draft was reset, or ours was refused. */
const FINAL = new Set<number>([
  SYNC_CLOSE.invalidUpdate,
  SYNC_CLOSE.unauthenticated,
  SYNC_CLOSE.lostAccess,
  SYNC_CLOSE.notFound,
  SYNC_CLOSE.reset,
  SYNC_CLOSE.tooLarge,
]);

export const unsentKey = (artifactId: string, epoch: number) => `edit:${artifactId}:${epoch}`;

export function connect(
  artifactId: string,
  epoch: number,
  ydoc: Y.Doc,
  awareness: Awareness,
  options: ConnectOptions,
): Provider {
  const url = options.url;
  const open = options.socket ?? ((to: string) => new WebSocket(to));
  const store = options.store ?? null;
  let unsubscribeOnline = () => {};
  const key = unsentKey(artifactId, epoch);
  const listeners: { [K in keyof Events]: Set<Events[K]> } = {
    hello: new Set(),
    control: new Set(),
    status: new Set(),
    synced: new Set(),
  };
  const emit = <K extends keyof Events>(event: K, ...args: Parameters<Events[K]>) => {
    for (const listener of listeners[event]) (listener as (...a: unknown[]) => void)(...args);
  };

  let ws: WebSocket | null = null;
  let status: ProviderStatus = "connecting";
  let author: string | null = null;
  let synced = false;
  let stopped = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let mode: EditMode | null = null;
  let outgoing: Uint8Array[] = [];
  let batch: ReturnType<typeof setTimeout> | null = null;
  let awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  /** Local updates not yet known to be saved, in the order they were made. */
  /** Local updates the server hasn't said `saved` to, with the update message they went out in, if any. */
  let unsent: { update: Uint8Array; at: number | null }[] = [];
  /** Update messages (step 2s and updates) sent on this connection, as the server counts them. */
  let sentUpdates = 0;
  let saving = Promise.resolve();

  const setStatus = (next: ProviderStatus, code?: number) => {
    if (status === next) return;
    status = next;
    emit("status", next, code);
  };
  /**
   * The store holds the whole document while anything is unsent, not the changes alone: a change
   * can't be applied without the document it was made on, and after a reset the server no longer has
   * that document. Written at most every PERSIST_MS.
   */
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const persist = () => {
    if (!store || persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const state = unsent.length ? [Y.encodeStateAsUpdate(ydoc)] : [];
      saving = saving.then(() => store.set(key, state)).catch(() => {});
    }, PERSIST_MS);
  };
  const live = () => ws !== null && ws.readyState === 1 && author !== null;
  const send = (message: Uint8Array) => {
    if (ws && ws.readyState === 1) ws.send(message as Uint8Array<ArrayBuffer>);
  };

  const flush = () => {
    batch = null;
    if (!live() || outgoing.length === 0) return;
    const sent = outgoing;
    outgoing = [];
    send(syncUpdate(sent.length === 1 ? (sent[0] as Uint8Array) : Y.mergeUpdates(sent)));
    sentUpdates += 1;
    for (const entry of unsent) if (entry.at === null && sent.includes(entry.update)) entry.at = sentUpdates;
  };

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === provider) return;
    unsent.push({ update, at: null });
    outgoing.push(update);
    persist();
    batch ??= setTimeout(flush, BATCH_MS);
  };

  const sendAwareness = () => {
    awarenessTimer = null;
    if (live()) send(awarenessMessage(encodeAwarenessUpdate(awareness, [ydoc.clientID])));
  };
  const onAwareness = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === provider) return;
    const mine = [...changes.added, ...changes.updated, ...changes.removed].includes(ydoc.clientID);
    if (mine) awarenessTimer ??= setTimeout(sendAwareness, AWARENESS_MS);
  };

  const onMessage = (event: MessageEvent) => {
    let incoming: ReturnType<typeof readMessage>;
    try {
      incoming = readMessage(new Uint8Array(event.data as ArrayBuffer));
    } catch {
      return;
    }
    switch (incoming.type) {
      case "control": {
        const parsed = parseControl(incoming.json);
        if (!parsed.success) return;
        const control = parsed.data;
        if (control.t === "hello") {
          author = control.author;
          attempt = 0;
          sentUpdates = 0;
          setStatus("online");
          send(syncStep1(ydoc));
          if (mode) send(controlMessage({ t: "mode", mode }));
          sendAwareness();
          emit("hello", control);
        }
        emit("control", control);
        return;
      }
      case "sync":
        if (incoming.step === SYNC_STEP.step1) {
          // The server's state vector: answer with everything it lacks, offline changes included.
          send(syncStep2(ydoc, incoming.payload));
          sentUpdates += 1;
          outgoing = [];
          for (const entry of unsent) entry.at = sentUpdates;
        } else if (incoming.step === SYNC_STEP.saved) {
          // Kept until the server says it persisted them: a failed save closes the socket instead.
          const count = readSaved(incoming.payload);
          const before = unsent.length;
          unsent = unsent.filter((entry) => entry.at === null || entry.at > count);
          if (unsent.length !== before) persist();
        } else {
          Y.applyUpdate(ydoc, incoming.payload, provider);
          if (incoming.step === SYNC_STEP.step2 && !synced) {
            synced = true;
            emit("synced");
          }
        }
        return;
      case "awareness":
        applyAwarenessUpdate(awareness, incoming.update, provider);
        return;
      case "queryAwareness":
        sendAwareness();
        return;
      default:
        return;
    }
  };

  const onClose = (event: CloseEvent) => {
    ws = null;
    author = null;
    // Whatever wasn't acknowledged goes again, in the next connection's step 2.
    for (const entry of unsent) entry.at = null;
    const others = [...awareness.getStates().keys()].filter((client) => client !== ydoc.clientID);
    if (others.length) removeAwarenessStates(awareness, others, provider);
    if (stopped) return;
    if (FINAL.has(event.code)) {
      stopped = true;
      setStatus("stopped", event.code);
      return;
    }
    setStatus("offline", event.code);
    attempt += 1;
    const base = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** Math.min(attempt - 1, 5));
    retry = setTimeout(start, base / 2 + Math.random() * (base / 2));
  };

  const start = () => {
    retry = null;
    if (stopped) return;
    setStatus(attempt === 0 ? "connecting" : "offline");
    const socket = open(url);
    socket.binaryType = "arraybuffer";
    socket.onmessage = onMessage;
    socket.onclose = onClose;
    socket.onerror = () => {};
    ws = socket;
  };

  const online = () => {
    if (!ws && retry) {
      clearTimeout(retry);
      start();
    }
  };

  const provider: Provider = {
    get status() {
      return status;
    },
    get author() {
      return author;
    },
    get synced() {
      return synced;
    },
    on(event, listener) {
      listeners[event].add(listener as never);
      return () => listeners[event].delete(listener as never);
    },
    setMode(next) {
      mode = next;
      if (live()) send(controlMessage({ t: "mode", mode: next }));
    },
    destroy() {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (batch) clearTimeout(batch);
      if (persistTimer) {
        // Write now what would have been written: unsent changes survive closing the editor.
        clearTimeout(persistTimer);
        persistTimer = null;
        const state = unsent.length ? [Y.encodeStateAsUpdate(ydoc)] : [];
        if (store) saving = saving.then(() => store.set(key, state)).catch(() => {});
      }
      if (awarenessTimer) clearTimeout(awarenessTimer);
      ydoc.off("update", onUpdate);
      awareness.off("update", onAwareness);
      unsubscribeOnline();
      ws?.close(1000);
      ws = null;
      setStatus("stopped");
    },
  };

  // Changes from before a reload go first: they stay unsent until the server has them.
  const restore = store
    ? store
        .get(key)
        .then((updates) => {
          for (const update of updates) Y.applyUpdate(ydoc, update, "unsent");
          unsent = updates.map((update) => ({ update, at: null }));
        })
        .catch(() => {})
    : Promise.resolve();
  void restore.then(() => {
    if (stopped) return;
    ydoc.on("update", onUpdate);
    awareness.on("update", onAwareness);
    if (options.online) unsubscribeOnline = options.online(online);
    start();
  });
  return provider;
}
