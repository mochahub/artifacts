import { isBundlePath } from "@artifacts/schema";

type Page = { pageKey: string; kind: string; title: string | null; group: string | null; meta: unknown };
type Files = Record<string, { hash: string }>;

const generated = (path: string) => (path.split("/").pop() ?? "").startsWith("__") || path.startsWith("__");
const stem = (path: string) => (path.split("/").pop() ?? "").replace(/\.[^.]+$/, "");

/**
 * A manifest for a version published before artifact.json was stored. Pages keep neither an article's
 * source path nor a board's files, so paths are matched by name, then in order. `artifacts pull` says
 * it was rebuilt, because this is the best guess those versions allow.
 */
export function rebuildManifest(
  artifact: { project: string; slug: string; title: string; visibility: string; summary: string },
  files: Files,
  pages: Page[],
) {
  const sources = Object.keys(files).filter((path) => isBundlePath(path) && !generated(path));
  const left = new Set(sources);
  const take = (extension: RegExp, key: string) => {
    const candidates = [...left].filter((path) => extension.test(path));
    const pick = candidates.find((path) => stem(path) === key) ?? candidates[0];
    if (pick) left.delete(pick);
    return pick ?? `${key}.missing`;
  };
  const rebuilt = pages.map((page) => {
    const meta = page.meta as {
      boards?: { key: string; title: string; subtitle?: string }[];
      device?: string;
      livePath?: string;
      items?: { hash: string; caption?: string }[];
    };
    const base = { id: page.pageKey, ...(page.title ? { title: page.title } : {}) };
    if (page.kind === "article") {
      return {
        ...base,
        kind: "article",
        src: take(/\.md$/i, page.pageKey),
        ...(page.group ? { group: page.group } : {}),
      };
    }
    if (page.kind === "canvas") {
      const boards = (meta.boards ?? []).map((board) => ({
        id: board.key,
        title: board.title,
        ...(board.subtitle ? { subtitle: board.subtitle } : {}),
        src: take(/\.html?$/i, board.key),
      }));
      return {
        ...base,
        kind: "canvas",
        boards,
        styles: sources.filter((path) => /\.css$/i.test(path)),
        scripts: sources.filter((path) => /\.m?js$/i.test(path) && !/\/(data|backend)\.js$/.test(path)),
        ...(page.group ? { group: page.group } : {}),
      };
    }
    if (page.kind === "gallery") {
      const pathOf = (hash: string) => Object.entries(files).find(([, file]) => file.hash === hash)?.[0];
      return {
        ...base,
        kind: "gallery",
        items: (meta.items ?? []).map((item) => ({
          src: pathOf(item.hash) ?? "missing",
          ...(item.caption ? { caption: item.caption } : {}),
        })),
      };
    }
    return {
      ...base,
      kind: "prototype",
      src: meta.livePath ?? "index.html",
      device: meta.device ?? "iphone",
    };
  });
  return {
    project: artifact.project,
    slug: artifact.slug,
    title: artifact.title,
    summary: artifact.summary,
    visibility: artifact.visibility,
    pages: rebuilt,
  };
}
