// Spike S4, option 3 harness: the app's main thread talks to a QuickJS worker thread.
const w = new Worker(new URL("./runner.ts", import.meta.url).href);
let n = 0;
const pending = new Map<number, (v: unknown) => void>();
w.onmessage = (e) => pending.get(e.data.id)?.(e.data.result);
const call = (hash: string, src: string, opts = { timeoutMs: 1000, memoryMb: 32 }) =>
  new Promise<any>((ok) => { const id = ++n; pending.set(id, ok); w.postMessage({ id, hash, src, req: { method: "POST", url: "https://artifact.local/votes", body: '{"choice":"B"}' }, opts }); });

const B = {
  hello: `let n = 0; export default { async fetch(req, env) { n++; return Response.json({ n, method: req.method, body: await req.text() }); } };`,
  data: `export default { async fetch(req, env) { const before = await env.DATA.get("votes"); await env.DATA.put("votes", { ...(before ?? {}), b: 1 }); return Response.json({ before, after: await env.DATA.get("votes") }); } };`,
  reach: `export default { async fetch() { const g = ["fetch","XMLHttpRequest","WebSocket","process","Bun","Deno","require","import","setTimeout","std","os"].filter((k) => { try { return typeof globalThis[k] !== "undefined"; } catch { return false; } });
    let dyn; try { await import("https://esm.sh/ms"); dyn = "REACHED"; } catch (e) { dyn = "blocked: " + e.message; }
    return Response.json({ globals: g, dynamicImport: dyn }); } };`,
  cpu: `export default { async fetch() { while (true) {} } };`,
  heap: `export default { async fetch() { const k = []; while (true) k.push({ s: "x" + k.length }); } };`,
  buf: `export default { async fetch() { const k = []; while (true) k.push(new Uint8Array(1024 * 1024)); } };`,
  log: `export default { async fetch() { console.log("hello from backend", 1); console.error("bad thing"); return new Response("logged"); } };`,
  isoA: `globalThis.secret = "A's value"; export default { async fetch() { return new Response(String(globalThis.secret)); } };`,
  isoB: `export default { async fetch() { return new Response(String(globalThis.secret)); } };`,
};

const r: Record<string, unknown> = {};
const log = (k: string, v: unknown) => { r[k] = v; console.log(k, JSON.stringify(v)); };
log("hello1", await call("hello", B.hello));
log("hello2", await call("hello", B.hello));
log("data", await call("data", B.data));
log("reach", await call("reach", B.reach));
log("isolation", [await call("isoA", B.isoA), await call("isoB", B.isoB)]);
// Is the app's main thread still responsive while a backend loops?
let ticks = 0;
const timer = setInterval(() => ticks++, 10);
const busy = call("cpu", B.cpu, { timeoutMs: 1000, memoryMb: 32 });
log("cpu", await busy);
clearInterval(timer);
log("mainThreadTicksDuringBusy (expect ~100)", ticks);
log("heap", await call("heap", B.heap, { timeoutMs: 5000, memoryMb: 32 }));
log("buf", await call("buf", B.buf, { timeoutMs: 5000, memoryMb: 32 }));
log("helloAfter", await call("hello", B.hello));
log("cpuAgain (fresh runtime)", await call("cpu", B.cpu, { timeoutMs: 500, memoryMb: 32 }));
log("log", await call("log", B.log));
log("captured", await call("__logs", ""));
// Cold load and warm request cost.
const t0 = performance.now();
for (let i = 0; i < 200; i++) await call("hello", B.hello);
log("warmRequestAvgMs", +((performance.now() - t0) / 200).toFixed(3));
const t1 = performance.now();
await call("coldX", B.hello);
log("coldLoadMs", Math.round(performance.now() - t1));
log("rssMb", Math.round(process.memoryUsage().rss / 1e6));
w.terminate();
