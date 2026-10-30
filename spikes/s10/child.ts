// M10 pre-check: a sandbox child. Answers run requests in QuickJS, with env-like host calls over IPC.
import { RELEASE_SYNC, newQuickJSWASMModuleFromVariant, newVariant, shouldInterruptAfterDeadline } from "quickjs-emscripten";

const pages = (mb: number) => (mb * 1024 * 1024) / 65536;
const pending = new Map<number, (value: string) => void>();
let call = 0;

process.on("message", async (m: any) => {
  if (m.t === "env") return process.send!({ t: "env", env: process.env, keys: Object.keys(process.env), pid: process.pid, argv: process.argv.length });
  if (m.t === "result") return pending.get(m.call)?.(m.value);
  if (m.t === "crash") process.exit(3);
  if (m.t !== "run") return;
  const mod = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmMemory: new WebAssembly.Memory({ initial: pages(16), maximum: pages(64) }) }));
  const rt = mod.newRuntime();
  rt.setMemoryLimit(56 << 20);
  rt.setMaxStackSize(512 << 10);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + (m.timeout ?? 1000)));
  const ctx = rt.newContext();
  const log: string[] = [];
  const hostGet = ctx.newFunction("hostGet", (keyHandle) => {
    const key = ctx.getString(keyHandle);
    const deferred = ctx.newPromise();
    const n = ++call;
    pending.set(n, (value) => {
      if (!ctx.alive) return log.push("late result after dispose: ignored");
      const handle = ctx.newString(value);
      deferred.resolve(handle);
      handle.dispose();
      deferred.settled.then(() => rt.alive && rt.executePendingJobs());
    });
    process.send!({ t: "call", id: m.id, call: n, key });
    return deferred.handle;
  });
  ctx.setProp(ctx.global, "hostGet", hostGet);
  hostGet.dispose();
  let result: any;
  try {
    const evaluated = ctx.evalCode(m.code, "backend.js", { type: "module" });
    if (evaluated.error) { result = { threw: ctx.dump(evaluated.error) }; evaluated.error.dispose(); }
    else {
      const ns = ctx.unwrapResult(evaluated);
      const state = ctx.getPromiseState(ns);
      const exportsHandle = state.type === "fulfilled" ? (state.notAPromise ? ns : state.value) : ns;
      const fn = ctx.getProp(exportsHandle, "default");
      const called = ctx.callFunction(fn, ctx.undefined);
      fn.dispose();
      if (called.error) { result = { threw: ctx.dump(called.error) }; called.error.dispose(); }
      else {
        const handle = called.value;
        rt.executePendingJobs();
        if (m.freeNow) {
          // Teardown with a call in flight.
          handle.dispose();
          ns.dispose();
          try { ctx.dispose(); rt.dispose(); result = { freed: "while in flight" }; } catch (e) { result = { freeThrew: String(e).slice(0, 120) }; }
          process.send!({ t: "done", id: m.id, result });
          return;
        }
        const settling = ctx.resolvePromise(handle);
        rt.executePendingJobs();
        const final = await Promise.race([
          settling,
          new Promise((ok) => setTimeout(() => ok("deadline"), m.timeout ?? 1000)),
        ]) as any;
        if (final === "deadline") result = { deadline: true };
        else if (final.error) { result = { threw: ctx.dump(final.error) }; final.error.dispose(); }
        else { result = { value: ctx.dump(final.value) }; final.value.dispose(); }
        handle.dispose();
      }
      ns.dispose();
    }
    try { ctx.dispose(); rt.dispose(); } catch (e) { result.disposeThrew = String(e).slice(0, 80); }
  } catch (e) {
    result = { hostCaught: String(e).slice(0, 160) };
  }
  process.send!({ t: "done", id: m.id, result, log, rss: Math.round(process.memoryUsage().rss / 1e6) });
});
process.send!({ t: "ready", pid: process.pid });
