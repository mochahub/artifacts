import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "@artifacts/schema";
import { Parser } from "htmlparser2";
import { backendSources, crawl, typeOf } from "../bundle/crawl.ts";

const MB = 1024 * 1024;

/** Every data-frame in a board's HTML, in order. */
export function frameIds(html: string): string[] {
  const ids: string[] = [];
  const parser = new Parser({
    onopentag(_name, attrs) {
      if (attrs["data-frame"] !== undefined) ids.push(attrs["data-frame"]);
    },
  });
  parser.write(html);
  parser.end();
  return ids;
}

/** Rules that need no browser (07). */
export async function staticLint(root: string, manifest: Manifest) {
  const { files, problems } = await crawl(root, manifest);

  const seen = new Map<string, string>();
  for (const page of manifest.pages) {
    if (page.kind !== "canvas") continue;
    for (const board of page.boards) {
      const absolute = files.get(board.src);
      if (!absolute) continue;
      const ids = frameIds(readFileSync(absolute, "utf8"));
      if (ids.length === 0) {
        problems.push({
          rule: "frames/ids",
          severity: "error",
          file: board.src,
          message: `${board.src} has no data-frame elements.`,
        });
      }
      for (const id of ids) {
        if (!/^[a-z0-9-]+$/.test(id)) {
          problems.push({
            rule: "frames/ids",
            severity: "error",
            file: board.src,
            message: `Frame id "${id}" must use only a-z, 0-9 and -.`,
          });
        }
        const key = `${page.id}/${id}`;
        if (seen.has(key)) {
          problems.push({
            rule: "frames/ids",
            severity: "error",
            file: board.src,
            message: `Frame id "${id}" is used twice in page ${page.id}.`,
          });
        }
        seen.set(key, board.src);
      }
    }
  }

  // data/api: state belongs in the kit's store, where reviewers' copies stay apart (07).
  const backend = new Set(manifest.backend ? backendSources(root, manifest.backend.src) : []);
  const usesKitData = [...files.keys()].some((path) => path.endsWith("artifacts-kit/data.js"));
  for (const [path, absolute] of files) {
    if (!/\.(html?|m?js)$/i.test(path) || path.includes("artifacts-kit/") || backend.has(path)) continue;
    const source = readFileSync(absolute, "utf8");
    const banned = /\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/.exec(source)?.[1];
    if (banned) {
      problems.push({
        rule: "data/api",
        severity: "error",
        file: path,
        message: `${path} uses ${banned}. Use the kit's data API.`,
      });
    }
    const external = /\bfetch\(\s*["'`](https?:|\/\/|\/)[^"'`]*/.exec(source);
    if (external) {
      problems.push({
        rule: "data/api",
        severity: "error",
        file: path,
        message: `${path} calls ${external[0].slice(6)}. Only relative api/ paths work.`,
      });
    }
  }
  if (usesKitData && !existsSync(join(root, "fixtures/data.json"))) {
    problems.push({
      rule: "data/fixtures",
      severity: "error",
      message:
        "This artifact reads saved data, so add fixtures/data.json. Renders must not depend on what reviewers clicked.",
    });
  }

  let total = 0;
  for (const [path, absolute] of files) {
    const size = statSync(absolute).size;
    total += size;
    if (typeOf(path).startsWith("image/") && size > 500 * 1024) {
      problems.push({
        rule: "weight/image",
        severity: "warning",
        file: path,
        message: `${path} is ${(size / MB).toFixed(1)} MB. Render converts it, but start smaller if you can.`,
      });
    }
  }
  if (total > 50 * MB) {
    problems.push({
      rule: "weight/bundle",
      severity: "warning",
      message: `The bundle is ${(total / MB).toFixed(0)} MB, over 50 MB.`,
    });
  }
  return { files, problems };
}
