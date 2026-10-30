import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startBridge } from "./bridge.ts";

type Listener = (event: MessageEvent) => unknown;
const realAdd = globalThis.addEventListener;
const realRemove = globalThis.removeEventListener;
const realFetch = globalThis.fetch;
let listeners: Listener[] = [];
let fetched: string[] = [];

beforeEach(() => {
  listeners = [];
  fetched = [];
  globalThis.addEventListener = ((type: string, fn: Listener) => {
    if (type === "message") listeners.push(fn);
  }) as typeof addEventListener;
  globalThis.removeEventListener = ((_type: string, fn: Listener) => {
    listeners = listeners.filter((entry) => entry !== fn);
  }) as typeof removeEventListener;
  globalThis.fetch = (async (url: string) => {
    fetched.push(String(url));
    return new Response("{}");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.addEventListener = realAdd;
  globalThis.removeEventListener = realRemove;
  globalThis.fetch = realFetch;
});

const windowSpy = () => {
  const sent: { message: unknown; target: string }[] = [];
  return { sent, postMessage: (message: unknown, target: string) => sent.push({ message, target }) };
};
const deliver = async (source: unknown, data: unknown) => {
  for (const listener of listeners) await listener({ source, data } as unknown as MessageEvent);
};
const start = (contentWindow: unknown) =>
  startBridge({
    iframe: { contentWindow } as unknown as HTMLIFrameElement,
    artifactId: "art-1",
    canWrite: true,
  });

describe("the bridge's sender check", () => {
  test("answers its own iframe, to that window only", async () => {
    const frame = windowSpy();
    start(frame);
    await deliver(frame, { artifacts: 1, id: "a", op: { kind: "whoami" } });
    expect(frame.sent).toHaveLength(1);
    expect(frame.sent[0]?.message).toMatchObject({ artifacts: 1, id: "a", ok: true });
    expect(frame.sent[0]?.target).toBe("*");
  });

  test("ignores another window, for every kind of request", async () => {
    const frame = windowSpy();
    const other = windowSpy();
    start(frame);
    const ops = [
      { kind: "get", scope: "shared", key: "votes" },
      { kind: "list", scope: "me" },
      { kind: "put", scope: "shared", key: "votes", value: 1 },
      { kind: "delete", scope: "shared", key: "votes" },
      { kind: "file.put", scope: "me", name: "a.png", blob: new Blob(["x"]) },
      { kind: "file.url", scope: "me", name: "a.png" },
      { kind: "file.list", scope: "me" },
      { kind: "file.delete", scope: "me", name: "a.png" },
      { kind: "whoami" },
    ];
    for (const op of ops) await deliver(other, { artifacts: 1, id: "x", op });
    expect(other.sent).toEqual([]);
    expect(frame.sent).toEqual([]);
    expect(fetched).toEqual([]);
  });

  test("ignores a message with no source when the iframe has no window", async () => {
    start(null);
    await deliver(null, {
      artifacts: 1,
      id: "x",
      op: { kind: "put", scope: "shared", key: "votes", value: 1 },
    });
    expect(fetched).toEqual([]);
  });

  test("ignores a message from the right window that isn't the protocol", async () => {
    const frame = windowSpy();
    start(frame);
    await deliver(frame, { artifacts: 2, id: "x", op: { kind: "whoami" } });
    await deliver(frame, "hello");
    await deliver(frame, null);
    expect(frame.sent).toEqual([]);
  });

  test("a key that climbs out is answered as invalid and never fetched", async () => {
    const frame = windowSpy();
    start(frame);
    await deliver(frame, {
      artifacts: 1,
      id: "k",
      op: { kind: "get", scope: "shared", key: "../../people" },
    });
    expect(frame.sent[0]?.message).toMatchObject({ id: "k", ok: false, error: { code: "invalid" } });
    expect(fetched).toEqual([]);
  });

  test("stops listening when stopped", () => {
    const stop = start(windowSpy());
    expect(listeners).toHaveLength(1);
    stop();
    expect(listeners).toHaveLength(0);
  });
});
