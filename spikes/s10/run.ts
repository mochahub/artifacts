// The four checks 08 requires before M10 relies on its design.
const SECRET = "DATABASE_URL_SECRET";
process.env[SECRET] = "postgres://secret";

function start() {
  const waiting = new Map<number, (m: any) => void>();
  let ready: () => void;
  const up = new Promise<void>((ok) => { ready = ok; });
  const envWait: ((m: any) => void)[] = [];
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/child.ts`], {
    env: {},
    stdio: ["ignore", "inherit", "inherit"],
    serialization: "json",
    ipc(m) {
      if (m.t === "ready") ready();
      if (m.t === "env") envWait.shift()?.(m);
      if (m.t === "call") child.send({ t: "result", call: m.call, value: `value of ${m.key}` });
      if (m.t === "done") waiting.get(m.id)?.(m);
    },
  });
  const run = (id: number, code: string, extra = {}) => new Promise<any>((ok) => { waiting.set(id, ok); child.send({ t: "run", id, code, ...extra }); });
  return { child, up, run, env: () => new Promise<any>((ok) => { envWait.push(ok); child.send({ t: "env" }); }) };
}

const a = start();
await a.up;
const env = await a.env();
console.log("1. empty env, ipc works:", JSON.stringify({ keys: env.keys, leak: SECRET in env.env }));
console.log("   async host call over IPC:", JSON.stringify((await a.run(1, `export default async () => "got " + await hostGet("votes");`)).result));

// Pinning: requests for a hash go to one child, others run there at once; a busy one doesn't block a second child.
const b = start();
await b.up;
const t0 = performance.now();
const busy = a.run(2, `export default () => { while (true) {} };`, { timeout: 1000 });
const quick = await b.run(3, `export default () => 6 * 7;`);
const quickMs = Math.round(performance.now() - t0);
const looped = await busy;
console.log("2. second child answered in", quickMs, "ms during a busy loop:", JSON.stringify(quick.result), "| loop ended:", JSON.stringify(looped.result).slice(0, 110), "after", Math.round(performance.now() - t0), "ms");

console.log("3. free with a call in flight:", JSON.stringify((await a.run(4, `export default async () => await hostGet("slow");`, { freeNow: true })).result));
console.log("   same child still works:", JSON.stringify((await a.run(5, `export default () => "alive";`)).result));

for (const [name, code] of [
  ["typed-array flood", `export default () => { const k = []; while (true) k.push(new Uint8Array(1 << 20)); };`],
  ["string flood", `export default () => { const k = []; while (true) k.push("x".repeat(1 << 20) + k.length); };`],
  ["deep recursion", `const f = (n) => f(n + 1) + 1; export default () => f(0);`],
] as const) {
  const r = await a.run(10, code, { timeout: 4000 });
  console.log(`4. ${name}:`, JSON.stringify(r.result).slice(0, 140), "rss", r.rss);
}
console.log("   child alive after floods:", JSON.stringify((await a.run(6, `export default () => "still here";`)).result));

// A real abort: corrupt the instance's memory past its limit by exhausting the wasm stack in a host re-entry.
const aborted = await a.run(7, `export default () => { const huge = []; for (;;) { huge.push(new Array(1e6).fill({})); } };`, { timeout: 4000 });
console.log("   heavy heap:", JSON.stringify(aborted.result).slice(0, 160));
console.log("   child alive after:", JSON.stringify((await a.run(8, `export default () => 1 + 1;`)).result));

// A crash: the child dies and the parent finds out.
const exited = b.child.exited;
b.child.send({ t: "crash" });
console.log("5. crashed child exit code:", await exited);
a.child.kill();
