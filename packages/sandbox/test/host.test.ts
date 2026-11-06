import { afterAll, describe, expect, test } from "bun:test";
import { type DataOp, type LocalStore, localData, localSandbox, runBackend } from "@artifacts/sandbox";

const LIMITS = {
  backendTimeoutMs: 5000,
  backendMemoryMb: 64,
  dataValueBytes: 65_536,
  backendResponseBytes: 1024,
};
const CALLER = { id: "p1", name: "Sam", kind: "member", canComment: true, isPublisher: false };

describe("runBackend", () => {
  const sandbox = localSandbox();
  afterAll(() => sandbox.kill());
  const call = (code: string, request: Partial<Parameters<typeof runBackend>[0]["request"]> = {}) =>
    runBackend({
      run: sandbox.run,
      hash: Bun.hash(code).toString(16).padStart(8, "0"),
      code: () => code,
      limits: LIMITS,
      caller: CALLER,
      request: { method: "GET", path: "items", search: "", contentType: null, body: "", ...request },
      onData: async () => ({ value: null }),
    });

  test("the backend sees the path after api/, the query string, and the caller the app set", async () => {
    const { response } = await call(
      `export default { fetch(r) {
        const url = new URL(r.url);
        return Response.json({ url: r.url, x: url.searchParams.get("x"), caller: JSON.parse(r.headers.get("x-caller")), type: r.headers.get("content-type") });
      } };`,
      { path: "items/2", search: "?x=1&y=two" },
    );
    expect(await response.json()).toEqual({
      url: "https://backend.invalid/api/items/2?x=1&y=two",
      x: "1",
      caller: CALLER,
      type: null,
    });
  });

  test("only safe headers pass, with CORS and no-store, and a body over the limit is refused", async () => {
    const { response } = await call(
      `export default { fetch() { return new Response("hi", { headers: { "set-cookie": "a=1", etag: "e1" } }); } };`,
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("etag")).toBe("e1");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const big = await call(`export default { fetch() { return new Response("x".repeat(2000)); } };`);
    expect(big.response.status).toBe(502);
    expect(await big.response.json()).toEqual({ error: "The response is too big." });
  });
});

describe("localData", () => {
  const stored = new Map<string, unknown>([
    ["shared/votes", 3],
    ["shared/vo/x", 1],
    ["me/p1/note", "hi"],
  ]);
  const store: LocalStore = {
    keys: () => [...stored.keys()],
    get: (key) => (stored.has(key) ? { value: stored.get(key), etag: `e-${key}` } : undefined),
    etag: (key) => (stored.has(key) ? `e-${key}` : null),
    put: (key, value) => {
      stored.set(key, value);
      return `e-${key}`;
    },
    delete: (key) => void stored.delete(key),
    valid: (key) => !key.includes(".."),
  };
  const data = localData(store);
  const ask = (op: DataOp) => data(op);

  test("answers in the app's shapes: a key without a scope is shared, and a list keeps the prefix's form", async () => {
    expect(await ask({ op: "get", key: "votes" })).toEqual({ value: { value: 3, etag: "e-shared/votes" } });
    expect(await ask({ op: "get", key: "nothing" })).toEqual({ value: null });
    expect(await ask({ op: "list" })).toEqual({ value: { keys: ["votes", "vo/x"], nextCursor: null } });
    expect(await ask({ op: "list", prefix: "vo/" })).toEqual({ value: { keys: ["vo/x"], nextCursor: null } });
    expect(await ask({ op: "list", prefix: "me/p1/" })).toEqual({
      value: { keys: ["me/p1/note"], nextCursor: null },
    });
  });

  test("conditional writes and bad keys answer as the app does", async () => {
    expect(await ask({ op: "put", key: "votes", value: 4, ifMatch: "*" })).toEqual({
      error: { code: "precondition_failed", message: "Someone wrote first." },
    });
    expect(await ask({ op: "put", key: "votes", value: 4, ifMatch: "e-shared/votes" })).toEqual({
      value: { etag: "e-shared/votes" },
    });
    expect(await ask({ op: "get", key: "../x" })).toEqual({
      error: { code: "invalid", message: "That isn't a valid key." },
    });
  });
});
