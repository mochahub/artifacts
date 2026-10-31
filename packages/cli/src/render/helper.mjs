// The render helper (07). Runs under Bun from ~/.artifacts/playwright, where playwright-core, sharp
// and mermaid are installed, because a compiled binary can't load them. Takes a job file, writes
// WebP renders into job.out, and writes job.out/result.json.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { webkit } from "playwright-core";
import sharp from "sharp";

const job = JSON.parse(readFileSync(process.argv[2], "utf8"));

/** A backend, run the same way as on the server, against the fixtures and read-only (05). */
let sandbox = null;
let sandboxId = 0;
async function runBackend(request, path) {
  if (!job.backend) return new Response("no backend", { status: 404 });
  const { startChild } = await import("./sandbox-host.js");
  const dir = dirname(process.argv[1]);
  sandbox ??= startChild({
    childPath: join(dir, "sandbox-child.js"),
    prelude: readFileSync(join(dir, "sandbox-prelude.js"), "utf8"),
  });
  await sandbox.up;
  const code = readFileSync(job.backend, "utf8");
  const { response } = await sandbox.run({
    id: ++sandboxId,
    hash: sha256(code),
    code: () => code,
    limits: { timeoutMs: 10_000, memoryMb: 64 },
    request: {
      url: `https://backend.invalid/${path}`,
      method: request.method,
      headers: {
        "content-type": request.headers.get("content-type") ?? "",
        "x-caller": JSON.stringify({
          id: "preview",
          name: "Preview",
          kind: "member",
          canComment: false,
          isPublisher: false,
        }),
      },
      body: await request.text(),
    },
    onData: async (raw) => {
      const op = JSON.parse(raw);
      if (op.op === "get") return { value: job.fixtures.shared?.[op.key] ?? null };
      if (op.op === "list") return { value: Object.keys(job.fixtures.shared ?? {}) };
      return { value: true };
    },
  });
  return new Response(response.body, { status: response.status, headers: new Headers(response.headers) });
}
const SCALES = [1, 2, 3];
const VIEWPORT = { width: 1600, height: 1200 };
const NOW = new Date("2026-01-01T09:41:00").getTime();
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
};

const realRoot = realpathSync(job.root);
const inside = (path) => path.startsWith(realRoot + sep);

/** The bundle on 127.0.0.1, with generated board pages beside each board's own file. */
const pagesByPath = new Map();
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname).slice(1);
    const generated = pagesByPath.get(path);
    const api = /(?:^|\/)(api\/.*)$/.exec(path);
    if (api && job.backend) return runBackend(request, api[1]);
    if (generated) return new Response(generated, { headers: { "Content-Type": "text/html" } });
    // Only files that really live under the bundle: "/..%2Froot-x/secret" is a sibling folder whose
    // name starts the same, and a link in the bundle may lead anywhere. The page's own script asks here.
    const file = Bun.file(resolve(realRoot, path));
    if (!inside(resolve(realRoot, path)) || !(await file.exists()) || !inside(realpathSync(file.name))) {
      return new Response("missing", { status: 404 });
    }
    const type = TYPES[path.slice(path.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";
    return new Response(file, { headers: { "Content-Type": type } });
  },
});
const origin = `http://127.0.0.1:${server.port}`;

const relativeUp = (dir) =>
  dir === "."
    ? ""
    : `${dir
        .split("/")
        .map(() => "..")
        .join("/")}/`;

function boardPage(board) {
  const dir = dirname(board.src);
  const up = relativeUp(dir);
  const body = readFileSync(join(job.root, board.src), "utf8");
  return `<!doctype html><html><head><meta charset="utf-8">
${board.styles.map((path) => `<link rel="stylesheet" href="${up}${path}">`).join("\n")}
${board.scripts.map((path) => `<script src="${up}${path}"></script>`).join("\n")}
<style>html,body{margin:0}body{padding:40px;display:flex;flex-wrap:wrap;gap:40px;align-items:flex-start}
*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}</style>
</head><body>${body}</body></html>`;
}

/** 05, step 2: the same pixels every time. */
const determinism = (fixtures, seed, now) => `
  window.__ARTIFACTS_FIXTURES__ = ${JSON.stringify(fixtures)};
  { const RealDate = Date; const NOW = ${now};
    class FrozenDate extends RealDate { constructor(...args) { if (args.length) super(...args); else super(NOW); } static now() { return NOW; } }
    window.Date = FrozenDate; }
  { let state = ${[...seed].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) | 0, 7)} >>> 0;
    Math.random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; }; }`;

async function openBoard(browser, board, scale, failures, fixtures = job.fixtures) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: scale,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.addInitScript(determinism(fixtures, board.key, NOW));
  await page.route("**", (route) => {
    if (route.request().url().startsWith(origin)) return route.continue();
    failures.add(route.request().url());
    return route.abort();
  });
  page.on("response", (response) => {
    if (response.status() === 404) failures.add(response.url().replace(origin, ""));
  });
  await page.goto(`${origin}/${board.shell}`, { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
  });
  return { context, page };
}

/** Frame metadata and render lint, run inside the page (07). */
function inspect() {
  const frames = [];
  const problems = [];
  const INTERACTIVE = "a,button,input,select,textarea,[role=button],[role=link]";
  const visible = (el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
  };
  const clippedByAncestor = (el, frame) => {
    for (let node = el.parentElement; node && node !== frame.parentElement; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflow;
      if (overflow !== "visible") return true;
    }
    return false;
  };
  const luminance = ([r, g, b]) => {
    const f = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const rgba = (value) => {
    const parts = value.match(/[\d.]+/g)?.map(Number) ?? [];
    return parts.length < 3 ? null : [parts[0], parts[1], parts[2], parts[3] ?? 1];
  };
  const background = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== "none") return null;
      const color = rgba(style.backgroundColor);
      if (color && color[3] === 1) return color;
      if (color && color[3] > 0) return null;
      if (node.tagName === "IMG" || node.tagName === "VIDEO") return null;
    }
    return [255, 255, 255, 1];
  };

  for (const frame of document.querySelectorAll("[data-frame]")) {
    const id = frame.dataset.frame;
    const box = frame.getBoundingClientRect();
    const heading = frame.querySelector("h1,h2,h3");
    frames.push({
      id,
      device: frame.dataset.device ?? frame.localName.replace(/^a-/, "").replace("phone", "iphone"),
      title: frame.dataset.title ?? heading?.textContent?.trim() ?? null,
      x: box.x + scrollX,
      y: box.y + scrollY,
      w: box.width,
      h: box.height,
      live: frame.hasAttribute("data-live"),
      html: frame.hasAttribute("data-live") ? frame.outerHTML : null,
    });

    const all = [...frame.querySelectorAll("*")].filter(visible);
    const controls = all.filter((el) => el.matches(INTERACTIVE));
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const [a, b] = [controls[i], controls[j]];
        if (a.contains(b) || b.contains(a)) continue;
        const [p, q] = [a.getBoundingClientRect(), b.getBoundingClientRect()];
        const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
        const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
        if (w > 1 && h > 1)
          problems.push({
            rule: "frames/overlap",
            severity: "error",
            message: `${id}: two controls overlap ("${a.textContent.trim().slice(0, 30)}", "${b.textContent.trim().slice(0, 30)}").`,
          });
      }
    }
    const direct = (el) => [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
    const texts = all.filter(direct);
    for (const el of texts) {
      const style = getComputedStyle(el);
      if (style.overflowX !== "visible" && el.scrollWidth > el.clientWidth + 1) {
        problems.push({
          rule: "frames/clipped",
          severity: "error",
          message: `${id}: "${el.textContent.trim().slice(0, 40)}" is cut off.`,
        });
      }
      const color = rgba(style.color);
      const back = background(el);
      if (color && back) {
        const [a, b] = [luminance(color), luminance(back)];
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const large = Number.parseFloat(style.fontSize) >= 24;
        if (ratio < (large ? 3 : 4.5)) {
          problems.push({
            rule: "contrast/text",
            severity: "warning",
            message: `${id}: "${el.textContent.trim().slice(0, 40)}" has contrast ${ratio.toFixed(1)}:1.`,
          });
        }
      }
    }
    const isPhone = frame.dataset.device === "iphone" || frame.localName === "a-phone";
    for (const el of [...texts, ...controls]) {
      const rect = el.getBoundingClientRect();
      if (isPhone && (rect.bottom > box.bottom - 34 + 0.5 || rect.top < box.top + 54 - 0.5)) {
        problems.push({
          rule: "frames/home-indicator",
          severity: "error",
          message: `${id}: "${el.textContent.trim().slice(0, 30)}" sits under the ${rect.bottom > box.bottom - 34 ? "home indicator" : "status bar"}.`,
        });
      }
    }
    for (const el of all) {
      if (clippedByAncestor(el, frame)) continue;
      const rect = el.getBoundingClientRect();
      if (
        rect.left < box.left - 1 ||
        rect.right > box.right + 1 ||
        rect.top < box.top - 1 ||
        rect.bottom > box.bottom + 1
      ) {
        problems.push({
          rule: "frames/offscreen",
          severity: "error",
          message: `${id}: <${el.localName}> runs outside the frame.`,
        });
      }
    }
  }
  return { frames, problems };
}

const rawHash = async (png) => sha256(await sharp(png).ensureAlpha().raw().toBuffer());

async function webp(buffer, out) {
  const data = await sharp(buffer).webp({ quality: 82, effort: 4 }).toBuffer();
  const hash = sha256(data);
  writeFileSync(join(out, `${hash}.webp`), data);
  return hash;
}

async function renderBoard(browser, board, problems) {
  const failures = new Set();
  const shots = {};
  let info;
  for (const scale of SCALES) {
    const { context, page } = await openBoard(browser, board, scale, failures);
    if (scale === 1) {
      info = await page.evaluate(inspect);
      problems.push(...info.problems);
    }
    for (const frame of info.frames) {
      const png = await page.locator(`[data-frame="${frame.id}"]`).screenshot({ animations: "disabled" });
      shots[frame.id] = { ...shots[frame.id], [scale]: png };
    }
    await context.close();
  }
  for (const url of failures) {
    problems.push({
      rule: "files/missing",
      severity: "error",
      file: board.src,
      message: `${board.src} failed to load ${url}. Everything must ship in the bundle.`,
    });
  }

  const frames = [];
  for (const frame of info.frames) {
    const png = shots[frame.id];
    const contentHash = await rawHash(png[1]);
    const thumb = await sharp(png[1]).resize({ width: 320, withoutEnlargement: true }).png().toBuffer();
    frames.push({
      ...frame,
      contentHash,
      renders: {
        "1x": await webp(png[1], job.out),
        "2x": await webp(png[2], job.out),
        "3x": await webp(png[3], job.out),
        thumb: await webp(thumb, job.out),
      },
    });
    writeFileSync(join(job.out, `${frame.id}.1x.png`), png[1]);
  }

  if (job.lint) {
    // Twice in fresh contexts: differing pixels are an error (05).
    const { context, page } = await openBoard(browser, board, 1, new Set());
    for (const frame of frames) {
      const again = await page.locator(`[data-frame="${frame.id}"]`).screenshot({ animations: "disabled" });
      if ((await rawHash(again)) !== frame.contentHash) {
        problems.push({
          rule: "frames/deterministic",
          severity: "error",
          message: `${frame.id} renders differently each time. Seed randomness, and don't draw Date.now().`,
        });
      }
    }
    await context.close();
    if (Object.keys(job.fixtures.shared ?? {}).length + Object.keys(job.fixtures.me ?? {}).length > 0) {
      const empty = await openBoard(browser, board, 1, new Set(), {});
      for (const frame of frames) {
        const png = await empty.page
          .locator(`[data-frame="${frame.id}"]`)
          .screenshot({ animations: "disabled" });
        frame.readsData = (await rawHash(png)) !== frame.contentHash;
      }
      await empty.context.close();
    }
  }
  return frames;
}

/** Mermaid in WebKit, with its styles moved onto attributes: articles may carry no <style> (05). */
async function renderMermaid(browser, sources) {
  if (sources.length === 0) return {};
  const require = createRequire(import.meta.url);
  const library = readFileSync(require.resolve("mermaid/dist/mermaid.min.js"), "utf8");
  const page = await browser.newPage();
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: library });
  const results = {};
  for (const source of sources) {
    results[source] = await page.evaluate(async (code) => {
      mermaid.initialize({
        startOnLoad: false,
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        securityLevel: "strict",
        fontFamily: "system-ui",
      });
      const id = `m${Math.random().toString(36).slice(2)}`;
      const { svg } = await mermaid.render(id, code);
      const holder = document.createElement("div");
      holder.innerHTML = svg;
      document.body.append(holder);
      const PROPS = [
        "fill",
        "stroke",
        "stroke-width",
        "stroke-dasharray",
        "font-size",
        "font-family",
        "font-weight",
        "opacity",
        "text-anchor",
      ];
      const elements = [...holder.querySelectorAll("svg *")];
      // Read everything first: Mermaid's rules select through ancestors' classes, which go below.
      for (const el of elements) {
        const style = getComputedStyle(el);
        for (const prop of PROPS) {
          const value = style.getPropertyValue(prop);
          if (value) el.setAttribute(prop, value);
        }
      }
      for (const el of elements) {
        el.removeAttribute("style");
        el.removeAttribute("class");
      }
      for (const style of holder.querySelectorAll("style")) style.remove();
      const svgEl = holder.querySelector("svg");
      svgEl.removeAttribute("style");
      const html = svgEl.outerHTML;
      holder.remove();
      return html;
    }, source);
  }
  await page.close();
  return results;
}

async function contactSheet(browser, frames) {
  if (frames.length === 0) return;
  const tiles = await Promise.all(
    frames.map(async (frame) => {
      const png = await sharp(join(job.out, `${frame.id}.1x.png`))
        .resize({ width: 240, withoutEnlargement: true })
        .png()
        .toBuffer();
      return `<figure><img src="data:image/png;base64,${png.toString("base64")}"><figcaption>${frame.id}</figcaption></figure>`;
    }),
  );
  const page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
  await page.setContent(
    `<!doctype html><style>body{margin:0;padding:24px;background:#1b1d22;color:#f2f3f5;font:13px system-ui;display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}figure{margin:0;width:240px}img{display:block;max-width:240px}figcaption{margin-top:6px}</style>${tiles.join("")}`,
  );
  await page.screenshot({ path: job.contactSheet, fullPage: true });
  await page.close();
}

/** 1200×630 from the first three frames, or the title in the kit's article type. */
async function ogImage(browser, frames) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  const images = await Promise.all(
    frames.slice(0, 3).map(async (frame) => {
      const png = await sharp(join(job.out, `${frame.id}.1x.png`))
        .resize({ height: 560, withoutEnlargement: true })
        .png()
        .toBuffer();
      return `<img src="data:image/png;base64,${png.toString("base64")}">`;
    }),
  );
  const body = images.length
    ? `<div style="display:flex;gap:28px;justify-content:center;align-items:center;height:630px">${images.join("")}</div>`
    : `<div style="display:flex;align-items:center;height:630px;padding:0 90px;color:#f2f3f5;font:700 72px/1.1 ui-serif,'New York',Georgia,serif">${job.title.replace(/</g, "&lt;")}</div>`;
  await page.setContent(`<!doctype html><style>body{margin:0;background:#1b1d22}</style>${body}`);
  const png = await page.screenshot();
  await page.close();
  return webp(png, job.out);
}

async function convertImages(images) {
  const converted = {};
  for (const path of images) {
    const data = await sharp(join(job.root, path))
      .rotate()
      .resize({ width: 2400, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    const hash = sha256(data);
    writeFileSync(join(job.out, `${hash}.webp`), data);
    converted[path] = hash;
  }
  return converted;
}

const browser = await webkit.launch();
try {
  const problems = [];
  const boards = [];
  for (const board of job.boards) {
    pagesByPath.set(board.shell, boardPage(board));
    boards.push({
      key: board.key,
      pageKey: board.pageKey,
      frames: await renderBoard(browser, board, problems),
    });
  }
  const all = boards.flatMap((board) => board.frames);
  const result = {
    boards,
    problems,
    mermaid: await renderMermaid(browser, job.mermaid),
    images: await convertImages(job.images),
    og: await ogImage(browser, all),
  };
  await contactSheet(browser, all);
  writeFileSync(join(job.out, "result.json"), JSON.stringify(result));
} finally {
  await browser.close();
  sandbox?.kill();
  server.stop(true);
}
