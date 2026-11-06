// The app's side of the sandbox (08): starting a child, and the request a backend sees and the answer it
// gives. The app's pool, `artifacts dev` and `artifacts render` all use it. Wherever this file is, child.js
// and prelude.js are beside it: in packages/sandbox/src, beside the server's bundle, and in the CLI's helper
// folder. Types are in index.d.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;

/** Starts a child with an empty environment and only an IPC channel (08). */
export function startChild({ onExit } = {}) {
  const prelude = readFileSync(join(here, "prelude.js"), "utf8");
  const inFlight = new Map();
  const sent = new Set();
  let ready;
  const up = new Promise((done) => {
    ready = done;
  });
  let pong = null;

  const child = Bun.spawn([process.execPath, join(here, "child.js")], {
    env: { BUN_BE_BUN: "1" },
    stdio: ["ignore", "ignore", "ignore"],
    serialization: "json",
    ipc(message) {
      if (message.t === "ready") ready();
      if (message.t === "pong") pong?.(message.env);
      if (message.t === "started") inFlight.get(message.id)?.onStart?.();
      if (message.t === "data") {
        const job = inFlight.get(message.id);
        const answer = job
          ? job
              .onData(message.op)
              .catch((error) => ({ error: { code: error.code ?? "failed", message: error.message } }))
          : Promise.resolve({ error: { code: "forbidden", message: "That request is over." } });
        answer.then((value) => {
          if (child.exitCode === null) {
            child.send({ t: "data-result", call: message.call, answer: JSON.stringify(value) });
          }
        });
      }
      if (message.t === "done") {
        const job = inFlight.get(message.id);
        if (!job) return;
        if (message.needsCode) {
          job.resend();
          return;
        }
        inFlight.delete(message.id);
        job.finish({ response: message.response, logs: message.logs });
      }
    },
  });

  child.exited.then(() => {
    for (const job of inFlight.values()) job.finish({ crashed: true, logs: [] });
    inFlight.clear();
    onExit?.();
  });

  return {
    up,
    pid: child.pid,
    kill: () => child.kill(9),
    alive: () => child.exitCode === null,
    /** Runs one request. Resolves when the child answers or dies. */
    run({ id, hash, code, limits, request, onData, onStart }) {
      return new Promise((finish) => {
        const send = (withCode) =>
          child.send({
            t: "run",
            id,
            hash,
            limits,
            request,
            ...(withCode ? { code: code(), prelude } : {}),
          });
        inFlight.set(id, { finish, onData, onStart, resend: () => Promise.resolve().then(() => send(true)) });
        send(!sent.has(hash));
        sent.add(hash);
      });
    },
    /** The names in the child's environment, which should hold nothing but BUN_BE_BUN. */
    env: () =>
      new Promise((done) => {
        pong = done;
        child.send({ t: "ping" });
      }),
  };
}

/** One child for this process, started on first use and again after it exits: `dev` and `render` need no more. */
export function localSandbox() {
  let child = null;
  let id = 0;
  return {
    async run(job) {
      child ??= startChild({
        onExit: () => {
          child = null;
        },
      });
      const running = child;
      await running.up;
      return running.run({ ...job, id: ++id });
    },
    kill: () => child?.kill(),
  };
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "600",
};
/** Only these reach the browser: a backend can't set cookies, or anything else on the content origin (08). */
export const SAFE_HEADERS = new Set(["content-type", "etag", "last-modified"]);
export const preflight = () => new Response(null, { status: 204, headers: CORS });

const MAX_LOG_LINES = 100;
const MAX_LOG_BYTES = 8192;

/** What a request may log (08): so many lines, each so long, and no NUL, which Postgres refuses. */
const keepLogs = (logs) =>
  logs.slice(0, MAX_LOG_LINES).map((line) => ({
    level: line.level,
    message: Buffer.from(String(line.message).replaceAll("\0", "")).subarray(0, MAX_LOG_BYTES).toString(),
  }));

/** `votes` means shared/votes; a backend may also name `shared/…`, `me/<id>/…` or `files/…` (08). */
export const scopedKey = (key) => (/^(shared|me|files)\//.test(key) ? key : `shared/${key}`);

const STOPPED = { status: 502, headers: [], body: '{"error":"The sandbox stopped."}' };

/** The backend's answer, sent on only if it can be (08): its own code made it, so nothing in it is trusted. */
function answer(response, limits) {
  const refused = (message) =>
    new Response(JSON.stringify({ error: message }), {
      status: 502,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  try {
    if (typeof response.body !== "string") throw new TypeError("The body isn't text.");
    if (Buffer.byteLength(response.body) > limits.backendResponseBytes) {
      return refused("The response is too big.");
    }
    // A caller's own answer, so nothing between here and them may keep it.
    const headers = new Headers({ ...CORS, "Cache-Control": "no-store" });
    for (const [name, value] of response.headers)
      if (SAFE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return refused("The backend gave an answer that can't be sent.");
  }
}

/**
 * Runs one request through a backend, as the content host does (08, "Request flow"). `run` is where it runs:
 * the app's pool, or a local sandbox. The caller and the limits are the app's, and the backend sees the
 * caller only as the X-Caller header set here.
 */
export async function runBackend({ run, hash, code, limits, caller, request, onData }) {
  const result = await run({
    hash,
    code,
    limits: {
      timeoutMs: limits.backendTimeoutMs,
      memoryMb: limits.backendMemoryMb,
      dataOpBytes: limits.dataValueBytes + 1024,
      logLines: MAX_LOG_LINES,
      logBytes: MAX_LOG_BYTES,
    },
    request: {
      url: `https://backend.invalid/api/${request.path}${request.search}`,
      method: request.method,
      headers: {
        ...(request.contentType ? { "content-type": request.contentType } : {}),
        "x-caller": JSON.stringify(caller),
      },
      body: request.body,
    },
    onData: (raw) => onData(JSON.parse(raw)),
  });
  return {
    response: answer(result.crashed || !result.response ? STOPPED : result.response, limits),
    logs: keepLogs(result.logs ?? []),
  };
}

const conflict = { error: { code: "precondition_failed", message: "Someone wrote first." } };

/** env.DATA over a plain store of keys such as `shared/votes`, for `dev` and `render`: the app's answers, locally. */
export function localData(store) {
  return async (op) => {
    const named = op.op === "list" ? op.prefix || "shared/" : (op.key ?? "");
    if (store.valid && !store.valid(named)) {
      return { error: { code: "invalid", message: "That isn't a valid key." } };
    }
    if (op.op === "list") {
      const prefix = op.prefix ?? "";
      const base = prefix ? scopedKey(prefix) : "shared/";
      const keys = store
        .keys()
        .filter((key) => key.startsWith(base))
        .map((key) => `${prefix}${key.slice(base.length)}`);
      return { value: { keys, nextCursor: null } };
    }
    const key = scopedKey(named);
    if (op.op === "get") return { value: store.get(key) ?? null };
    const etag = store.etag(key);
    if (op.ifMatch && (op.ifMatch === "*" ? etag !== null : etag !== op.ifMatch)) return conflict;
    if (op.op === "put") return { value: { etag: store.put(key, op.value) } };
    if (op.op === "delete") store.delete(key);
    return { value: true };
  };
}
