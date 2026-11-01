import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BlockRecord, FrameRecord, Manifest, PageRecord } from "@artifacts/schema";
import { buildArticle, mermaidSources } from "../article/build.ts";
import { typeOf } from "../bundle/crawl.ts";
import type { Problem } from "../bundle/manifest.ts";
import { CliError, type Output } from "../output.ts";
import { asBun, ensureHelper } from "./install.ts";

const GAP = 80;

export type BundleFile = { path: string; hash: string; size: number; type: string; source: string };

export type RenderResult = {
  /** The bundled backend's hash, if there is one. */
  backendHash: string | null;
  files: Map<string, BundleFile>;
  /** Render blobs, by hash, not listed in the version's files. */
  renders: Map<string, string>;
  pages: PageRecord[];
  frames: FrameRecord[];
  blocks: BlockRecord[];
  problems: Problem[];
  contactSheet: string;
};

type HelperFrame = {
  id: string;
  device: string;
  title: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  live: boolean;
  html: string | null;
  contentHash: string;
  renders: FrameRecord["renders"];
  readsData?: boolean;
};
type HelperResult = {
  boards: { key: string; pageKey: string; frames: HelperFrame[] }[];
  problems: Problem[];
  mermaid: Record<string, string>;
  images: Record<string, string>;
  og: string;
};

const isWebp = (body: Uint8Array) =>
  body.length > 12 &&
  Buffer.from(body.subarray(0, 4)).toString() === "RIFF" &&
  Buffer.from(body.subarray(8, 12)).toString() === "WEBP";

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

function fixtures(root: string) {
  const path = join(root, "fixtures/data.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

const MAX_BACKEND = 1024 * 1024;

/** One ES module with no imports (05). */
function bundleBackend(root: string, src: string, outDir: string) {
  const path = join(outDir, "__backend.js");
  const build = asBun(
    // "./" so a src that starts with a dash is a file, not an option to bun build.
    ["build", `./${src}`, "--target=browser", "--format=esm", "--minify", `--outfile=${path}`],
    root,
  );
  if (!build.success) throw new CliError(`The backend didn't bundle:\n${build.stderr.toString()}`);
  return path;
}

/** What the sandbox would refuse anyway, found before publishing (07). */
export function backendProblems(source: string): Problem[] {
  const problems: Problem[] = [];
  if (Buffer.byteLength(source) > MAX_BACKEND) {
    problems.push({ rule: "backend/size", severity: "error", message: "The bundled backend is over 1 MB." });
  }
  const banned: [RegExp, string][] = [
    [/\bfetch\s*\(/, "fetch"],
    [/\bWebSocket\b/, "WebSocket"],
    [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
    [/\bset(Timeout|Interval)\s*\(/, "timers"],
    [/\bconnect\s*\(/, "connect()"],
    [/\bimport\s*\(/, "import()"],
    [/\brequire\s*\(/, "require()"],
    [/^\s*import\s/m, "imports that aren't bundled"],
    [/\bprocess\.(env|exit|argv)\b/, "process"],
  ];
  // The handler is itself called `fetch`: only calls count, not `fetch(request, env) {`.
  const calls = source.replace(/\bfetch\s*\([^()]*\)\s*\{/g, "");
  for (const [pattern, name] of banned) {
    if (pattern.test(calls)) {
      problems.push({
        rule: "backend/network",
        severity: "error",
        message: `The backend uses ${name}, which the sandbox doesn't have.`,
      });
    }
  }
  return problems;
}

function runHelper(root: string, job: Record<string, unknown>, out: Output): HelperResult {
  const dir = ensureHelper(out);
  const jobPath = join(job.out as string, "job.json");
  writeFileSync(jobPath, JSON.stringify(job));
  const result = asBun([join(dir, "render.mjs"), jobPath], root);
  if (!result.success) throw new CliError(`Rendering failed:\n${result.stderr.toString()}`);
  return JSON.parse(readFileSync(join(job.out as string, "result.json"), "utf8"));
}

/** Renders everything (05): frames, articles, images, the contact sheet and the OG image. */
export function render(
  root: string,
  manifest: Manifest,
  bundle: Map<string, string>,
  options: { lint: boolean },
  out: Output,
): RenderResult {
  const outDir = join(root, ".artifacts/render");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const contactSheet = join(root, ".artifacts/contact-sheet.png");

  const boards = manifest.pages.flatMap((page) =>
    page.kind === "canvas"
      ? page.boards.map((board) => ({
          key: board.id,
          pageKey: page.id,
          src: board.src,
          shell: `${dirname(board.src) === "." ? "" : `${dirname(board.src)}/`}__board-${board.id}.html`,
          styles: page.styles,
          scripts: page.scripts,
        }))
      : [],
  );
  const mermaid = manifest.pages.flatMap((page) =>
    page.kind === "article" ? mermaidSources(readFileSync(join(root, page.src), "utf8")) : [],
  );
  const heavy = [...bundle.entries()]
    .filter(([path, absolute]) => /\.(png|jpe?g)$/i.test(path) && Bun.file(absolute).size > 500 * 1024)
    .map(([path]) => path);

  const backendPath = manifest.backend ? bundleBackend(root, manifest.backend.src, outDir) : null;

  const helper = runHelper(
    root,
    {
      root,
      backend: backendPath,
      boards,
      mermaid,
      images: heavy,
      out: outDir,
      lint: options.lint,
      fixtures: fixtures(root),
      contactSheet,
      title: manifest.title,
    },
    out,
  );

  const problems: Problem[] = [...helper.problems];
  const files = new Map<string, BundleFile>();
  for (const [path, absolute] of bundle) {
    const converted = helper.images[path];
    const source = converted ? join(outDir, `${converted}.webp`) : absolute;
    const body = readFileSync(source);
    files.set(path, {
      path,
      hash: converted ?? sha256(body),
      size: body.length,
      // A converted image keeps its path, so a pulled one is still WebP under its old name.
      type: converted || isWebp(body) ? "image/webp" : typeOf(path),
      source,
    });
  }
  const addGenerated = (path: string, body: string | Uint8Array, type: string) => {
    const source = join(outDir, sha256(body));
    writeFileSync(source, body);
    files.set(path, { path, hash: sha256(body), size: Buffer.byteLength(body), type, source });
  };

  // Stored with each version, so `artifacts pull` can give back what was published (05).
  addGenerated("artifact.json", readFileSync(join(root, "artifact.json")), "application/json");

  let backendHash: string | null = null;
  if (backendPath) {
    const body = readFileSync(backendPath);
    backendHash = sha256(body);
    files.set("__backend.js", {
      path: "__backend.js",
      hash: backendHash,
      size: body.length,
      type: "text/javascript",
      source: backendPath,
    });
    problems.push(...backendProblems(body.toString()));
  }

  const renders = new Map<string, string>();
  const frames: FrameRecord[] = [];
  const frameHashes = new Map<string, string>();
  const boardRecords = new Map<string, NonNullable<PageRecord["meta"]["boards"]>>();
  const offsets = new Map<string, number>();

  for (const board of helper.boards) {
    const definition = boards.find((b) => b.key === board.key && b.pageKey === board.pageKey);
    if (!definition) continue;
    const left = Math.min(...board.frames.map((f) => f.x));
    const top = Math.min(...board.frames.map((f) => f.y));
    const right = Math.max(...board.frames.map((f) => f.x + f.w));
    const bottom = Math.max(...board.frames.map((f) => f.y + f.h));
    const origin = offsets.get(board.pageKey) ?? 0;
    offsets.set(board.pageKey, origin + (right - left) + GAP);
    const manifestPage = manifest.pages.find((page) => page.id === board.pageKey);
    const manifestBoard =
      manifestPage?.kind === "canvas" ? manifestPage.boards.find((b) => b.id === board.key) : undefined;
    const list = boardRecords.get(board.pageKey) ?? [];
    list.push({
      key: board.key,
      title: manifestBoard?.title ?? board.key,
      subtitle: manifestBoard?.subtitle,
      x: origin,
      y: 0,
      w: right - left,
      h: bottom - top,
    });
    boardRecords.set(board.pageKey, list);

    for (const frame of board.frames) {
      for (const hash of Object.values(frame.renders)) renders.set(hash, join(outDir, `${hash}.webp`));
      frameHashes.set(`${board.pageKey}/${board.key}/${frame.id}`, frame.renders["2x"]);
      let livePath: string | null = null;
      if (frame.live && frame.html) {
        const dir = dirname(definition.src);
        const up =
          dir === "."
            ? ""
            : `${dir
                .split("/")
                .map(() => "..")
                .join("/")}/`;
        livePath = `${dir === "." ? "" : `${dir}/`}__live-${frame.id}.html`;
        addGenerated(
          livePath,
          `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${definition.styles.map((path) => `<link rel="stylesheet" href="${up}${path}">`).join("\n")}
${definition.scripts.map((path) => `<script src="${up}${path}"></script>`).join("\n")}
<style>html,body{margin:0}</style></head><body>${frame.html}</body></html>`,
          "text/html",
        );
      }
      frames.push({
        pageKey: board.pageKey,
        boardKey: board.key,
        frameKey: frame.id,
        title: frame.title,
        device: frame.device,
        x: origin + frame.x - left,
        y: frame.y - top,
        w: frame.w,
        h: frame.h,
        contentHash: frame.contentHash,
        renders: frame.renders,
        livePath,
      });
    }
  }

  const blocks: BlockRecord[] = [];
  const pages: PageRecord[] = [];
  manifest.pages.forEach((page, position) => {
    const title = "title" in page ? (page.title ?? null) : null;
    const group = "group" in page ? (page.group ?? null) : null;
    if (page.kind === "article") {
      const built = buildArticle({
        path: page.src,
        source: readFileSync(join(root, page.src), "utf8"),
        root,
        blobHash: (path) => files.get(path)?.hash,
        frameHash: (ref) => frameHashes.get(ref),
        mermaid: new Map(Object.entries(helper.mermaid)),
      });
      problems.push(...built.problems);
      const htmlPath = `__articles/${page.id}.html`;
      addGenerated(htmlPath, built.html, "text/html; charset=utf-8");
      blocks.push(...built.blocks.map((block) => ({ ...block, pageKey: page.id })));
      pages.push({
        key: page.id,
        kind: "article",
        title: title ?? built.outline[0]?.title ?? page.id,
        group,
        position,
        meta: {
          htmlHash: files.get(htmlPath)?.hash,
          outline: built.outline,
          readingMinutes: built.readingMinutes,
        },
      });
    } else if (page.kind === "canvas") {
      pages.push({
        key: page.id,
        kind: "canvas",
        title: title ?? page.id,
        group,
        position,
        meta: { boards: boardRecords.get(page.id) ?? [] },
      });
    } else if (page.kind === "prototype") {
      pages.push({
        key: page.id,
        kind: "prototype",
        title: title ?? page.id,
        group: null,
        position,
        meta: { device: page.device, livePath: page.src },
      });
    } else {
      pages.push({
        key: page.id,
        kind: "gallery",
        title: page.title ?? page.id,
        group: null,
        position,
        meta: {
          items: page.items.map((item) => ({
            hash: files.get(item.src)?.hash as string,
            type: files.get(item.src)?.type,
            caption: item.caption,
          })),
        },
      });
    }
  });

  const og = helper.og;
  const ogBody = readFileSync(join(outDir, `${og}.webp`));
  files.set("__og.webp", {
    path: "__og.webp",
    hash: og,
    size: ogBody.length,
    type: "image/webp",
    source: join(outDir, `${og}.webp`),
  });

  return { files, renders, pages, frames, blocks, problems, contactSheet, backendHash };
}
