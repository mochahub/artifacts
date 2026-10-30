export type CanvasCommand = "fit" | "actual" | "next" | "previous";

type KeyEventLike = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: unknown;
};

const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * What a key press does on the canvas. Nothing while typing, and nothing with a modifier held:
 * ⌘0 and Ctrl+0 reset the browser's zoom, ⌘1 switches tabs and ⌘N opens a window, and none of them
 * should also move the canvas.
 */
export function canvasCommand(event: KeyEventLike): CanvasCommand | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const target = event.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (target?.isContentEditable || (target?.tagName && TYPING.has(target.tagName))) return null;
  if (event.key === "0") return "fit";
  if (event.key === "1") return "actual";
  if (event.key === "n") return "next";
  if (event.key === "p") return "previous";
  return null;
}
