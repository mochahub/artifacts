// Spike S8: a sandbox="allow-scripts" iframe on the content port, with the CORS and CSP from 03.
// Viewer: http://localhost:18080   Content: http://127.0.0.1:18081 (different sites).
// Run: PLAYWRIGHT_BROWSERS_PATH=.pw/browsers bun s8-live-frames.ts
import { webkit } from "playwright-core";

const VIEWER = "http://localhost:18080";
const CONTENT = "http://127.0.0.1:18081";
const font = await Bun.file("/System/Library/Fonts/Supplemental/Arial.ttf").arrayBuffer().catch(() => null);

type Hit = { path: string; dest: string | null; mode: string | null; site: string | null; origin: string | null; method: string };
const hits: Hit[] = [];

/** A tenth of a second of silence, as a WAV. */
const wav = (() => {
  const samples = 4410;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 44100, true); view.setUint32(28, 88200, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples * 2, true);
  return buffer;
})();

// The CSP in 03, with the content origin named explicitly, or with 'self' for comparison.
const csp = (src: string) =>
  `default-src ${src}; script-src ${src} 'unsafe-inline'; style-src ${src} 'unsafe-inline'; font-src ${src}; ` +
  `img-src ${src} data: blob:; media-src ${src} blob:; connect-src ${src}; frame-ancestors ${VIEWER}; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;

const files: Record<string, [string, string | ArrayBuffer]> = {
  "index.html": [
    "text/html",
    `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="style.css">
<script type="module" src="main.js"></script></head>
<body><p class="f">Live frame</p><img id="img" src="pixel.svg" width="10" height="10">
<audio id="audio" src="tone.wav" preload="auto"></audio>
<video id="video" src="tone.wav" preload="auto"><track id="track" default kind="captions" src="captions.vtt" srclang="en"></video></body></html>`,
  ],
  "style.css": ["text/css", `@font-face{font-family:Probe;src:url(font.ttf) format("truetype")} .f{font-family:Probe}`],
  "pixel.svg": ["image/svg+xml", `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#ffd84d"/></svg>`],
  "data.json": ["application/json", `{"hello":"world"}`],
  "font.ttf": ["font/ttf", font ?? ""],
  "main.js": [
    "text/javascript",
    `import { helper } from "./helper.js";
const r = { module: helper(), origin: self.origin, location: String(location.href).replace(/\\/t\\/[^/]+/, "/t/…") };
try { r.fetchRelative = (await (await fetch("data.json")).json()).hello; } catch (e) { r.fetchRelative = "ERR " + e; }
try { const res = await fetch("api/votes", { method: "POST", headers: { "content-type": "application/json" }, body: '{"choice":"B"}' });
      r.apiPost = res.status + " " + (await res.text()); } catch (e) { r.apiPost = "ERR " + e; }
try { await document.fonts.load("16px Probe"); r.font = document.fonts.check("16px Probe") ? "loaded" : "not loaded"; } catch (e) { r.font = "ERR " + e; }
const img = document.getElementById("img"); await (img.complete ? null : new Promise((ok) => { img.onload = img.onerror = ok; }));
r.image = img.naturalWidth > 0 ? "loaded" : "failed";
const media = (el) => new Promise((ok) => { if (el.readyState >= 1) ok("loaded"); el.onloadedmetadata = () => ok("loaded"); el.onerror = () => ok("error " + (el.error && el.error.code)); setTimeout(() => ok("timeout"), 4000); });
r.audio = await media(document.getElementById("audio"));
r.video = await media(document.getElementById("video"));
const track = document.getElementById("track"); track.track.mode = "hidden";
r.track = await new Promise((ok) => { if (track.readyState === 2) ok("loaded"); track.onload = () => ok("loaded"); track.onerror = () => ok("error"); setTimeout(() => ok("timeout readyState=" + track.readyState), 4000); });
try { localStorage.setItem("x", "1"); r.localStorage = "allowed"; } catch (e) { r.localStorage = "blocked: " + e.name; }
try { document.cookie = "a=1"; r.cookie = document.cookie === "" ? "blocked" : "allowed"; } catch (e) { r.cookie = "blocked: " + e.name; }
try { await fetch("${VIEWER}/api/me"); r.viewerFetch = "allowed"; } catch (e) { r.viewerFetch = "blocked"; }
try { await fetch("https://example.com/"); r.externalFetch = "allowed"; } catch (e) { r.externalFetch = "blocked"; }
r.topFrame = (() => { try { return String(top.location.href); } catch (e) { return "blocked: " + e.name; } })();
r.opaque = self.origin === "null";
parent.postMessage({ artifacts: 1, kind: "result", r }, "*");`,
  ],
  "tone.wav": ["audio/wav", wav],
  "captions.vtt": ["text/vtt", "WEBVTT\n\n00:00.000 --> 00:00.090\nHello\n"],
  "helper.js": ["text/javascript", `export const helper = () => "ok";`],
};

const contentHeaders = (type: string, mode: "explicit" | "self") => ({
  "content-type": type,
  "access-control-allow-origin": "*",
  "content-security-policy": csp(mode === "self" ? "'self'" : CONTENT),
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

const content = Bun.serve({
  port: 18081,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const h = req.headers;
    hits.push({ path: url.pathname.replace(/^\/t\/[^/]+/, "/t/…"), dest: h.get("sec-fetch-dest"), mode: h.get("sec-fetch-mode"), site: h.get("sec-fetch-site"), origin: h.get("origin"), method: req.method });
    const m = url.pathname.match(/^\/t\/(explicit|self)\/v1\/(.*)$/);
    if (!m) return new Response("not found", { status: 404 });
    const [, mode, path] = m as unknown as [string, "explicit" | "self", string];
    // The rule in 03: refuse top-level navigation.
    if (h.get("sec-fetch-dest") === "document") return new Response("Open this in Artifacts", { status: 403 });
    if (path.startsWith("api/")) {
      const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, PUT, DELETE", "access-control-allow-headers": "content-type", "access-control-max-age": "600" };
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      return Response.json({ path, got: await req.text() }, { headers: { ...cors, ...contentHeaders("application/json", mode) } });
    }
    const f = files[path];
    if (!f) return new Response("missing", { status: 404 });
    return new Response(f[1], { headers: contentHeaders(f[0], mode) });
  },
});

const viewer = Bun.serve({
  port: 18080,
  hostname: "localhost",
  fetch(req) {
    const mode = new URL(req.url).searchParams.get("mode") ?? "explicit";
    return new Response(
      `<!doctype html><body><iframe id="live" sandbox="allow-scripts" src="${CONTENT}/t/${mode}/v1/index.html" width="393" height="300"></iframe>
<iframe id="other" sandbox="allow-scripts" srcdoc="<script>parent.postMessage({artifacts:1,kind:'result',r:{spoof:true}},'*')</script>"></iframe>
<script>
window.__msgs = [];
const live = document.getElementById("live");
addEventListener("message", (e) => {
  window.__msgs.push({ origin: e.origin, fromLive: e.source === live.contentWindow, data: e.data });
});
</script></body>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});

const browser = await webkit.launch();
const report: Record<string, unknown> = { webkit: browser.version() };
for (const mode of ["explicit"] as const) {
  const page = await browser.newPage();
  const consoleLines: string[] = [];
  page.on("console", (m) => consoleLines.push(m.text()));
  hits.length = 0;
  await page.goto(`${VIEWER}/?mode=${mode}`);
  await page.waitForFunction(() => (window as any).__msgs.some((m: any) => m.fromLive), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
  const msgs = await page.evaluate(() => (window as any).__msgs);
  report[mode] = { msgs, hits: [...hits], console: consoleLines.filter((l) => /refused|blocked|CSP|Content Security|denied/i.test(l)) };
  await page.close();
}
// frame-ancestors: a page that isn't a listed viewer origin.
{
  const foreign = Bun.serve({ port: 18082, hostname: "127.0.0.1", fetch: () => new Response(`<!doctype html><iframe id="live" sandbox="allow-scripts" src="${CONTENT}/t/explicit/v1/index.html"></iframe><script>window.__msgs=[];addEventListener("message",(e)=>window.__msgs.push(e.data))</script>`, { headers: { "content-type": "text/html" } }) });
  const page = await browser.newPage();
  const lines: string[] = [];
  page.on("console", (m) => lines.push(m.text()));
  await page.goto("http://127.0.0.1:18082/");
  await page.waitForTimeout(1500);
  report.foreignEmbed = { msgs: await page.evaluate(() => (window as any).__msgs), console: lines.filter((l) => /ancestor|refused|blocked/i.test(l)) };
  await page.close();
  foreign.stop();
}
// Top-level navigation straight to the content host.
{
  const page = await browser.newPage();
  hits.length = 0;
  const res = await page.goto(`${CONTENT}/t/explicit/v1/index.html`);
  report.topLevel = { status: res?.status(), hits: [...hits] };
  // And what a page gets if it's opened anyway: the CSP's sandbox must make it opaque.
  const lax = Bun.serve({ port: 18083, hostname: "127.0.0.1", fetch: () => new Response("<!doctype html><p>x</p>", { headers: { "content-type": "text/html", "content-security-policy": "sandbox allow-scripts" } }) });
  await page.goto("http://127.0.0.1:18083/");
  report.topLevelOpened = await page.evaluate(() => { try { localStorage.setItem("x", "1"); return { origin: self.origin, storage: "allowed" }; } catch (e) { return { origin: self.origin, storage: "blocked: " + (e as Error).name }; } });
  lax.stop();
  await page.close();
}
await browser.close();
content.stop();
viewer.stop();
console.log(JSON.stringify(report, null, 2));
