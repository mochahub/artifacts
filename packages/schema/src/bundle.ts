/**
 * The names a bundle's own files and its generated outputs go by (05). The CLI writes them, and the
 * server and `artifacts pull` read them, so they live here. No zod, so anything can import it.
 */

export const MANIFEST = "artifact.json";
export const OG_IMAGE = "__og.webp";
export const BACKEND_BUNDLE = "__backend.js";
export const articleHtmlPath = (pageId: string) => `__articles/${pageId}.html`;
export const renderPath = (hash: string) => `__renders/${hash}.webp`;
/** A board's generated page goes beside the board's own file, so its relative links still work. */
export const boardShellName = (board: string) => `__board-${board}.html`;
export const livePageName = (frame: string) => `__live-${frame}.html`;

/**
 * One of the outputs above, which `render` makes again: `artifacts pull` leaves them out (07), and a
 * rebuilt manifest doesn't take them for sources. Only these names, so an author's `__drafts/` comes back.
 */
export const isGenerated = (path: string) =>
  path === OG_IMAGE ||
  path === BACKEND_BUNDLE ||
  /^__(articles|renders)\/[^/]+$/.test(path) ||
  /(^|\/)__(board|live)-[^/]+\.html$/.test(path);
