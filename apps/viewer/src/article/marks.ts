import type { Thread } from "@artifacts/schema";
import { GONE } from "./diff.ts";
import { findQuote, type Quote } from "./quote.ts";

const CONTEXT = 32;
const collapse = (text: string) => text.replace(/\s+/g, " ");

/** Wraps the quoted passage in a <mark>, across inline elements. */
function wrap(block: HTMLElement, quote: Quote, id: string) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // The margin tabs and the removed words aren't the author's words.
    if ((node as Text).parentElement?.closest(`.mm, ${GONE}`)) continue;
    nodes.push(node as Text);
    text += (node as Text).data;
  }
  const found = findQuote(text, quote);
  if (!found) return;
  const [start, end] = found;
  let offset = 0;
  for (const node of nodes) {
    const from = Math.max(start - offset, 0);
    const to = Math.min(end - offset, node.length);
    offset += node.length;
    if (from >= to) continue;
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    const mark = document.createElement("mark");
    mark.className = "hl";
    mark.dataset.thread = id;
    range.surroundContents(mark);
  }
}

/** Highlights quoted passages and adds the numbered margin tabs (06). Safe to run again. */
export function decorate(root: HTMLElement, threads: Thread[], open: (id: string) => void) {
  for (const mark of root.querySelectorAll("mark.hl")) mark.replaceWith(...mark.childNodes);
  root.normalize();
  for (const tab of root.querySelectorAll(".mm")) tab.remove();

  for (const thread of threads) {
    const anchor = thread.anchor;
    if (
      !anchor ||
      anchor.type === "frame" ||
      thread.status === "resolved" ||
      thread.anchorState === "orphaned"
    )
      continue;
    const block = root.querySelector<HTMLElement>(`[data-block="${CSS.escape(anchor.blockKey)}"]`);
    if (!block) continue;
    if (anchor.type === "text") wrap(block, anchor.quote, thread.id);
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "mm";
    tab.textContent = String(thread.n);
    tab.setAttribute("aria-label", `Comment ${thread.n}`);
    tab.addEventListener("click", (event) => {
      event.stopPropagation();
      open(thread.id);
    });
    block.append(tab);
  }
}

/** The range's words, minus the margin tabs and removed words: a paragraph's selection runs over its tab. */
function words(range: Range) {
  const part = range.cloneContents();
  for (const tab of part.querySelectorAll(`.mm, ${GONE}`)) tab.remove();
  return collapse(part.textContent ?? "");
}

/**
 * The selection as a text-quote anchor: exact words plus 32 characters each side (06).
 *
 * An anchor sits in one block, so this quotes the first block with words selected. A triple-click or a
 * drag past a paragraph's end finishes at the start of the next block, and a drag can start at the end
 * of the block before.
 */
export function quoteFromSelection(root: HTMLElement) {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  for (const block of root.querySelectorAll<HTMLElement>("[data-block]")) {
    if (!range.intersectsNode(block)) continue;
    const part = range.cloneRange();
    if (!block.contains(part.startContainer)) part.setStart(block, 0);
    if (!block.contains(part.endContainer)) part.setEnd(block, block.childNodes.length);
    const exact = words(part).trim();
    if (!exact) continue;

    const before = document.createRange();
    before.selectNodeContents(block);
    before.setEnd(part.startContainer, part.startOffset);
    const after = document.createRange();
    after.selectNodeContents(block);
    after.setStart(part.endContainer, part.endOffset);
    return {
      blockKey: block.dataset.block as string,
      quote: {
        exact,
        prefix: words(before).slice(-CONTEXT),
        suffix: words(after).slice(0, CONTEXT),
      },
      rect: part.getBoundingClientRect(),
    };
  }
  return null;
}
