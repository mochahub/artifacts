import { type Awareness } from "@artifacts/doc/sync";
import { type EditMode, SyncControl } from "@artifacts/schema/editing";
import * as Y from "yjs";
/**
 * The editor's sync client (13, "The client"): our socket's messages over a plain WebSocket, with no
 * y-websocket. It reconnects with backoff, keeps editing offline, and keeps unsent changes in IndexedDB
 * under `edit:<artifactId>:<epoch>`, so a reload while offline loses nothing.
 */
export type ProviderStatus = "connecting" | "online" | "offline" | "stopped";
type Hello = Extract<
  SyncControl,
  {
    t: "hello";
  }
>;
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
  url?: string;
  socket?: (url: string) => WebSocket;
  store?: UnsentStore | null;
};
/** The browser's store. Failures (private mode, quota) only cost offline safety, never editing. */
export declare const indexedDbStore: UnsentStore;
/**
 * Changes kept for an earlier epoch of this page: the draft was started again from a new version, so
 * they can't merge. The editor shows them in a dialog to copy ("These changes couldn't be merged").
 */
export declare function staleUnsent(
  artifactId: string,
  epoch: number,
  store?: UnsentStore,
): Promise<
  {
    epoch: number;
    updates: Uint8Array[];
  }[]
>;
export declare const forgetUnsent: (artifactId: string, epoch: number, store?: UnsentStore) => Promise<void>;
export declare function connect(
  artifactId: string,
  epoch: number,
  ydoc: Y.Doc,
  awareness: Awareness,
  options?: ConnectOptions,
): Provider;
