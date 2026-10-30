// The loader Worker (08). Each backend is wrapped in a shim that builds env.DATA from the per-request dataKey.
const SHIM = `
import user from "./user.js";
export default {
  async fetch(request, env, ctx) {
    const dataKey = ctx.props?.dataKey;
    const DATA = {
      get: (key) => env.DATA_SVC.call(dataKey, "GET", key),
      put: (key, value) => env.DATA_SVC.call(dataKey, "PUT", key, value),
      delete: (key) => env.DATA_SVC.call(dataKey, "DELETE", key),
    };
    return user.fetch(request, { DATA }, ctx);
  },
};`;
let loads = 0;
export default {
  async fetch(req, env) {
    if (req.headers.get("authorization") !== `Bearer ${env.RUNNER_SECRET}`) return new Response("no", { status: 401 });
    const hash = req.headers.get("x-backend-hash");
    const cpuMs = Number(req.headers.get("x-cpu-ms") ?? 0) || undefined;
    if (new URL(req.url).pathname === "/loads") return Response.json({ loads });
    const worker = env.LOADER.get(hash, async () => {
      loads++;
      const src = await (await env.APP.fetch(`http://app/internal/backends/${hash}`, { headers: { authorization: `Bearer ${env.RUNNER_SECRET}` } })).text();
      return {
        compatibilityDate: "2026-10-01",
        mainModule: "shim.js",
        modules: { "shim.js": SHIM, "user.js": src },
        env: { DATA_SVC: env.DATA_SVC },
        globalOutbound: null,
        tails: [env.LOGS],
        ...(cpuMs ? { limits: { cpuMs } } : {}),
      };
    });
    const inner = new Request(new URL(req.headers.get("x-forwarded-path") ?? "/", "https://artifact.local"), {
      method: req.method, headers: { "x-caller": req.headers.get("x-caller") ?? "{}" }, body: req.body,
    });
    const t0 = Date.now();
    try {
      const res = await worker.getEntrypoint(undefined, { props: { dataKey: req.headers.get("x-data-key") }, ...(cpuMs ? { limits: { cpuMs } } : {}) }).fetch(inner);
      const out = new Response(res.body, res);
      out.headers.set("x-runner-ms", String(Date.now() - t0));
      return out;
    } catch (e) {
      return Response.json({ runnerError: String(e?.message ?? e), ms: Date.now() - t0 }, { status: 500 });
    }
  },
};
