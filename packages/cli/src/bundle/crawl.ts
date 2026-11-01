import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import type { Manifest } from "@artifacts/schema";
import { cleanUrl } from "@artifacts/schema/article";
import { init, parse as parseModule } from "es-module-lexer";
import { Parser } from "htmlparser2";
import postcss from "postcss";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type { Problem } from "./manifest.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".vtt": "text/vtt",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
};

export { cleanUrl };
export const typeOf = (path: string) => TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

export type Crawled = { files: Map<string, string>; problems: Problem[] };

const URL_ATTRS: Record<string, string[]> = {
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  script: ["src"],
  link: ["href"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  iframe: ["src"],
  image: ["href"],
  use: ["href"],
};

/** What a reference is: nothing to follow, a problem, or a path in the bundle. */
function classify(reference: string): "skip" | "absolute" | "relative" {
  const url = reference.trim();
  if (!url || url.startsWith("#") || /^(data|blob|about|mailto|tel|javascript):/i.test(url)) return "skip";
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//") || url.startsWith("/")) return "absolute";
  return "relative";
}

export function htmlRefs(html: string) {
  const refs: string[] = [];
  let inStyle = false;
  const css: string[] = [];
  const scripts: string[] = [];
  let scriptDepth = 0;
  let inlineModule = "";
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        for (const attr of URL_ATTRS[name] ?? []) {
          const value = attrs[attr];
          if (!value) continue;
          if (attr === "srcset")
            refs.push(...value.split(",").map((part) => part.trim().split(/\s+/)[0] ?? ""));
          else refs.push(value);
        }
        if (attrs.style) css.push(`x{${attrs.style}}`);
        if (name === "style") inStyle = true;
        if (name === "script" && !attrs.src) {
          scriptDepth += 1;
          inlineModule = "";
        }
      },
      ontext(text) {
        if (inStyle) css.push(text);
        if (scriptDepth > 0) inlineModule += text;
      },
      onclosetag(name) {
        if (name === "style") inStyle = false;
        if (name === "script" && scriptDepth > 0) {
          scriptDepth -= 1;
          scripts.push(inlineModule);
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(html);
  parser.end();
  return { refs, css, scripts };
}

export function cssRefs(css: string): string[] {
  const refs: string[] = [];
  let root: postcss.Root;
  try {
    root = postcss.parse(css);
  } catch {
    return refs;
  }
  const take = (value: string) => {
    for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) refs.push(match[2] as string);
  };
  root.walkAtRules("import", (rule) => {
    const quoted = /^(['"])(.*?)\1/.exec(rule.params.trim());
    if (quoted) refs.push(quoted[2] as string);
    else take(rule.params);
  });
  root.walkDecls((decl) => take(decl.value));
  return refs;
}

export function jsRefs(js: string): string[] {
  const refs: string[] = [];
  try {
    const [imports] = parseModule(js);
    for (const entry of imports) {
      // A template literal comes back as a glob, which names no one file.
      if ("glob" in entry && entry.glob) continue;
      if (entry.specifier) refs.push(entry.specifier);
    }
  } catch {}
  for (const match of js.matchAll(/\bfetch\(\s*(['"`])([^'"`$]+)\1/g)) {
    // `api/…` is the artifact's backend, not a file in the bundle (05).
    if (!/^(\.\/)?api\//.test(match[2] as string)) refs.push(match[2] as string);
  }
  return refs;
}

export function markdownRefs(markdown: string): string[] {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkDirective).parse(markdown);
  const refs: string[] = [];
  visit(tree, "image", (node) => {
    refs.push(node.url);
  });
  visit(tree, (node) => {
    const directive = node as { type: string; name?: string; attributes?: Record<string, string> };
    if (directive.type.endsWith("Directive") && directive.name === "chart" && directive.attributes?.src) {
      refs.push(directive.attributes.src);
    }
  });
  return refs;
}

const BACKEND_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.js"];

/**
 * A backend's own source, relative imports included. The minified module is what runs, but with no copy
 * in git this is the only one left, and `artifacts pull` has to be able to give it back.
 */
export function backendSources(root: string, src: string) {
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  const found = new Set<string>();
  const queue = [src];
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (found.has(path) || !existsSync(join(root, path))) continue;
    found.add(path);
    let imports: { path: string }[] = [];
    try {
      imports = transpiler.scanImports(readFileSync(join(root, path), "utf8"));
    } catch {}
    for (const entry of imports) {
      if (!entry.path.startsWith(".")) continue;
      const base = normalize(join(dirname(path), entry.path))
        .split(sep)
        .join("/");
      if (base.startsWith("../")) continue;
      const hit = BACKEND_EXTENSIONS.map((extension) => `${base}${extension}`).find(
        (candidate) => existsSync(join(root, candidate)) && statSync(join(root, candidate)).isFile(),
      );
      if (hit) queue.push(hit);
    }
  }
  return [...found];
}

/** Every file the manifest reaches, and what's wrong with the references on the way (05). */
export async function crawl(root: string, manifest: Manifest): Promise<Crawled> {
  await init;
  const realRoot = realpathSync(root) + sep;
  const files = new Map<string, string>();
  const problems: Problem[] = [];
  const queue: { path: string; from: string }[] = [];

  const add = (reference: string, from: string, relativeTo: string) => {
    const kind = classify(reference);
    if (kind === "skip") return;
    if (kind === "absolute") {
      problems.push({
        rule: "files/absolute",
        severity: "error",
        file: from,
        message: `${from} refers to ${reference}. Ship it in the bundle and use a relative path.`,
      });
      return;
    }
    const path = normalize(join(relativeTo, cleanUrl(reference)))
      .split(sep)
      .join("/");
    if (path.startsWith("../") || path === "..") {
      problems.push({
        rule: "files/outside",
        severity: "error",
        file: from,
        message: `${from} refers to ${reference}, outside the folder artifact.json is in.`,
      });
      return;
    }
    queue.push({ path, from });
  };

  for (const page of manifest.pages) {
    if (page.kind === "article" || page.kind === "prototype") add(page.src, "artifact.json", "");
    if (page.kind === "canvas") {
      for (const board of page.boards) add(board.src, "artifact.json", "");
      for (const path of [...page.styles, ...page.scripts]) add(path, "artifact.json", "");
    }
    if (page.kind === "gallery") for (const item of page.items) add(item.src, "artifact.json", "");
  }
  if (existsSync(join(root, "fixtures/data.json")))
    queue.push({ path: "fixtures/data.json", from: "fixtures" });
  // Renders read these, so a pulled working folder needs them to come out the same.
  if (existsSync(join(root, "fixtures/files"))) {
    for (const entry of readdirSync(join(root, "fixtures/files"), { recursive: true, encoding: "utf8" })) {
      const path = `fixtures/files/${entry.split(sep).join("/")}`;
      if (statSync(join(root, path)).isFile()) queue.push({ path, from: "fixtures" });
    }
  }

  while (queue.length > 0) {
    const { path, from } = queue.shift() as { path: string; from: string };
    if (files.has(path)) continue;
    const absolute = join(root, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      problems.push({
        rule: "files/missing",
        severity: "error",
        file: from,
        message: `${from} refers to ${path}, which doesn't exist.`,
      });
      continue;
    }
    // A symlink in a cloned repo could point at ~/.ssh or .env, and publishing would upload what it reaches.
    const real = realpathSync(absolute);
    if (!real.startsWith(realRoot)) {
      problems.push({
        rule: "files/outside",
        severity: "error",
        file: from,
        message: `${path} is a link to a file outside the folder artifact.json is in. Copy the file in instead.`,
      });
      continue;
    }
    files.set(path, absolute);
    const dir = dirname(path);
    const extension = extname(path).toLowerCase();
    if (extension === ".html" || extension === ".htm") {
      const { refs, css, scripts } = htmlRefs(readFileSync(absolute, "utf8"));
      for (const ref of refs) add(ref, path, dir);
      for (const block of css) for (const ref of cssRefs(block)) add(ref, path, dir);
      for (const block of scripts)
        for (const ref of jsRefs(block)) if (ref.startsWith(".")) add(ref, path, dir);
    } else if (extension === ".css") {
      for (const ref of cssRefs(readFileSync(absolute, "utf8"))) add(ref, path, dir);
    } else if (extension === ".js" || extension === ".mjs") {
      for (const ref of jsRefs(readFileSync(absolute, "utf8")))
        if (classify(ref) !== "skip") add(ref, path, dir);
    } else if (extension === ".md") {
      for (const ref of markdownRefs(readFileSync(absolute, "utf8"))) add(ref, path, dir);
    }
  }
  // Not crawled: backend imports follow bundler rules, and its own lint rules look at the bundled module.
  if (manifest.backend) {
    for (const path of backendSources(root, manifest.backend.src)) {
      if (realpathSync(join(root, path)).startsWith(realRoot)) files.set(path, join(root, path));
    }
  }
  return { files, problems };
}

export const relativeTo = (root: string, path: string) => relative(root, path).split(sep).join("/");
