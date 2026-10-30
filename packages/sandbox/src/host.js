// The parent's side of one sandbox process. The app's pool, `artifacts dev` and `render` all use it.

/**
 * Starts a child with an empty environment and only an IPC channel (08). `childPath` is child.js,
 * where quickjs-emscripten can be resolved from it. `prelude` is prelude.js as text.
 */
export function startChild({ childPath, prelude, onExit }) {
  const inFlight = new Map();
  const sent = new Set();
  let ready;
  const up = new Promise((done) => {
    ready = done;
  });
  let pong = null;

  const child = Bun.spawn([process.execPath, childPath], {
    env: { BUN_BE_BUN: "1" },
    stdio: ["ignore", "ignore", "ignore"],
    serialization: "json",
    ipc(message) {
      if (message.t === "ready") ready();
      if (message.t === "pong") pong?.(message.env);
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
    run({ id, hash, code, limits, request, onData }) {
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
        inFlight.set(id, { finish, onData, resend: () => Promise.resolve().then(() => send(true)) });
        send(!sent.has(hash));
        sent.add(hash);
      });
    },
    env: () =>
      new Promise((done) => {
        pong = done;
        child.send({ t: "ping" });
      }),
  };
}
