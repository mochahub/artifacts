// Railway spike app for S1, S2 and S6. One file, no dependencies, `bun app.ts`.
// ROLE=app (default): listens on 8080 (viewer A), 8081 (content), 8083 (viewer B).
// ROLE=runner: listens on 8090 for the private-network wake test (S6), with Serverless sleep on.
const role = process.env.ROLE ?? "app";

if (role === "runner") {
  const started = Date.now();
  Bun.serve({ port: Number(process.env.PORT ?? 8090), hostname: "::", fetch: () => Response.json({ ok: true, upMs: Date.now() - started }) });
  console.log(JSON.stringify({ msg: "runner listening", started }));
} else {
  const env = process.env;
  const origin = (v?: string) => (v ? `https://${v}` : "");
  // Set these after `railway domain` prints the generated domains (S1 records which variable Railway fills).
  const A = env.VIEWER_A_URL ?? origin(env.RAILWAY_PUBLIC_DOMAIN);
  const B = env.VIEWER_B_URL ?? "";
  const html = (body: string) => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:17px -apple-system,system-ui;margin:24px;max-width:640px}button{font:inherit;padding:12px 16px;margin:6px 0;display:block}pre{white-space:pre-wrap;background:#f2f2f2;padding:12px}</style>${body}`, { headers: { "content-type": "text/html; charset=utf-8" } });

  const s1 = (port: number, req: Request) => Response.json({
    port,
    host: req.headers.get("host"),
    // Names only: values could be secrets. Lengths show that ${{secret(n)}} produced something.
    variableNames: Object.keys(env).sort(),
    secretLengths: Object.fromEntries(["SETUP_TOKEN", "SESSION_SECRET", "OPS_SECRET", "RUNNER_SECRET"].map((k) => [k, env[k]?.length ?? null])),
    railway: Object.fromEntries(Object.entries(env).filter(([k]) => /^RAILWAY_(PUBLIC_DOMAIN|PRIVATE_DOMAIN|SERVICE_NAME|ENVIRONMENT_NAME|TCP_PROXY_PORT|STATIC_URL)/.test(k))),
  });

  const page = (here: "A" | "B") => html(`
<h1>S2 passkeys: viewer ${here}</h1>
<p>Home domain (RP ID): <b>${new URL(A || "https://unset").host}</b>. This page: <b id="h"></b></p>
<button onclick="caps()">1. Check getClientCapabilities()</button>
<button onclick="reg()">2. Create a passkey for the home domain</button>
<button onclick="signin()">3. Sign in with the home domain's passkey</button>
${here === "B" ? `<p>Fallback: <a href="${A}/">Sign in on the home domain</a></p>` : `<p>Then open <a href="${B}/">viewer B</a> and press 3 there.</p>`}
<pre id="out"></pre>
<script>
document.getElementById("h").textContent = location.host;
const rpId = ${JSON.stringify(new URL(A || "https://unset").host)};
const out = (x) => { document.getElementById("out").textContent += (typeof x === "string" ? x : JSON.stringify(x, null, 1)) + "\\n"; };
const rnd = () => crypto.getRandomValues(new Uint8Array(32));
async function caps() { try { out(await PublicKeyCredential.getClientCapabilities()); } catch (e) { out("getClientCapabilities: " + e); } out(navigator.userAgent); }
async function reg() {
  try { const c = await navigator.credentials.create({ publicKey: { rp: { id: rpId, name: "Artifacts spike" }, user: { id: rnd(), name: "spike@example.com", displayName: "Spike" },
    challenge: rnd(), pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }], authenticatorSelection: { residentKey: "required", userVerification: "preferred" } } });
    out("CREATED on " + location.host + " for rpId " + rpId + ": " + c.id.slice(0, 16) + "…"); } catch (e) { out("create failed on " + location.host + ": " + e.name + " " + e.message); }
}
async function signin() {
  try { const c = await navigator.credentials.get({ publicKey: { rpId, challenge: rnd(), userVerification: "preferred" } });
    const cd = JSON.parse(new TextDecoder().decode(c.response.clientDataJSON));
    out({ result: "SIGNED IN", page: location.host, rpId, clientDataOrigin: cd.origin, crossOrigin: cd.crossOrigin ?? null }); }
  catch (e) { out("get failed on " + location.host + ": " + e.name + " " + e.message); }
}
</script>`);

  const wake = async () => {
    // S6: call the sleeping runner over the private network and time each attempt.
    const url = env.RUNNER_URL ?? "http://runner.railway.internal:8090/";
    const tries: unknown[] = [];
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) {
      const t = Date.now();
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
        tries.push({ i, status: r.status, ms: Date.now() - t, body: (await r.text()).slice(0, 200) });
        if (r.ok) break;
      } catch (e) {
        tries.push({ i, error: String(e).slice(0, 200), ms: Date.now() - t });
      }
      await Bun.sleep(500);
    }
    return Response.json({ url, totalMs: Date.now() - t0, tries });
  };

  const serve = (port: number, who: "A" | "B" | "content") =>
    Bun.serve({
      port,
      hostname: "::",
      async fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/s1") return s1(port, req);
        if (pathname === "/api/health") return Response.json({ ok: true, port });
        if (who === "content") return new Response(`content port ${port}`, { headers: { "access-control-allow-origin": "*" } });
        if (pathname === "/.well-known/webauthn" && who === "A") return Response.json({ origins: [B].filter(Boolean) });
        if (pathname === "/wake") return wake();
        return page(who);
      },
    });
  serve(8080, "A");
  serve(8081, "content");
  serve(8083, "B");
  console.log(JSON.stringify({ msg: "app listening", ports: [8080, 8081, 8083], A, B }));
}
