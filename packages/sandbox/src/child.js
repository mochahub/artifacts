// A sandbox process (08). Runs with an empty environment and talks only to its parent. Each backend
// gets its own WebAssembly instance with capped memory, so one can't touch or starve another.
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  RELEASE_SYNC,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten";

const MAX_INSTANCES = 16;
const IDLE_MS = 10 * 60_000;
const MAX_LOG_LINES = 100;
const MAX_LOG_BYTES = 8192;
const MB = 1024 * 1024;
const PAGE = 65536;
const MAX_DATA_AT_ONCE = 8;
const MAX_DATA_CALLS = 200;

const instances = new Map();
const calls = new Map();
let nextCall = 0;

/** Frees if it can. A free can abort emscripten; that kills only this instance, so it's just dropped. */
function discard(hash) {
  const instance = instances.get(hash);
  if (!instance) return;
  instances.delete(hash);
  for (const handle of instance.handles) {
    try {
      handle.dispose();
    } catch {}
  }
  try {
    instance.ctx.dispose();
    instance.rt.dispose();
  } catch {}
}

async function load(hash, code, prelude, limits) {
  const variant = newVariant(RELEASE_SYNC, {
    wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: (limits.memoryMb * MB) / PAGE }),
  });
  const mod = await newQuickJSWASMModuleFromVariant(variant);
  const rt = mod.newRuntime();
  rt.setMemoryLimit((limits.memoryMb - 8) * MB);
  rt.setMaxStackSize(512 * 1024);
  // No module loader: `import` of anything fails, and the code is one bundled module (05).
  rt.setModuleLoader((name) => ({ error: new Error(`Backends can't import ${name}`) }));
  const ctx = rt.newContext();
  const instance = { mod, rt, ctx, current: null, handles: [], lastUsed: Date.now() };

  const host = ctx.newObject();
  const log = ctx.newFunction("log", (level, text) => {
    const run = instance.current;
    if (run && run.logs.length < MAX_LOG_LINES) {
      run.logs.push({ level: ctx.getString(level), message: ctx.getString(text).slice(0, MAX_LOG_BYTES) });
    }
  });
  const data = ctx.newFunction("data", (json) => {
    const deferred = ctx.newPromise();
    const settle = (answer) => {
      const value = ctx.newString(answer);
      deferred.resolve(value);
      value.dispose();
    };
    const refuse = (code, message) => {
      settle(JSON.stringify({ error: { code, message } }));
      return deferred.handle;
    };
    // Bare work after a response has no request to belong to, so it never reaches the app.
    const run = instance.current;
    if (!run) return refuse("forbidden", "That request is over.");
    if (++run.dataCalls > MAX_DATA_CALLS)
      return refuse("rate_limited", "Too many data calls in one request.");
    const op = ctx.getString(json);
    if (op.length > run.maxDataOp) return refuse("too_large", "That's over the limit for saved data.");
    const id = ++nextCall;
    const send = () => {
      run.dataActive += 1;
      process.send({ t: "data", id: run.id, call: id, op });
    };
    calls.set(id, (answer) => {
      calls.delete(id);
      run.dataActive -= 1;
      run.dataWaiting.shift()?.();
      if (!ctx.alive) return;
      settle(answer);
      rt.executePendingJobs();
    });
    if (run.dataActive < MAX_DATA_AT_ONCE) send();
    else run.dataWaiting.push(send);
    return deferred.handle;
  });
  ctx.setProp(host, "log", log);
  ctx.setProp(host, "data", data);
  ctx.setProp(ctx.global, "__host", host);
  log.dispose();
  data.dispose();
  host.dispose();

  ctx.unwrapResult(ctx.evalCode(prelude, "prelude.js")).dispose();
  // Top-level code gets the same clock as a request, or a loop there would hold this whole process.
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.timeoutMs));
  const backend = ctx.unwrapResult(ctx.evalCode(code, "backend.js", { type: "module" }));
  instance.backend = backend;
  instance.handles.push(backend);
  while (instances.size >= MAX_INSTANCES) {
    // Never one that's running: the limit can pass 16 for a moment instead.
    const idle = [...instances.entries()].filter(([, entry]) => !entry.current);
    if (idle.length === 0) break;
    discard(idle.sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0][0]);
  }
  instances.set(hash, instance);
  return instance;
}

async function run(message) {
  const { id, hash, limits, request } = message;
  // The parent's backstop clock starts here, not when it sent the message: the queue below runs one
  // request at a time, so a request can wait behind another backend's loop without having done anything wrong.
  process.send({ t: "started", id });
  const logs = [];
  const answer = (body) => process.send({ t: "done", id, logs, ...body });
  let instance = instances.get(hash);
  if (!instance && !message.code) return answer({ needsCode: true });

  const fail = (status, code, text) => {
    logs.push({ level: "error", message: text });
    discard(hash);
    answer({
      response: {
        status,
        headers: [["content-type", "application/json"]],
        body: JSON.stringify({ error: code }),
      },
    });
  };

  try {
    instance ??= await load(hash, message.code, message.prelude, limits);
  } catch (error) {
    const text = `The backend failed to load: ${String(error?.message ?? error)}`;
    return /interrupted/.test(text) ? fail(504, "timeout", text) : fail(500, "load_failed", text);
  }
  // After loading: creating an instance isn't the backend's time.
  const started = Date.now();
  const deadline = started + limits.timeoutMs;
  const { ctx, rt, backend } = instance;
  instance.lastUsed = started;
  const current = {
    id,
    logs,
    dataCalls: 0,
    dataActive: 0,
    dataWaiting: [],
    maxDataOp: limits.dataOpBytes ?? Number.POSITIVE_INFINITY,
  };
  instance.current = current;
  rt.setInterruptHandler(shouldInterruptAfterDeadline(deadline));

  let result;
  try {
    const state = ctx.getPromiseState(backend);
    const exportsHandle = state.type === "fulfilled" ? (state.notAPromise ? backend : state.value) : backend;
    const fallback = ctx.getProp(exportsHandle, "default");
    const handleFn = ctx.getProp(ctx.global, "__artifactsHandle");
    const input = ctx.newString(JSON.stringify(request));
    const called = ctx.callFunction(handleFn, ctx.undefined, fallback, input);
    input.dispose();
    handleFn.dispose();
    fallback.dispose();
    const promise = ctx.unwrapResult(called);
    const settled = ctx.resolvePromise(promise);
    rt.executePendingJobs();
    const final = await Promise.race([
      settled,
      new Promise((done) => setTimeout(() => done("timeout"), Math.max(0, deadline - Date.now()))),
    ]);
    if (final === "timeout") {
      // Left unfreed for now: `discard` handles a promise that's still pending.
      return fail(504, "timeout", "The backend took too long.");
    }
    if (final.error) {
      const error = ctx.dump(final.error);
      final.error.dispose();
      promise.dispose();
      const message_ = String(error?.message ?? error);
      if (/interrupted/.test(message_)) return fail(504, "timeout", "The backend took too long.");
      return fail(500, "failed", message_);
    }
    result = JSON.parse(ctx.getString(final.value));
    final.value.dispose();
    promise.dispose();
    // An interrupt after an await reaches the handler's own catch, so the clock decides.
    if (Date.now() >= deadline) return fail(504, "timeout", "The backend took too long.");
  } catch (error) {
    const text = String(error?.message ?? error);
    return fail(/interrupted/.test(text) ? 504 : 500, "failed", text);
  } finally {
    instance.current = null;
  }
  // A backend that answered with calls still out would carry on under the next caller, so it's replaced.
  const outstanding = current.dataActive + current.dataWaiting.length > 0;
  current.dataWaiting.length = 0;
  // WebAssembly memory never shrinks, so an instance that has grown is replaced too (08).
  if (outstanding || instance.mod.getWasmMemory().buffer.byteLength > (limits.memoryMb * MB) / 2)
    discard(hash);
  answer({ response: result });
}

// Without a parent nobody can use this process, and nothing else would stop it.
process.on("disconnect", () => process.exit(0));

// One request at a time (08). A run yields while it loads or awaits env.DATA, so without this queue two
// could interleave, "started" could go out for a request that then waits behind another's loop, and the
// parent's backstop would kill the child for it.
let queue = Promise.resolve();
process.on("message", (message) => {
  if (message.t === "run") queue = queue.then(() => run(message)).catch(() => {});
  if (message.t === "data-result") calls.get(message.call)?.(message.answer);
  if (message.t === "ping") process.send({ t: "pong", env: Object.keys(process.env) });
  if (message.t === "evict") discard(message.hash);
});

setInterval(() => {
  const now = Date.now();
  for (const [hash, instance] of instances) if (now - instance.lastUsed > IDLE_MS) discard(hash);
}, 60_000).unref();

process.send({ t: "ready" });
