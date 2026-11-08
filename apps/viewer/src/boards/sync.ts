import { readMessage, readSaved, SYNC_STEP } from "@artifacts/doc/sync";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { connect as connectProvider } from "../editing/provider.ts";
import type { Provider, Status } from "../editing/sync.ts";

/** A checkpoint must wait for persistence, including updates still in the client's batch. */
export function connect(
  id: string,
  epoch: number,
  doc: Y.Doc,
  awareness: Awareness,
): Provider & {
  awaitSaved(): Promise<void>;
} {
  let dirty = false;
  let sent = 0;
  let saved = 0;
  const waiting = new Set<{ resolve(): void; reject(error: Error): void }>();
  const check = () => {
    if (dirty || sent > saved || !provider.synced || provider.status !== "online") return;
    for (const waiter of waiting) waiter.resolve();
    waiting.clear();
  };
  const reject = () => {
    for (const waiter of waiting)
      waiter.reject(new Error("Changes have not synced. Reconnect and save again."));
    waiting.clear();
  };
  const update = (_bytes: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
    if (transaction.local) dirty = true;
  };
  doc.on("update", update);
  const provider = connectProvider(id, epoch, doc, awareness, {
    socket(url) {
      const socket = new WebSocket(url);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        const message = readMessage(new Uint8Array(data as ArrayBuffer));
        if (
          message.type === "sync" &&
          (message.step === SYNC_STEP.step2 || message.step === SYNC_STEP.update)
        ) {
          sent++;
          dirty = false;
        }
        send(data);
      };
      socket.addEventListener("message", (event) => {
        const message = readMessage(new Uint8Array(event.data as ArrayBuffer));
        if (message.type === "control" && (message.json as { t?: string }).t === "hello") sent = saved = 0;
        if (message.type === "sync" && message.step === SYNC_STEP.saved) saved = readSaved(message.payload);
        queueMicrotask(check);
      });
      socket.addEventListener("close", reject);
      return socket;
    },
  });
  return {
    on: ((event: string, fn: (value: never) => void) => {
      if (event === "status")
        return provider.on("status", (status) =>
          (fn as (status: Status) => void)(status === "stopped" ? "offline" : status),
        );
      return provider.on(event as "control", fn as Parameters<typeof provider.on<"control">>[1]);
    }) as Provider["on"],
    send(control) {
      if (control.t === "mode") provider.setMode(control.mode);
    },
    awaitSaved() {
      if (provider.status !== "online")
        return Promise.reject(new Error("Changes have not synced. Reconnect and save again."));
      return new Promise<void>((resolve, rejectWait) => {
        const timer = setTimeout(() => {
          waiting.delete(waiter);
          rejectWait(new Error("Still waiting for changes to sync. Try saving again."));
        }, 15_000);
        const waiter = {
          resolve() {
            clearTimeout(timer);
            resolve();
          },
          reject(error: Error) {
            clearTimeout(timer);
            rejectWait(error);
          },
        };
        waiting.add(waiter);
        check();
      });
    },
    destroy() {
      reject();
      doc.off("update", update);
      provider.destroy();
    },
  };
}
