// A hard cap on each instance's WebAssembly memory.
import { newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC } from "quickjs-emscripten";
const mb = () => Math.round(process.memoryUsage().rss / 1e6);
const PAGES = (m: number) => (m * 1024 * 1024) / 65536;
async function instance(capMb: number) {
  const variant = newVariant(RELEASE_SYNC, { wasmMemory: new WebAssembly.Memory({ initial: PAGES(16), maximum: PAGES(capMb) }) });
  return newQuickJSWASMModuleFromVariant(variant);
}
for (const [label, src] of [
  ["1 MB typed arrays", "const k=[]; while(true) k.push(new Uint8Array(1<<20))"],
  ["64 KB typed arrays", "const k=[]; while(true) k.push(new Uint8Array(1<<16))"],
  ["1 MB strings", "const k=[]; while(true) k.push('x'.repeat(1<<20)+k.length)"],
  ["heap objects", "const k=[]; while(true) k.push({s:'x'+k.length})"],
  ["deep recursion", "function f(n){return f(n+1)+1}; f(0)"],
  ["normal work", "JSON.stringify(Array.from({length:1000},(_, i)=>({i}))).length"],
] as const) {
  let res: string;
  const before = mb();
  try {
    const mod = await instance(64);
    const rt = mod.newRuntime(); rt.setMemoryLimit(48 << 20); rt.setMaxStackSize(512 << 10);
    const ctx = rt.newContext();
    const r = ctx.evalCode(src);
    res = r.error ? "threw: " + ctx.dump(r.error).message : "ok: " + ctx.dump(r.value);
    (r.error ?? r.value).dispose();
    try { ctx.dispose(); rt.dispose(); } catch (e) { res += " (dispose: " + String(e).slice(0, 50) + ")"; }
    res += "  wasm MB " + Math.round(mod.getWasmMemory().buffer.byteLength / 1e6);
  } catch (e) { res = "host caught: " + String(e).slice(0, 100); }
  Bun.gc(true);
  console.log(label.padEnd(20), res.padEnd(48), "rss", before, "->", mb());
}
// The host is still healthy:
const mod = await instance(64); const ctx = mod.newRuntime().newContext(); const r = ctx.evalCode("6*7"); console.log("host still fine:", ctx.dump(r.value));
