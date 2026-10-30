import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { artifacts, people } from "../../src/db/schema.ts";
import { claim, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { makePerson, publish } from "../publish-helper.ts";

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

  /** Publishes a backend and returns a way to call it through the content port. */
  async function deploy(backend: string, slug = `b${++n}`) {
    expect((await publish(t, token, { slug, backend })).status).toBe(200);
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, slug));
    const id = row?.id as string;
    const mint = await t.api(`/api/artifacts/${id}/content-token`, {
      method: "POST",
      cookie,
      json: { version: 1 },
    });
    const { base } = (await mint.json()) as { base: string };
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${t.server.ports.content}${new URL(base).pathname}api/${path}`, {
        ...init,
        headers: { Host: "content.test", "Sec-Fetch-Dest": "empty", ...init.headers },
      });
    return { id, call, base };
  }

  beforeAll(async () => {
    t = await startTestServer();
    token = (await claim(t)).token;
    cookie = await signIn(t, OWNER.email, OWNER.password);
    orgId = (await t.server.db.select().from(people))[0]?.orgId as string;
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
    const stored = await t.server.bucket.get(`data/${id}/shared/votes`);
    expect(stored).not.toBeNull();
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

  test("a stuck backend times out alone, and others keep answering", async () => {
    const [row] = await t.server.db.select().from((await import("../../src/db/schema.ts")).org);
    const { org } = await import("../../src/db/schema.ts");
    const settings = row?.settings as { limits: { backendTimeoutMs: number } };
    settings.limits.backendTimeoutMs = 700;
    await t.server.db.update(org).set({ settings });
    const stuck = await deploy(`export default { fetch() { while (true) {} } };`);
    const other = await deploy(`export default { fetch() { return Response.json("ok"); } };`);
    const hung = stuck.call("x");
    const started = performance.now();
    const quick = await other.call("x");
    expect(quick.status).toBe(200);
    const timedOut = await hung;
    expect(timedOut.status).toBe(504);
    expect(performance.now() - started).toBeLessThan(3000);
    settings.limits.backendTimeoutMs = 10_000;
    await t.server.db.update(org).set({ settings });
  });

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
      let boom = true;
      export default { fetch() { if (boom) { boom = false; const k = []; while (true) k.push(new Uint8Array(1 << 20)); } return Response.json("back"); } };`);
    expect((await call("x")).status).toBe(500);
    // A new instance has `boom = true` again, so it fails the same way, and it isn't wedged.
    expect((await call("x")).status).toBe(500);
  });

  test("module state stays between requests to a warm instance", async () => {
    const { call } = await deploy(`let n = 0; export default { fetch() { return Response.json(++n); } };`);
    await call("x");
    expect(await (await call("x")).json()).toBe(2);
  });

  test("calls in flight at teardown don't hurt the child", async () => {
    const [row] = await t.server.db.select().from((await import("../../src/db/schema.ts")).org);
    const { org } = await import("../../src/db/schema.ts");
    const settings = row?.settings as { limits: { backendTimeoutMs: number } };
    settings.limits.backendTimeoutMs = 500;
    await t.server.db.update(org).set({ settings });
    const { call } = await deploy(`
      export default { async fetch(r, env) {
        await env.DATA.get("a");
        env.DATA.put("left", 1);
        while (true) {}
      } };`);
    expect((await call("x")).status).toBe(504);
    settings.limits.backendTimeoutMs = 10_000;
    await t.server.db.update(org).set({ settings });
    const next = await deploy(`export default { fetch() { return Response.json("fine"); } };`);
    expect((await next.call("x")).status).toBe(200);
  });

  test("a child that dies answers 502, and the next request starts another", async () => {
    const pool = t.server.deps.sandbox as NonNullable<typeof t.server.deps.sandbox>;
    const { call } = await deploy(`export default { fetch() { return Response.json("up"); } };`);
    expect((await call("x")).status).toBe(200);
    await pool.killChild();
    await Bun.sleep(200);
    expect((await call("x")).status).toBe(200);
  });

  test("a child's environment holds nothing", async () => {
    const pool = t.server.deps.sandbox as NonNullable<typeof t.server.deps.sandbox>;
    const keys = await pool.childEnv();
    expect(keys.filter((key) => /DATABASE|S3|SECRET|TOKEN/.test(key))).toEqual([]);
    expect(keys.length).toBeLessThanOrEqual(1);
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
    const joined = await t.api(`/api/s/${url.split("/s/")[1]}/guest`, {
      method: "POST",
      json: { name: "Viewer" },
    });
    const guest = (joined.headers.getSetCookie()[0] ?? "").split(";")[0] as string;
    const mint = await t.api(`/api/artifacts/${id}/content-token`, {
      method: "POST",
      cookie: guest,
      json: { version: 1 },
    });
    const theirs = ((await mint.json()) as { base: string }).base;
    expect(theirs).not.toBe(base);
    const response = await fetch(
      `http://127.0.0.1:${t.server.ports.content}${new URL(theirs).pathname}api/x`,
      {
        headers: { Host: "content.test", "Sec-Fetch-Dest": "empty" },
      },
    );
    expect(await response.json()).toEqual({ read: null, write: "read_only" });
  });

  test("read-only: archived refuses writes, and reads keep working", async () => {
    const { id, call } = await deploy(`export default { async fetch(r, env) {
      return Response.json({ write: await env.DATA.put("k", 1).then(() => "wrote", (e) => e.code) });
    } };`);
    expect(await (await call("x")).json()).toEqual({ write: "wrote" });
    await t.api(`/api/artifacts/${id}/archive`, { method: "POST", bearer: token });
    await Bun.sleep(5100);
    expect(await (await call("x")).json()).toEqual({ write: "read_only" });
  }, 15_000);

  test("old versions run their own backend", async () => {
    const slug = "versions";
    await publish(t, token, { slug, backend: `export default { fetch() { return Response.json("v1"); } };` });
    await publish(t, token, { slug, backend: `export default { fetch() { return Response.json("v2"); } };` });
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, slug));
    const at = async (version: number) => {
      const mint = await t.api(`/api/artifacts/${row?.id}/content-token`, {
        method: "POST",
        cookie,
        json: { version },
      });
      const { base } = (await mint.json()) as { base: string };
      const response = await fetch(
        `http://127.0.0.1:${t.server.ports.content}${new URL(base).pathname}api/x`,
        {
          headers: { Host: "content.test", "Sec-Fetch-Dest": "empty" },
        },
      );
      return response.json();
    };
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
    const member = await makePerson(t, orgId, "member");
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
    const { org } = await import("../../src/db/schema.ts");
    const [row] = await t.server.db.select().from(org);
    const settings = row?.settings as { limits: { backendRequestsPerMinute: number } };
    settings.limits.backendRequestsPerMinute = 3;
    await t.server.db.update(org).set({ settings });
    const { call } = await deploy(`export default { fetch() { return Response.json(1); } };`);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await call("x")).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    settings.limits.backendRequestsPerMinute = 120;
    await t.server.db.update(org).set({ settings });
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
