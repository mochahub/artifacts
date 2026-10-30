import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { VIEWER } from "./viewer.gen.ts";

type Assets = Map<string, { body: Uint8Array; type: string }>;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript",
  css: "text/css",
  svg: "image/svg+xml",
};
const typeOf = (path: string) => TYPES[path.split(".").at(-1) ?? ""] ?? "application/octet-stream";

/** The real viewer: a table built into the binary, or apps/viewer/dist when running from source. */
export async function viewerAssets(): Promise<Assets> {
  const assets: Assets = new Map();
  for (const [path, base64] of Object.entries(VIEWER)) {
    assets.set(path, { body: Buffer.from(base64, "base64"), type: typeOf(path) });
  }
  if (assets.size > 0) return assets;
  const dist = join(import.meta.dir, "../../../../apps/viewer/dist");
  if (!existsSync(dist)) return assets;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else assets.set(`/${relative(dist, path)}`, { body: readFileSync(path), type: typeOf(path) });
    }
  };
  walk(dist);
  return assets;
}
