import { newQuickJSWASMModule, RELEASE_SYNC } from "quickjs-emscripten";
const mb = () => Math.round(process.memoryUsage().rss / 1e6);
for (const [label, src] of [
  ["1 MB typed arrays", "const k=[]; while(true) k.push(new Uint8Array(1<<20))"],
  ["64 KB typed arrays", "const k=[]; while(true) k.push(new Uint8Array(1<<16))"],
  ["one 100 MB typed array", "new Uint8Array(100<<20).length"],
  ["one 1 GB typed array", "new Uint8Array(1<<30).length"],
  ["1 MB strings", "const k=[]; while(true) k.push('x'.repeat(1<<20)+k.length)"],
] as const) {
  const mod = await newQuickJSWASMModule(RELEASE_SYNC);
  const rt = mod.newRuntime(); rt.setMemoryLimit(32 << 20);
  const ctx = rt.newContext();
  const before = mb();
  const r = ctx.evalCode(src);
  const res = r.error ? ctx.dump(r.error).message : ctx.dump(r.value);
  (r.error ?? r.value).dispose();
  const mem = (mod as any).getWasmMemory?.()?.buffer?.byteLength;
  console.log(label.padEnd(24), String(res).padEnd(14), "wasm MB", mem ? Math.round(mem / 1e6) : "?", "rss MB", before, "->", mb());
  ctx.dispose(); rt.dispose();
  Bun.gc(true);
}
