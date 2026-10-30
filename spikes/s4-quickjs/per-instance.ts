// Does one WebAssembly instance per backend free its memory when discarded after an out-of-memory failure?
import { newQuickJSWASMModule, RELEASE_SYNC, shouldInterruptAfterDeadline } from "quickjs-emscripten";
const mb = () => Math.round(process.memoryUsage().rss / 1e6);
async function runOnce(src: string, memoryMb: number, timeoutMs: number) {
  const mod = await newQuickJSWASMModule(RELEASE_SYNC);   // a fresh instance with its own linear memory
  const rt = mod.newRuntime();
  rt.setMemoryLimit(memoryMb * 1024 * 1024);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
  const ctx = rt.newContext();
  const r = ctx.evalCode(src);
  let out: string;
  if (r.error) { out = "error: " + JSON.stringify(ctx.dump(r.error)).slice(0, 60); r.error.dispose(); } else { out = "ok"; r.value.dispose(); }
  ctx.dispose(); rt.dispose();      // all handles freed, so no assertion
  return out;                        // `mod` goes out of scope here
}
console.log("start", mb());
const t0 = performance.now(); await runOnce("1+1", 32, 1000); console.log("one instance create+run ms", Math.round(performance.now() - t0));
for (let i = 0; i < 5; i++) console.log("buf OOM", await runOnce("const k=[]; while(true) k.push(new Uint8Array(1<<20))", 32, 5000), "rss", mb());
for (let i = 0; i < 5; i++) console.log("heap OOM", await runOnce("const k=[]; while(true) k.push({s:'x'+k.length})", 32, 5000), "rss", mb());
console.log("cpu", await runOnce("while(true){}", 32, 300), "rss", mb());
Bun.gc(true); await Bun.sleep(300); Bun.gc(true);
console.log("after gc", mb());
// 100 instances alive at once: the cost of keeping many backends warm
const keep = []; for (let i = 0; i < 100; i++) { const m = await newQuickJSWASMModule(RELEASE_SYNC); const rt = m.newRuntime(); keep.push(rt.newContext()); }
console.log("100 warm instances", mb());
