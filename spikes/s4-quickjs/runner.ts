// Spike S4, option 3: run backends in QuickJS (WebAssembly) inside the app, in a Bun Worker thread.
// Each backend gets its own QuickJS runtime with a memory limit, and each request a deadline.
import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";

const ready = getQuickJS();
let QuickJS: Awaited<typeof ready>;
const store = new Map<string, unknown>(); // stands in for the app's data API
const logs: string[] = [];

// In-sandbox shim: a tiny Response, and the handler registered by the bundled backend.
const PRELUDE = `
class Response { constructor(body, init = {}) { this.body = body == null ? "" : String(body); this.status = init.status ?? 200; this.headers = init.headers ?? {}; }
  static json(v, init = {}) { return new Response(JSON.stringify(v), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } }); } }
globalThis.Response = Response;
const console = { log: (...a) => __log("log", a.map(String).join(" ")), error: (...a) => __log("error", a.map(String).join(" ")) };
globalThis.console = console;
`;

function load(src: string, memoryMb: number) {
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryMb * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const ctx = runtime.newContext();
  const log = ctx.newFunction("__log", (lvl, msg) => { logs.push(`${ctx.getString(lvl)}: ${ctx.getString(msg)}`); });
  ctx.setProp(ctx.global, "__log", log);
  log.dispose();
  // env.DATA: host functions returning promises, resolved after the (async) host call.
  const data = ctx.newObject();
  for (const op of ["get", "put"] as const) {
    const fn = ctx.newFunction(op, (keyH, valH) => {
      const key = ctx.getString(keyH);
      const value = valH ? ctx.dump(valH) : undefined;
      const p = ctx.newPromise();
      setTimeout(() => {
        const result = op === "get" ? (store.get(key) ?? null) : (store.set(key, value), null);
        const h = ctx.newString(JSON.stringify(result));
        const parsed = ctx.unwrapResult(ctx.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(result))})`));
        h.dispose();
        p.resolve(parsed);
        parsed.dispose();
        runtime.executePendingJobs();
      }, 1);
      return p.handle;
    });
    ctx.setProp(data, op, fn);
    fn.dispose();
  }
  const env = ctx.newObject();
  ctx.setProp(env, "DATA", data);
  ctx.setProp(ctx.global, "__env", env);
  data.dispose();
  env.dispose();
  ctx.unwrapResult(ctx.evalCode(PRELUDE)).dispose();
  // The CLI bundles backends with `bun build --format=iife`-style output that sets globalThis.__handler.
  ctx.unwrapResult(ctx.evalCode(src.replace("export default", "globalThis.__handler ="))).dispose();
  return { runtime, ctx };
}

const loaded = new Map<string, ReturnType<typeof load>>();

async function run(hash: string, src: string, req: { method: string; url: string; body: string }, opts = { timeoutMs: 1000, memoryMb: 32 }) {
  const t0 = performance.now();
  let b = loaded.get(hash);
  if (!b) {
    try { b = load(src, opts.memoryMb); loaded.set(hash, b); } catch (e) { return { status: 500, body: `load failed: ${e}`, ms: 0 }; }
  }
  const { runtime, ctx } = b;
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + opts.timeoutMs));
  try {
    const reqH = ctx.unwrapResult(ctx.evalCode(`({ method: ${JSON.stringify(req.method)}, url: ${JSON.stringify(req.url)}, text: async () => ${JSON.stringify(req.body)} })`));
    const call = ctx.callFunction(ctx.getProp(ctx.getProp(ctx.global, "__handler"), "fetch"), ctx.undefined, reqH, ctx.getProp(ctx.global, "__env"));
    reqH.dispose();
    const promiseH: QuickJSHandle = ctx.unwrapResult(call);
    const settled = ctx.resolvePromise(promiseH);
    promiseH.dispose();
    runtime.executePendingJobs();
    const deadline = Date.now() + opts.timeoutMs;
    const res = await Promise.race([settled, new Promise<"timeout">((ok) => setTimeout(() => ok("timeout"), opts.timeoutMs + 50))]);
    if (res === "timeout" || Date.now() > deadline + 50) return { status: 504, body: "timed out", ms: Math.round(performance.now() - t0) };
    const out = ctx.dump(ctx.unwrapResult(res));
    return { status: out.status, body: out.body, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    // An interrupted or out-of-memory runtime is thrown away; the next request loads a fresh one.
    loaded.delete(hash);
    try { ctx.dispose(); runtime.dispose(); } catch {}
    return { status: 500, body: String((e as Error).message ?? e).slice(0, 160), ms: Math.round(performance.now() - t0) };
  } finally {
    runtime.removeInterruptHandler();
  }
}

self.onmessage = async (e: MessageEvent) => {
  QuickJS ??= await ready;
  const { id, hash, src, req, opts } = e.data;
  if (hash === "__logs") return postMessage({ id, result: logs.splice(0) });
  postMessage({ id, result: await run(hash, src, req, opts) });
};
