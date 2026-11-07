// Where things live in a working folder (07). The bundle's generated names are shared with the server (05).
import { dirname, extname } from "node:path";
import { boardShellName, livePageName } from "@artifacts/schema/bundle";

export {
  articleHtmlPath,
  BACKEND_BUNDLE,
  isGenerated,
  MANIFEST,
  OG_IMAGE,
  renderPath,
} from "@artifacts/schema/bundle";
/** A project's own lint rules. The CLI runs this file, so a pulled copy must never land in a folder. */
export const PROJECT_RULES = "lint.rules.js";

/** The CLI's own folder, in a repo and in each artifact. Git ignores it. */
export const LOCAL = ".artifacts";
export const WORK = `${LOCAL}/work`;
export const RENDER_DIR = `${LOCAL}/render`;
export const CONTACT_SHEET = `${LOCAL}/contact-sheet.png`;
export const BRAND_FONTS = `${LOCAL}/brand-fonts`;
export const DATA_DIR = `${LOCAL}/data`;
export const PACK_DIR = `${LOCAL}/pack`;

export const FIXTURES = "fixtures";
export const FIXTURE_DATA = `${FIXTURES}/data.json`;
export const FIXTURE_FILES = `${FIXTURES}/files`;
export const KIT_DIR = "vendor/artifacts-kit";

const besideBoard = (boardSrc: string, name: string) => {
  const dir = dirname(boardSrc);
  return `${dir === "." ? "" : `${dir}/`}${name}`;
};
export const boardShell = (boardSrc: string, board: string) => besideBoard(boardSrc, boardShellName(board));
export const livePage = (boardSrc: string, frame: string) => besideBoard(boardSrc, livePageName(frame));

/** `../` once for each folder in `dir`, so a generated page reaches the bundle's root. */
export const upTo = (dir: string) =>
  dir === "."
    ? ""
    : `${dir
        .split("/")
        .map(() => "..")
        .join("/")}/`;

export const TYPES: Record<string, string> = {
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

export const typeOf = (path: string) => TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
