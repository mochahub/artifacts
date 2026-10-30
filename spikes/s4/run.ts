// Spike S4 harness: a mock app internal API (:18082), workerd with the loader (:18090), and the tests.
// Run: bun run.ts [--experimental]
import { spawn } from "bun";

const SECRET = "runner-secret-spike";
const here = import.meta.dir;
const WORKERD = process.env.WORKERD ?? `${here}/../node_modules/.bin/workerd`;

const backends: Record<string, string> = {
  hello: `let n = 0;
export default { async fetch(req, env, ctx) {
  n++;
  return Response.json({ n, caller: JSON.parse(req.headers.get("x-caller")), path: new URL(req.url).pathname,
    envKeys: Object.keys(env), propsVisible: ctx.props ?? null, hasProcess: typeof process !== "undefined" });
} };`,
  data: `export default { async fetch(req, env) {
  const before = await env.DATA.get("votes");
  await env.DATA.put("votes", { ...(before ?? {}), b: 1 });
  return Response.json({ before, after: await env.DATA.get("votes") });
} };`,
  net: `import { connect } from "cloudflare:sockets";
export default { async fetch() {
  const r = {};
  for (const [k, u] of [["internet", "https://example.com/"], ["app", "http://127.0.0.1:18082/internal/backends/hello"], ["appByName", "http://app/internal/backends/hello"]]) {
    try { const res = await fetch(u); r[k] = "REACHED " + res.status; } catch (e) { r[k] = "blocked: " + e.message; }
  }
  try { const s = connect("127.0.0.1:18082"); await s.opened; r.connect = "REACHED"; } catch (e) { r.connect = "blocked: " + e.message; }
  return Response.json(r);
} };`,
  cpu: `export default { async fetch() { const t = Date.now(); while (true) { if (Date.now() - t > 20000) break; } return new Response("survived 20s of CPU"); } };`,
  mem: `export default { async fetch() { const keep = []; for (let i = 0; i < 4000; i++) keep.push(new Uint8Array(1024 * 1024).fill(i % 255)); return new Response("allocated " + keep.length + " MB"); } };`,
  heap: `export default { async fetch() { const keep = []; for (let i = 0; i < 3e7; i++) keep.push({ i, s: "x" + i }); return new Response("heap objects " + keep.length); } };`,
  log: `export default { async fetch() { console.log("hello from backend", { x: 1 }); console.error("something bad"); return new Response("logged"); } };`,
  throws: `export default { async fetch() { throw new Error("boom in backend"); } };`,
  isoA: `globalThis.__secret = "A's value"; export default { async fetch() { return new Response(String(globalThis.__secret)); } };`,
  envleak: `export default { async fetch() { let e; try { e = JSON.stringify(process.env); } catch (x) { e = "ERR " + x.message; }
  let fsr; try { const fs = await import("node:fs"); fsr = typeof fs.readFileSync === "function" ? (() => { try { return fs.readFileSync("/etc/hosts", "utf8").slice(0, 30); } catch (x) { return "readFileSync threw: " + x.message; } })() : "no readFileSync"; } catch (x) { fsr = "import failed: " + x.message; }
  return Response.json({ env: e, fs: fsr, globals: ["Bun","Deno","require","__dirname"].filter((g) => typeof globalThis[g] !== "undefined") }); } };`,
  isoB: `export default { async fetch() { return new Response(String(globalThis.__secret)); } };`,
};

const fetchedBackends: string[] = [];
const dataCalls: { key: string; method: string; dataKey: string | null }[] = [];
const logs: unknown[] = [];
const store = new Map<string, unknown>();
const appHits: string[] = [];

const app = Bun.serve({
  port: 18082,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    appHits.push(`${req.method} ${url.pathname}`);
    const auth = req.headers.get("authorization");
    let m = url.pathname.match(/^\/internal\/backends\/(\w+)$/);
    if (m) {
      if (auth !== `Bearer ${SECRET}`) return new Response("no", { status: 401 });
      fetchedBackends.push(m[1]);
      return new Response(backends[m[1]] ?? "", { status: backends[m[1]] ? 200 : 404 });
    }
    m = url.pathname.match(/^\/internal\/data\/shared\/(.+)$/);
    if (m) {
      const dataKey = auth?.replace("Bearer ", "") ?? null;
      dataCalls.push({ key: decodeURIComponent(m[1]), method: req.method, dataKey });
      if (!dataKey?.startsWith("dk_")) return new Response("bad key", { status: 401 });
      const k = `${dataKey.split(":")[0]}/${m[1]}`;
      if (req.method === "GET") return store.has(k) ? Response.json({ value: store.get(k) }) : new Response("", { status: 404 });
      if (req.method === "PUT") { store.set(k, (await req.json()).value); return Response.json({ etag: "1" }); }
    }
    if (url.pathname === "/internal/logs") { logs.push(...(await req.json())); return new Response("ok"); }
    return new Response("not found", { status: 404 });
  },
});

const CONFIG = process.env.CONFIG ?? `${here}/config.capnp`;
const args = ["serve", CONFIG, ...(process.argv.includes("--experimental") ? ["--experimental"] : [])];
const wd = spawn([WORKERD, ...args], { env: { ...process.env, RUNNER_SECRET: SECRET }, stdout: "pipe", stderr: "pipe" });
const stderr: string[] = [];
(async () => { for await (const c of wd.stderr) stderr.push(new TextDecoder().decode(c)); })();
for (let i = 0; i < 50; i++) {
  if (wd.exitCode !== null) break;
  try { await fetch("http://127.0.0.1:18090/"); break; } catch { await Bun.sleep(100); }
}
if (wd.exitCode !== null) {
  await Bun.sleep(200);
  console.log(JSON.stringify({ workerdStarted: false, args, exitCode: wd.exitCode, stderr: stderr.join("").slice(0, 2000) }, null, 2));
  app.stop();
  process.exit(0);
}

const call = async (hash: string, opts: { dataKey?: string; cpuMs?: number; path?: string } = {}) => {
  const t0 = performance.now();
  const res = await fetch("http://127.0.0.1:18090/run", {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`, "x-backend-hash": hash, "x-forwarded-path": opts.path ?? "/votes",
      "x-caller": JSON.stringify({ id: "caller-1", name: "Sam", kind: "member" }), "x-data-key": opts.dataKey ?? "dk_art1:rid1",
      ...(opts.cpuMs ? { "x-cpu-ms": String(opts.cpuMs) } : {}),
    },
    body: "{}",
    signal: AbortSignal.timeout(30000),
  }).catch((e) => ({ status: 0, text: async () => String(e), headers: new Headers() }) as unknown as Response);
  return { status: res.status, body: await res.text(), ms: Math.round(performance.now() - t0) };
};

if (process.argv.includes("--focused")) {
  const r: Record<string, unknown> = { args };
  r.envleak = await call("envleak");
  // A busy loop in one backend: does another artifact's request still get served?
  const busy = call("cpu");
  await Bun.sleep(300);
  const t0 = performance.now();
  r.helloDuringBusy = await Promise.race([call("hello"), Bun.sleep(5000).then(() => ({ status: "no answer within 5 s" }))]);
  r.helloDuringBusyWaitedMs = Math.round(performance.now() - t0);
  r.busy = await busy;
  r.memWithHeapCap = await call("mem");
  r.heapObjects = await call("heap");
  await Bun.sleep(500);
  r.workerdAliveAfterMem = wd.exitCode === null;
  r.workerdExit = wd.exitCode;
  r.helloAfterMem = await call("hello");
  r.stderrTail = stderr.join("").slice(-1500);
  wd.kill(); app.stop();
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}
const report: Record<string, unknown> = { workerd: (await Bun.$`${WORKERD} --version`.text()).trim(), args };
report.noSecret = (await fetch("http://127.0.0.1:18090/run", { method: "POST" })).status;
const h1 = await call("hello");
const h2 = await call("hello");
const h3 = await call("hello", { dataKey: "dk_art1:rid2" });
report.hello = [h1, h2, h3];
report.backendFetchesAfter3Hello = fetchedBackends.filter((b) => b === "hello").length;
report.data = await call("data", { dataKey: "dk_art1:rid3" });
report.dataCalls = dataCalls.slice();
report.net = await call("net");
report.log = await call("log");
report.throws = await call("throws");
report.isolation = { a: await call("isoA"), b: await call("isoB") };
report.cpuNoLimit = await call("cpu");
report.cpuWithLimit50 = await call("cpu", { cpuMs: 50 }).then((r) => r);
report.cpuNewHashWithLimit = await (async () => { backends.cpu2 = backends.cpu; return call("cpu2", { cpuMs: 50 }); })();
report.helloAfterCpu = await call("hello");
report.mem = await call("mem");
report.helloAfterMem = await call("hello");
await Bun.sleep(1500);
report.logs = logs;
report.appHits = [...new Set(appHits)];
report.workerdAlive = wd.exitCode === null;
report.workerdStderr = stderr.join("").slice(-3000);
wd.kill();
app.stop();
console.log(JSON.stringify(report, null, 2));
