import {
  type ConnectOptions as ClientOptions,
  connect as connectClient,
  type Provider,
  type UnsentStore,
  unsentKey,
} from "@artifacts/doc/client";
import type { Awareness } from "@artifacts/doc/sync";
import type * as Y from "yjs";

/**
 * The editor's provider (13, "The client"): the sync client in `@artifacts/doc/client`, with this
 * page's socket URL, unsent changes in IndexedDB, and a reconnect as soon as the device is online.
 */

export type { Provider, ProviderStatus, UnsentStore } from "@artifacts/doc/client";
export type ConnectOptions = Partial<ClientOptions>;

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("artifacts-edit", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("unsent");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const run = <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>) =>
  idb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = fn(db.transaction("unsent", mode).objectStore("unsent"));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );

/** The browser's store. Failures (private mode, quota) only cost offline safety, never editing. */
export const indexedDbStore: UnsentStore = {
  get: (key) => run("readonly", (store) => store.get(key)).then((value) => (value as Uint8Array[]) ?? []),
  set: (key, updates) =>
    run<unknown>("readwrite", (store) =>
      updates.length
        ? (store.put(updates, key) as IDBRequest<unknown>)
        : (store.delete(key) as IDBRequest<unknown>),
    ).then(() => {}),
  keys: (prefix) =>
    run("readonly", (store) => store.getAllKeys()).then((keys) =>
      (keys as string[]).filter((key) => key.startsWith(prefix)),
    ),
};

/**
 * Changes kept for an earlier epoch of this page: the draft was started again from a new version, so
 * they can't merge. The editor shows them in a dialog to copy ("These changes couldn't be merged").
 */
export async function staleUnsent(
  artifactId: string,
  epoch: number,
  store: UnsentStore = indexedDbStore,
): Promise<{ epoch: number; updates: Uint8Array[] }[]> {
  const keys = await store.keys(`edit:${artifactId}:`);
  const out: { epoch: number; updates: Uint8Array[] }[] = [];
  for (const key of keys) {
    const at = Number(key.split(":").at(-1));
    if (at !== epoch) out.push({ epoch: at, updates: await store.get(key) });
  }
  return out;
}

export const forgetUnsent = (artifactId: string, epoch: number, store: UnsentStore = indexedDbStore) =>
  store.set(unsentKey(artifactId, epoch), []);

export function connect(
  artifactId: string,
  epoch: number,
  ydoc: Y.Doc,
  awareness: Awareness,
  options: ConnectOptions = {},
): Provider {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return connectClient(artifactId, epoch, ydoc, awareness, {
    url: options.url ?? `${scheme}//${location.host}/api/artifacts/${artifactId}/doc/sync?epoch=${epoch}`,
    socket: options.socket,
    store: options.store === undefined ? indexedDbStore : options.store,
    online:
      options.online ??
      ((listener) => {
        window.addEventListener("online", listener);
        return () => window.removeEventListener("online", listener);
      }),
  });
}
