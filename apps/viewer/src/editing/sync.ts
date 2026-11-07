import type { SyncControl } from "@artifacts/schema";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

export type Hello = Extract<SyncControl, { t: "hello" }>;
export type Status = "connecting" | "online" | "offline";

/** What the editor needs from the sync provider (13, "The client"), whoever wrote it. */
export type Provider = {
  on(event: "hello", fn: (hello: Hello) => void): () => void;
  on(event: "control", fn: (control: SyncControl) => void): () => void;
  on(event: "status", fn: (status: Status) => void): () => void;
  /** The server's copy has arrived (sync step 2), once per connection's life. */
  on(event: "synced", fn: () => void): () => void;
  /** A control message from the client: only `mode` today. */
  send(control: SyncControl): void;
  destroy(): void;
};
type Connect = (artifactId: string, epoch: number, ydoc: Y.Doc, awareness: Awareness) => Provider;

// The provider is its own module (provider.ts). Until it is there, the editor still opens and edits
// locally, and says it's offline: the same state a dropped connection gives.
type Real = {
  on(event: string, fn: (...args: never[]) => void): () => void;
  setMode(mode: Extract<SyncControl, { t: "mode" }>["mode"]): void;
  destroy(): void;
};
const modules = import.meta.glob<{
  connect: (artifactId: string, epoch: number, ydoc: Y.Doc, awareness: Awareness) => Real;
}>("./provider.ts", { eager: true });
const real = Object.values(modules)[0]?.connect;

function offline(): Provider {
  const status = new Set<(status: Status) => void>();
  queueMicrotask(() => {
    for (const fn of status) fn("offline");
  });
  return {
    on(event: string, fn: (value: never) => void) {
      if (event !== "status") return () => {};
      status.add(fn as (status: Status) => void);
      return () => status.delete(fn as (status: Status) => void);
    },
    send() {},
    destroy() {
      status.clear();
    },
  } as Provider;
}

/** The provider's own shape, narrowed to this one: `mode` goes through `setMode`, and "stopped" reads as offline. */
function adapt(provider: Real): Provider {
  return {
    on(event: string, fn: (value: never) => void) {
      if (event !== "status") return provider.on(event, fn);
      return provider.on("status", ((status: string) =>
        (fn as (status: Status) => void)(status === "stopped" ? "offline" : (status as Status))) as never);
    },
    send(control) {
      if (control.t === "mode") provider.setMode(control.mode);
    },
    destroy: () => provider.destroy(),
  } as Provider;
}

export const connect: Connect = (artifactId, epoch, ydoc, awareness) =>
  real ? adapt(real(artifactId, epoch, ydoc, awareness)) : offline();
