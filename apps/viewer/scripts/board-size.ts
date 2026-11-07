import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * The board editor's size gate (14, "Viewer"): every JS and CSS file a cold board Edit fetches, beyond
 * what reading a canvas page already loaded, gzipped and summed. The reading entry (index) and the
 * canvas view chunk are the baseline; the editor's import closure is the cost, shared chunks (Yjs, the
 * sync provider) included. It also checks nothing the reader loads pulls the editor in before Edit.
 */
type Chunk = { file: string; imports?: string[]; css?: string[]; isEntry?: boolean };

const LIMIT = 160_000;
const READ_LIMIT = 80_000;
const dist = join(import.meta.dir, "..", "dist");
const manifest = JSON.parse(readFileSync(join(dist, ".vite", "manifest.json"), "utf8")) as Record<
  string,
  Chunk
>;
const gz = (file: string) => gzipSync(readFileSync(join(dist, file))).byteLength;

/** The files a chunk needs as it loads: itself, its static imports and their CSS, transitively. */
function closure(key: string, into = new Set<string>()) {
  const chunk = manifest[key];
  if (!chunk || into.has(chunk.file)) return into;
  into.add(chunk.file);
  for (const css of chunk.css ?? []) into.add(css);
  for (const next of chunk.imports ?? []) closure(next, into);
  return into;
}

const keyOf = (src: string) => {
  const key = Object.keys(manifest).find((k) => k.endsWith(src));
  if (!key) throw new Error(`no chunk for ${src}`);
  return key;
};
const entry = Object.keys(manifest).find((k) => manifest[k]?.isEntry) as string;
const reading = closure(entry);
const canvas = closure(keyOf("src/canvas/view.tsx"), new Set(reading));
const editor = closure(keyOf("src/boards/editor.tsx"));
const extra = [...editor].filter((file) => !canvas.has(file)).sort();
const total = extra.reduce((sum, file) => sum + gz(file), 0);
const index = manifest[entry] as Chunk;
const read = [index.file, ...(index.css ?? [])].reduce((sum, f) => sum + gz(f), 0);

const html = readFileSync(join(dist, "index.html"), "utf8");
const early = extra.filter((file) => canvas.has(file) || html.includes(file));

console.log(`initial route: ${(read / 1000).toFixed(2)} KB gzip (limit ${READ_LIMIT / 1000} KB)`);
console.log(
  `board editor, cold Edit beyond the canvas reader: ${(total / 1000).toFixed(2)} KB gzip (limit ${LIMIT / 1000} KB)`,
);
for (const file of extra) console.log(`  ${file}  ${(gz(file) / 1000).toFixed(2)} KB`);
let failed = false;
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
