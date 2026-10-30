// Spike S4 fallback: Deno Workers with no permissions. One worker per backend; terminate on timeout.
const backends: Record<string, string> = {
  hello: `let n=0; export default { async fetch(req, env) { n++; return Response.json({ n, envKeys: Object.keys(env) }); } };`,
  net: `export default { async fetch() { const r = {}; try { await fetch("https://example.com/"); r.internet = "REACHED"; } catch (e) { r.internet = "blocked: " + e.name; }
    try { r.env = JSON.stringify(Deno.env.toObject()); } catch (e) { r.env = "blocked: " + e.name; }
    try { Deno.readTextFileSync("/etc/hosts"); r.fs = "REACHED"; } catch (e) { r.fs = "blocked: " + e.name; }
    try { await Deno.connect({ hostname: "127.0.0.1", port: 22 }); r.connect = "REACHED"; } catch (e) { r.connect = "blocked: " + e.name; }
    try { new Deno.Command("ls"); r.run = "constructed"; } catch (e) { r.run = "blocked: " + e.name; }
    return Response.json(r); } };`,
  cpu: `export default { async fetch() { while (true) {} } };`,
  buf: `export default { async fetch() { const k = []; for (let i = 0; i < 4000; i++) k.push(new Uint8Array(1024*1024).fill(1)); return new Response("buf " + k.length); } };`,
  heap: `export default { async fetch() { const k = []; for (let i = 0; i < 3e7; i++) k.push({ i, s: "x" + i }); return new Response("heap " + k.length); } };`,
};
const WRAP = (src: string) => `${src.replace("export default", "const __user =")}
self.onmessage = async (e) => { const { id, url, method, body } = e.data;
  try { const res = await __user.fetch(new Request(url, { method, body }), { DATA: {} }); self.postMessage({ id, status: res.status, text: await res.text() }); }
  catch (err) { self.postMessage({ id, status: 500, text: String(err) }); } };`;

function run(hash: string, timeoutMs = 2000): Promise<unknown> {
  const t0 = performance.now();
  const w = new Worker(`data:application/javascript,${encodeURIComponent(WRAP(backends[hash]))}`, { type: "module", deno: { permissions: "none" } } as WorkerOptions);
  return new Promise((resolve) => {
    const done = (v: Record<string, unknown>) => { clearTimeout(t); w.terminate(); resolve({ ...v, ms: Math.round(performance.now() - t0) }); };
    const t = setTimeout(() => done({ status: 504, text: "terminated after timeout" }), timeoutMs);
    w.onmessage = (e) => done(e.data);
    w.onerror = (e) => { e.preventDefault(); done({ status: 500, text: "worker error: " + e.message }); };
    w.postMessage({ id: 1, url: "https://artifact.local/votes", method: "POST", body: "{}" });
  });
}
const log = (k: string, v: unknown) => console.log(k, JSON.stringify(v));
log("deno", Deno.version.deno);
log("hello", await run("hello"));
log("net", await run("net"));
const busy = run("cpu", 3000);
await new Promise((ok) => setTimeout(ok, 200));
log("helloDuringBusy", await run("hello"));
log("busy", await busy);
log("buf", await run("buf", 10000));
log("helloAfterBuf", await run("hello"));
log("rssMb", Math.round(Deno.memoryUsage().rss / 1e6));
log("heap", await run("heap", 20000));
log("helloAfterHeap", await run("hello"));
