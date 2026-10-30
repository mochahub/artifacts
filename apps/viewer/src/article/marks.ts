import type { Thread } from "@artifacts/schema";

const CONTEXT = 32;
const collapse = (text: string) => text.replace(/\s+/g, " ");

/** Wraps a block's first occurrence of `exact` in a <mark>, across inline elements. */
function wrap(block: HTMLElement, exact: string, id: string) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    text += (node as Text).data;
  }
  const start = text.indexOf(exact);
  if (start < 0) return;
  const end = start + exact.length;
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
    if (anchor.type === "text") wrap(block, anchor.quote.exact, thread.id);
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

/** The selection as a text-quote anchor: exact words plus 32 characters each side (06). */
export function quoteFromSelection(root: HTMLElement) {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start = range.startContainer;
  const element = start instanceof Element ? start : start.parentElement;
  const block = element?.closest<HTMLElement>("[data-block]");
  if (!block || !root.contains(block) || !block.contains(range.endContainer)) return null;
  const exact = collapse(selection.toString()).trim();
  if (!exact) return null;

  const before = document.createRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.selectNodeContents(block);
  after.setStart(range.endContainer, range.endOffset);
  return {
    blockKey: block.dataset.block as string,
    quote: {
      exact,
      prefix: collapse(before.toString()).slice(-CONTEXT),
      suffix: collapse(after.toString()).slice(0, CONTEXT),
    },
    rect: range.getBoundingClientRect(),
  };
}
