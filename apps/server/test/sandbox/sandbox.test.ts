import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startChild } from "@artifacts/sandbox";
import { DEFAULT_ORG_SETTINGS, type OrgLimits } from "@artifacts/schema";
import type { z } from "zod";
import { RECHECK_MS } from "../../src/content/app.ts";
import { childIndex } from "../../src/sandbox/pool.ts";
import {
  claim,
  contentFor,
  joinAsGuest,
  OWNER,
  signIn,
  startTestServer,
  type TestServer,
} from "../helpers.ts";
import { hash, makePerson, published } from "../publish-helper.ts";

type Limits = z.infer<typeof OrgLimits>;

const POLL = `
export default {
  async fetch(request, env) {
    const who = JSON.parse(request.headers.get("x-caller"));
    const votes = (await env.DATA.get("votes")) ?? {};
    if (request.method === "POST") {
      votes[who.id] = (await request.json()).choice;
      await env.DATA.put("votes", votes);
    }
    return Response.json({ votes, who, url: new URL(request.url).pathname });
  },
};`;

describe("the backend sandbox", () => {
  let t: TestServer;
  let token: string;
  let cookie: string;
  let orgId: string;
  let n = 0;

  /** A backend's calls through the content port, the way a page's fetch() makes them. */
  const caller =
    (content: Awaited<ReturnType<typeof contentFor>>) =>
    (path: string, init: RequestInit = {}) =>
      content.fetch(`api/${path}`, {
        ...init,
        headers: { "Sec-Fetch-Dest": "empty", ...(init.headers as Record<string, string>) },
      });

  /** Publishes a backend and returns a way to call it through the content port. */
  async function deploy(backend: string, slug = `b${++n}`) {
    const { id } = await published(t, token, { slug, backend });
    const content = await contentFor(t, id, { cookie });
    return { id, call: caller(content), base: content.base };
  }

  /** What's saved in an artifact's shared data, read the way its publisher would. */
  const sharedKeys = async (id: string) =>
    (
      (await (await t.api(`/api/artifacts/${id}/data/shared`, { bearer: token })).json()) as {
        keys: { key: string }[];
      }
    ).keys.map((entry) => entry.key);

  const limits = async () =>
    ((await (await t.api("/api/org", { cookie })).json()) as { settings: { limits: Limits } }).settings
      .limits;
  const setLimits = async (value: Limits) => {
    const response = await t.api("/api/org", {
      method: "PATCH",
      cookie,
      json: { settings: { limits: value } },
    });
    expect(response.status).toBe(200);
  };
  /** Runs `work` with some of the org's limits changed, the way an admin changes them, and puts them back. */
  async function withLimits(changed: Partial<Limits>, work: () => Promise<void>) {
    const before = await limits();
    await setLimits({ ...before, ...changed });
    try {
      await work();
    } finally {
      await setLimits(before);
    }
  }

  /** Code that lands on the pool's first child: a child runs one request at a time, and its hash picks it. */
  const onFirstChild = (make: (i: number) => string) => {
    for (let i = 0; ; i++)
      if (childIndex(hash(make(i)), DEFAULT_ORG_SETTINGS.sandboxProcesses) === 0) return make(i);
  };

  beforeAll(async () => {
    t = await startTestServer();
    ({ token, orgId } = await claim(t));
    cookie = await signIn(t, OWNER.email, OWNER.password);
  });
  afterAll(() => t.stop());

  test("a backend answers, with env.DATA, CORS and the caller's identity", async () => {
    const { call, id } = await deploy(POLL);
    const response = await call("votes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"choice":"B"}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await response.json()) as {
      votes: Record<string, string>;
      who: Record<string, unknown>;
      url: string;
    };
    expect(body.url).toBe("/api/votes");
    expect(body.who).toMatchObject({ name: "Zahin", kind: "owner", canComment: true, isPublisher: true });
    expect(Object.values(body.votes)).toEqual(["B"]);
    expect(body.who).not.toHaveProperty("email");
    expect(await sharedKeys(id)).toEqual(["votes"]);
  });

  test("a client's own X-Caller is dropped, and so are its cookies", async () => {
    const { call } = await deploy(
      `export default { fetch(r) { return Response.json([...r.headers.keys()].sort().concat(r.headers.get("x-caller"))); } };`,
    );
    const body = (await (
      await call("x", { headers: { "X-Caller": '{"id":"forged"}', Cookie: "art_session=x" } })
    ).json()) as string[];
    expect(body.join()).not.toContain("forged");
    expect(body).not.toContain("cookie");
  });

  test("preflight, unknown versions, and a version with no backend", async () => {
    const { call } = await deploy(POLL);
    const preflight = await call("votes", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    const plain = await deploy("");
    expect((await plain.call("votes")).status).toBe(404);
  });

  test("no globals: the sandbox has no network, modules, timers, process or file system", async () => {
    const { call } = await deploy(`
      export default { async fetch() {
        const names = ["fetch", "XMLHttpRequest", "WebSocket", "process", "Bun", "Deno", "require", "setTimeout", "setInterval", "__host", "module", "global"];
        const present = names.filter((name) => typeof globalThis[name] !== "undefined");
        let imported = "no";
        try { await import("https://example.com/x.js"); imported = "yes"; } catch {}
        let local = "no";
        try { await import("/etc/passwd"); local = "yes"; } catch {}
        return Response.json({ present, imported, local });
      } };`);
    expect(await (await call("x")).json()).toEqual({ present: [], imported: "no", local: "no" });
  });

  test("two artifacts: isolated globals, and a backend can't reach another's data", async () => {
    const a = await deploy(
      `globalThis.mark = 1; export default { async fetch(r, env) { await env.DATA.put("own", 1); return Response.json(1); } };`,
    );
    const b = await deploy(
      `export default { async fetch(r, env) { return Response.json({ mark: typeof mark, own: await env.DATA.get("own"), up: await env.DATA.get("../${"x"}").catch((e) => e.code) }); } };`,
    );
    await a.call("x");
    const body = (await (await b.call("x")).json()) as Record<string, unknown>;
    expect(body).toEqual({ mark: "undefined", own: null, up: "invalid" });
  });

  test("two artifacts with the same code share no instance", async () => {
    const code = `let seen = null;
      export default { async fetch(r) { const was = seen; seen = await r.text(); return Response.json(was); } };`;
    const a = await deploy(code);
    const b = await deploy(code);
    expect((await a.call("x", { method: "POST", body: "secret" })).status).toBe(200);
    expect(await (await b.call("x", { method: "POST", body: "other" })).json()).toBeNull();
    expect(await (await a.call("x", { method: "POST", body: "again" })).json()).toBe("secret");
  });

  test("work left running after a response can't act for the next caller", async () => {
    const { call, id } = await deploy(`export default { async fetch(r, env) {
      if (r.url.endsWith("/float")) {
        env.DATA.get("a").then(() => env.DATA.get("b")).then(() => env.DATA.put("floated", 1));
        return Response.json("left");
      }
      // The same steps and one more, started after the floating work: its write comes after that one's would.
      await env.DATA.get("a");
      await env.DATA.get("b");
      await env.DATA.put("after", 1);
      return Response.json("next");
    } };`);
    expect(await (await call("float")).json()).toBe("left");
    expect(await (await call("other")).json()).toBe("next");
    expect(await sharedKeys(id)).toEqual(["after"]);
  });

  test("env.DATA: calls per request and writes per second are capped", async () => {
    const { call } = await deploy(`export default { async fetch(r, env) {
      const count = async (work) => {
        const results = await Promise.all(work.map((run) => run().then(() => "ok", (e) => e.code)));
        return results.reduce((all, code) => ({ ...all, [code]: (all[code] ?? 0) + 1 }), {});
      };
      const many = (n, run) => Array.from({ length: n }, (_, i) => () => run(i));
      if (r.url.endsWith("/reads")) return Response.json(await count(many(1000, () => env.DATA.get("x"))));
      return Response.json(await count(many(50, (i) => env.DATA.put("k" + i, i))));
    } };`);
    expect(await (await call("reads")).json()).toEqual({ ok: 200, rate_limited: 800 });
    const writes = (await (await call("writes")).json()) as { ok: number; rate_limited: number };
    expect(writes).toEqual({ ok: 10, rate_limited: 40 });
  });

  test("env.DATA: no dot segment, look-alike dot or odd character gets past the key checks", async () => {
    // Writes are rate-limited before their keys are looked at, and this makes many.
    await withLimits({ writesPerSecond: 1000 }, async () => {
      const { call, id } = await deploy(`export default { async fetch(r, env) {
      const code = (p) => p.then(() => "ok", (e) => e.code);
      const keys = ["../x", "a/../x", "a/..", "./x", "a/./x", "/abs", "me/../x", "files/../../x", "",
        "\\uFF0E\\uFF0E/x", "\\u2024\\u2024/x", "\\u2025/x", "a\\u0000b", "a b", "a\\\\..\\\\x", "%2e%2e/x", "k".repeat(201)];
      const out = {};
      for (const key of keys) {
        out[key] = [
          await code(env.DATA.put(key, 1)),
          await code(env.DATA.get(key)),
          await code(env.DATA.delete(key)),
          await code(env.DATA.list(key)),
        ].join();
      }
      return Response.json(out);
    } };`);
      const body = (await (await call("x")).json()) as Record<string, string>;
      for (const [key, codes] of Object.entries(body)) {
        // An empty prefix means "everything in shared", which is allowed; the other three refuse an empty key.
        expect([JSON.stringify(key), codes]).toEqual([
          JSON.stringify(key),
          key === "" ? "invalid,invalid,invalid,ok" : "invalid,invalid,invalid,invalid",
        ]);
      }
      // Nothing was written, inside the scopes or beside them, where no listing would show it.
      expect((await t.server.bucket.list(`data/${id}/`)).objects).toEqual([]);
    });
  });

  test("env.DATA: etags, only-if-new, listing every scope, and bad keys", async () => {
    const { call } = await deploy(`export default { async fetch(r, env) {
      const code = (p) => p.then(() => "ok", (e) => e.code);
      const { etag } = await env.DATA.put("thing", 1);
      const read = await env.DATA.getWithEtag("thing");
      await env.DATA.put("me/abc/own", 1);
      return Response.json({
        same: read.etag === etag,
        value: await env.DATA.get("thing"),
        missing: await env.DATA.get("nothing"),
        stale: await code(env.DATA.put("thing", 2, { ifMatch: "stale" })),
        fresh: await code(env.DATA.put("thing", 3, { ifMatch: etag })),
        exists: await code(env.DATA.put("thing", 4, { ifMatch: "*" })),
        isNew: await code(env.DATA.put("new", 4, { ifMatch: "*" })),
        shared: (await env.DATA.list()).keys,
        me: (await env.DATA.list("me/")).keys,
        climb: await code(env.DATA.get("../other/shared/votes")),
      });
    } };`);
    expect(await (await call("x")).json()).toEqual({
      same: true,
      value: 1,
      missing: null,
      stale: "precondition_failed",
      fresh: "ok",
      exists: "precondition_failed",
      isNew: "ok",
      shared: ["new", "thing"],
      me: ["me/abc/own"],
      climb: "invalid",
    });
  });

  test("the 17th backend on a child leaves a running one alone", async () => {
    const running = await deploy(`export default { async fetch(r, env) {
      for (let i = 0; i < 40; i++) await env.DATA.get("x");
      return Response.json("finished");
    } };`);
    const first = running.call("x");
    for (let i = 0; i < 18; i++) {
      await (await deploy(`export default { fetch() { return Response.json(${i}); } };`)).call("x");
    }
    expect((await first).status).toBe(200);
  });

  test("logs: NUL bytes and long lines don't fail a request, and each artifact has a budget", async () => {
    const { call, id } = await deploy(`export default { fetch() {
      for (let i = 0; i < 100; i++) console.log("\\0" + "é".repeat(8000));
      return Response.json("ok");
    } };`);
    for (let i = 0; i < 4; i++) expect((await call("x")).status).toBe(200);
    const rows = (await (await t.api(`/api/artifacts/${id}/logs`, { bearer: token })).json()) as {
      message: string;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.reduce((sum, row) => sum + Buffer.byteLength(row.message), 0)).toBeLessThanOrEqual(
      1024 * 1024,
    );
    expect(Math.max(...rows.map((row) => Buffer.byteLength(row.message)))).toBeLessThanOrEqual(8192);
  });

  test("a chunked body can't pass the size limit, and answers aren't cached", async () => {
    const { call } = await deploy(
      `export default { fetch() { return new Response("x", { headers: { "cache-control": "public, max-age=999" } }); } };`,
    );
    const big = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 3; i++) controller.enqueue(new Uint8Array(1024 * 1024));
        controller.close();
      },
    });
    expect((await call("x", { method: "POST", body: big })).status).toBe(413);
    expect((await call("x")).headers.get("cache-control")).toBe("no-store");
  });

  test("a backend over a code limit set after it was published is refused without being fetched", async () => {
    const { call } = await deploy(POLL);
    expect((await call("votes")).status).toBe(200);
    await withLimits({ backendCodeBytes: 10 }, async () => {
      expect((await call("votes")).status).toBe(413);
    });
  });

  test("query strings are read as the URL standard reads them, so a backend sees what the client sent", async () => {
    const { call } = await deploy(`export default { fetch(request) {
      const q = new URL(request.url).searchParams;
      return Response.json({ token: q.get("token"), bad: q.get("bad"), good: q.get("good"), all: q.getAll("a"), n: [...q].length });
    } };`);
    // "=" inside a value, a lone "%", empty parts, and "+" and escapes together.
    const response = await call("x?token=abc==&bad=100%&&a=1&a=2&good=a%2Bb+c");
    expect(await response.json()).toEqual({
      token: "abc==",
      bad: "100%",
      good: "a+b c",
      all: ["1", "2"],
      n: 5,
    });
  });

  test("an answer the browser can't be sent is a 502, not an unhandled error", async () => {
    for (const answer of [
      `new Response("x", { status: 99 })`,
      `new Response("x", { headers: { etag: "a\\r\\nSet-Cookie: x=1" } })`,
      `Object.defineProperty(new Response("x"), "_text", { value: { not: "text" } })`,
    ]) {
      const { call } = await deploy(`export default { fetch() { return ${answer}; } };`);
      const response = await call("x");
      expect(response.status).toBe(502);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
  });

  test("a loop in top-level code times out, and doesn't hold other backends", async () => {
    await withLimits({ backendTimeoutMs: 700 }, async () => {
      const stuck = await deploy(`while (true) {} export default { fetch() {} };`);
      const started = performance.now();
      expect((await stuck.call("x")).status).toBe(504);
      expect(performance.now() - started).toBeLessThan(1900);
    });
  });

  test("a stuck backend times out alone, and others keep answering", async () => {
    await withLimits({ backendTimeoutMs: 700 }, async () => {
      const stuck = await deploy(`export default { fetch() { while (true) {} } };`);
      const other = await deploy(`export default { fetch() { return Response.json("ok"); } };`);
      const hung = stuck.call("x");
      const started = performance.now();
      const quick = await other.call("x");
      expect(quick.status).toBe(200);
      const timedOut = await hung;
      expect(timedOut.status).toBe(504);
      expect(performance.now() - started).toBeLessThan(3000);
    });
  });

  test("busy loops on a child can't get a waiting backend on it killed", async () => {
    await withLimits({ backendTimeoutMs: 500 }, async () => {
      // A child runs one request at a time, and an author can pick which child a backend lands on.
      const looper = (seed: number) =>
        onFirstChild((i) => `// loop ${seed}.${i}\nexport default { fetch() { while (true) {} } };`);
      const victim = await deploy(
        onFirstChild((i) => `// v${i}\nexport default { fetch() { return Response.json("alive"); } };`),
      );
      const loops = await Promise.all(Array.from({ length: 8 }, (_, i) => deploy(looper(i))));
      expect((await victim.call("x")).status).toBe(200); // Warm.
      const running = loops.map((loop) => loop.call("x"));
      await Bun.sleep(150);
      // It waits behind eight loops of half a second each, which is longer than the child's backstop.
      const answer = await victim.call("x");
      expect(answer.status).toBe(200);
      expect(await Promise.all(running.map(async (r) => (await r).status))).toEqual(Array(8).fill(504));
    });
  }, 30_000);

  for (const [name, source] of [
    ["typed arrays", "const k = []; while (true) k.push(new Uint8Array(1 << 20));"],
    ["strings", 'const k = []; while (true) k.push("x".repeat(1 << 20) + k.length);'],
    ["the heap", "const k = []; while (true) k.push({ s: k.length });"],
    ["recursion", "const f = (n) => f(n + 1) + 1; f(0);"],
  ] as const) {
    test(`a flood of ${name} fails that request and nothing else`, async () => {
      const { call } = await deploy(`export default { fetch() { ${source} } };`);
      expect((await call("x")).status).toBe(500);
      const next = await deploy(`export default { fetch() { return Response.json("fine"); } };`);
      expect((await next.call("x")).status).toBe(200);
    });
  }

  test("an instance that failed comes back clean for its next request", async () => {
    const { call } = await deploy(`
      let n = 0;
      export default { fetch(r) {
        n += 1;
        if (r.url.endsWith("/boom")) { const k = []; while (true) k.push(new Uint8Array(1 << 20)); }
        return Response.json(n);
      } };`);
    expect(await (await call("x")).json()).toBe(1);
    expect(await (await call("x")).json()).toBe(2);
    expect((await call("boom")).status).toBe(500);
    // It answers, from a fresh instance: the failed one's state is gone with it.
    const next = await call("x");
    expect(next.status).toBe(200);
    expect(await next.json()).toBe(1);
  });

  test("module state stays between requests to a warm instance", async () => {
    const { call } = await deploy(`let n = 0; export default { fetch() { return Response.json(++n); } };`);
    await call("x");
    expect(await (await call("x")).json()).toBe(2);
  });

  test("calls in flight at teardown don't hurt the child", async () => {
    await withLimits({ backendTimeoutMs: 500 }, async () => {
      const { call } = await deploy(`
        export default { async fetch(r, env) {
          await env.DATA.get("a");
          env.DATA.put("left", 1);
          while (true) {}
        } };`);
      expect((await call("x")).status).toBe(504);
    });
    const next = await deploy(`export default { fetch() { return Response.json("fine"); } };`);
    expect((await next.call("x")).status).toBe(200);
  });

  test("a child that dies answers 502, and the next request starts another", async () => {
    const pool = t.server.deps.sandbox as NonNullable<typeof t.server.deps.sandbox>;
    // On the child killChild() kills: it says it has started, then works until the child dies under it.
    const { call, id } = await deploy(
      onFirstChild(
        (i) => `// ${i}
        export default { async fetch(r, env) {
          if (r.url.endsWith("/slow")) { await env.DATA.put("started", 1); const end = Date.now() + 5000; while (Date.now() < end) {} }
          return Response.json("up");
        } };`,
      ),
    );
    const slow = call("slow");
    for (let i = 0; i < 100 && !(await sharedKeys(id)).includes("started"); i++) await Bun.sleep(20);
    await pool.killChild();
    expect((await slow).status).toBe(502);
    expect((await call("x")).status).toBe(200);
  });

  test("a child's environment holds nothing", async () => {
    // Started the one way the pool starts every child.
    const child = startChild();
    try {
      await child.up;
      const keys = await child.env();
      expect(keys.filter((key) => /DATABASE|S3|SECRET|TOKEN/.test(key))).toEqual([]);
      expect(keys.length).toBeLessThanOrEqual(1);
    } finally {
      child.kill();
    }
  });

  test("read-only: a viewer's env.DATA writes are refused, whatever the backend says", async () => {
    const { id, base } = await deploy(`export default { async fetch(r, env) {
      const read = await env.DATA.get("k");
      const write = await env.DATA.put("k", 1).then(() => "wrote", (e) => e.code);
      return Response.json({ read, write });
    } };`);
    const { url } = (await (
      await t.api(`/api/artifacts/${id}/links`, {
        method: "POST",
        bearer: token,
        json: { permission: "view" },
      })
    ).json()) as { url: string };
    const guest = await joinAsGuest(t, url, "Viewer");
    const theirs = await contentFor(t, id, { cookie: guest });
    expect(theirs.base).not.toBe(base);
    expect(await (await caller(theirs)("x")).json()).toEqual({ read: null, write: "read_only" });
  });

  test("read-only: archived refuses writes, and reads keep working", async () => {
    const { id, call } = await deploy(`export default { async fetch(r, env) {
      return Response.json({ write: await env.DATA.put("k", 1).then(() => "wrote", (e) => e.code) });
    } };`);
    expect(await (await call("x")).json()).toEqual({ write: "wrote" });
    await t.api(`/api/artifacts/${id}/archive`, { method: "POST", bearer: token });
    t.clock.advance(RECHECK_MS + 1);
    expect(await (await call("x")).json()).toEqual({ write: "read_only" });
  });

  test("old versions run their own backend", async () => {
    const slug = "versions";
    await published(t, token, {
      slug,
      backend: `export default { fetch() { return Response.json("v1"); } };`,
    });
    const { id } = await published(t, token, {
      slug,
      backend: `export default { fetch() { return Response.json("v2"); } };`,
    });
    const at = async (version: number) =>
      (await caller(await contentFor(t, id, { cookie }, version))("x")).json();
    expect(await at(1)).toBe("v1");
    expect(await at(2)).toBe("v2");
  });

  test("logs: captured per request, capped, and readable by the publisher only", async () => {
    const { id, call } = await deploy(`export default { fetch() {
      for (let i = 0; i < 150; i++) console.log("line", i);
      console.error("x".repeat(9000));
      return Response.json(1);
    } };`);
    await call("x");
    const logs = (await (await t.api(`/api/artifacts/${id}/logs`, { bearer: token })).json()) as {
      level: string;
      message: string;
    }[];
    expect(logs).toHaveLength(100);
    expect(logs[0]).toMatchObject({ level: "log", message: "line 0" });
    const member = (await makePerson(t, orgId, "member")).token;
    expect((await t.api(`/api/artifacts/${id}/logs`, { bearer: member })).status).toBe(403);
  });

  test("an uncaught error is a 500 with a log line, not a crash", async () => {
    const { id, call } = await deploy(`export default { fetch() { throw new Error("kaboom"); } };`);
    expect((await call("x")).status).toBe(500);
    const logs = (await (await t.api(`/api/artifacts/${id}/logs`, { bearer: token })).json()) as {
      message: string;
    }[];
    expect(logs[0]?.message).toContain("kaboom");
  });

  test("size limits: request bodies get 413 and huge responses 502", async () => {
    const { call } = await deploy(
      `export default { fetch() { return new Response("x".repeat(6 * 1024 * 1024)); } };`,
    );
    expect((await call("x", { method: "POST", body: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect((await call("x")).status).toBe(502);
  });

  test("a backend can't set cookies on the content origin", async () => {
    const { call } = await deploy(
      `export default { fetch() { return new Response("x", { headers: { "Set-Cookie": "a=1", "Content-Type": "text/plain" } }); } };`,
    );
    const response = await call("x");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  test("the rate limit is per caller per artifact", async () => {
    await withLimits({ backendRequestsPerMinute: 3 }, async () => {
      const { call } = await deploy(`export default { fetch() { return Response.json(1); } };`);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await call("x")).status);
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
    });
  });

  test("a busy backend queues, then refuses", async () => {
    const { call } = await deploy(
      `let i = 0; export default { fetch() { const end = Date.now() + 300; while (Date.now() < end) {} return Response.json(++i); } };`,
    );
    const results = await Promise.all(Array.from({ length: 8 }, () => call("x")));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 503).length).toBeGreaterThan(0);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(0);
  });
});
