import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { closure, coldLoad, type Manifest } from "./load-graph.ts";

/**
 * The viewer's dependency-graph size gates. The board gate (14, "Viewer") counts every JS and CSS
 * file a cold board Edit fetches, beyond
 * what reading a canvas page already loaded, gzipped and summed. The reading entry (index) and the
 * canvas view chunk are the baseline; the editor's import closure is the cost, shared chunks (Yjs, the
 * sync provider) included. It also checks nothing the reader loads pulls the editor in before Edit.
 */
const LIMIT = 160_000;
const READ_LIMIT = 80_000;
const dist = join(import.meta.dir, "..", "dist");
const manifest = JSON.parse(readFileSync(join(dist, ".vite", "manifest.json"), "utf8")) as Manifest;
const gz = (file: string) => gzipSync(readFileSync(join(dist, file))).byteLength;

const keyOf = (src: string) => {
  const key = Object.keys(manifest).find((k) => k.endsWith(src));
  if (!key) throw new Error(`no chunk for ${src}`);
  return key;
};
const entry = Object.keys(manifest).find((k) => manifest[k]?.isEntry) as string;
const reading = closure(manifest, entry);
const canvas = closure(manifest, keyOf("src/canvas/view.tsx"), new Set(reading));
const editor = closure(manifest, keyOf("src/boards/editor.tsx"));
const extra = [...editor].filter((file) => !canvas.has(file)).sort();
const total = extra.reduce((sum, file) => sum + gz(file), 0);
const read = [...reading].reduce((sum, f) => sum + gz(f), 0);
const articleFiles = coldLoad(manifest, keyOf("src/editing/editor.tsx"), keyOf("src/article/view.tsx"));
const article = articleFiles.reduce((sum, file) => sum + gz(file), 0);

const html = readFileSync(join(dist, "index.html"), "utf8");
const entries: [string, Set<string>][] = [
  [keyOf("src/boards/editor.tsx"), canvas],
  [keyOf("src/editing/editor.tsx"), closure(manifest, keyOf("src/article/view.tsx"))],
];
const early = entries.flatMap(([key, baseline]) => {
  const file = manifest[key]?.file;
  return file && (baseline.has(file) || html.includes(file)) ? [file] : [];
});

console.log(`initial route: ${(read / 1000).toFixed(2)} KB gzip (limit ${READ_LIMIT / 1000} KB)`);
console.log(
  `board editor, cold Edit beyond the canvas reader: ${(total / 1000).toFixed(2)} KB gzip (limit ${LIMIT / 1000} KB)`,
);
for (const file of extra) console.log(`  ${file}  ${(gz(file) / 1000).toFixed(2)} KB`);
console.log(
  `article editor, cold Edit beyond the article reader: ${(article / 1000).toFixed(2)} KB gzip (limit 120 KB)`,
);
let failed = false;
if (article > 120_000) {
  console.error(`the article editor is over budget by ${article - 120_000} bytes`);
  failed = true;
}
if (total > LIMIT) {
  console.error(`the board editor is over budget by ${total - LIMIT} bytes`);
  failed = true;
}
if (read > READ_LIMIT) {
  console.error(`the initial route is over budget by ${read - READ_LIMIT} bytes`);
  failed = true;
}
if (early.length) {
  console.error(`the editor loads before Edit: ${early.join(", ")}`);
  failed = true;
}
if (failed) process.exit(1);
