import { Fragment, type Node, Slice } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { ySyncPluginKey } from "y-prosemirror";
import type { ProseMirrorJSON } from "./schema.ts";

/** One character of a block's drawn text, and who wrote it. Separators between blocks have no author. */
type Char = { c: string; a: string | null; t: number };

const CONTAINERS_WITH_GAPS = new Set([
  "blockquote",
  "bullet_list",
  "ordered_list",
  "list_item",
  "component",
  "table",
  "table_row",
  "table_header",
  "table_cell",
]);

const authorOf = (node: ProseMirrorJSON) => {
  const mark = node.marks?.find((m) => m.type === "author");
  return mark ? { a: String(mark.attrs?.a ?? ""), t: Number(mark.attrs?.t ?? 0) } : null;
};

function walk(node: ProseMirrorJSON, out: Char[]) {
  if (node.type === "text") {
    const who = authorOf(node);
    for (const c of node.text ?? "") out.push({ c, a: who?.a ?? null, t: who?.t ?? 0 });
    return;
  }
  if (node.type === "hard_break") {
    out.push({ c: " ", a: null, t: 0 });
    return;
  }
  const gap = CONTAINERS_WITH_GAPS.has(node.type);
  for (const child of node.content ?? []) {
    if (gap) out.push({ c: " ", a: null, t: 0 });
    walk(child, out);
  }
}

/**
 * A block's text as the read pipeline normalizes it (`blocks.text`: whitespace collapsed, trimmed),
 * with each character's author. Containers put a space between their children, as the HTML's newlines
 * do, so the text matches `blocks.text` for the blocks a person can edit.
 */
export function normalizedChars(node: ProseMirrorJSON): Char[] {
  const raw: Char[] = [];
  walk(node, raw);
  const out: Char[] = [];
  for (const char of raw) {
    if (/\s/.test(char.c)) {
      if (out.length === 0 || out[out.length - 1]?.c === " ") continue;
      out.push({ c: " ", a: char.a, t: char.t });
    } else out.push(char);
  }
  while (out.length > 0 && out[out.length - 1]?.c === " ") out.pop();
  return out;
}

export const normalizedText = (node: ProseMirrorJSON) =>
  normalizedChars(node)
    .map((char) => char.c)
    .join("");

/**
 * Who wrote which passage of one top-level block: offsets into its normalized text, with the author
 * key and minutes since the epoch. Runs of the same author and minute merge; a collapsed space between
 * two runs of one author doesn't split them.
 */
export function authorRuns(node: ProseMirrorJSON): { s: number; e: number; a: string; t: number }[] {
  const runs: { s: number; e: number; a: string; t: number }[] = [];
  for (const [index, char] of normalizedChars(node).entries()) {
    const last = runs[runs.length - 1];
    if (char.a === null) {
      if (char.c === " " && last && last.e === index) last.e = index + 1;
      continue;
    }
    if (last && last.a === char.a && last.t === char.t && last.e === index) last.e = index + 1;
    else runs.push({ s: index, e: index + 1, a: char.a, t: char.t });
  }
  // A trailing separator space counted into a run belongs to no one.
  const text = normalizedText(node);
  for (const run of runs) while (run.e > run.s && text[run.e - 1] === " ") run.e -= 1;
  return runs.filter((run) => run.e > run.s);
}

export const authorMinutes = (at: number = Date.now()) => Math.floor(at / 60_000);

export const authorPluginKey = new PluginKey("author");

const stripAuthors = (fragment: Fragment): Fragment => {
  const nodes: Node[] = [];
  fragment.forEach((node) => {
    if (node.isText) nodes.push(node.mark(node.marks.filter((mark) => mark.type.name !== "author")));
    else nodes.push(node.type.create(node.attrs, stripAuthors(node.content), node.marks));
  });
  return Fragment.from(nodes);
};

/**
 * Marks what this person types with their author key, from the sync socket's `hello` (13,
 * "Attribution"): any changed text with no author yet. Moving a block or changing its type keeps the
 * authors it had. A paste becomes the paster's, because the server refuses text whose key gains words
 * it never had.
 */
export function authorPlugin(key: () => string | null): Plugin {
  return new Plugin({
    key: authorPluginKey,
    props: {
      transformPasted: (slice) => new Slice(stripAuthors(slice.content), slice.openStart, slice.openEnd),
    },
    appendTransaction(transactions, _old, state) {
      const a = key();
      if (!a) return null;
      const type = state.schema.marks.author;
      if (!type) return null;
      const ranges: [number, number][] = [];
      for (const tr of transactions) {
        if (!tr.docChanged) continue;
        const sync = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
        if (sync?.isChangeOrigin) continue;
        for (const [index, step] of tr.steps.entries()) {
          const map = step.getMap();
          const after = tr.mapping.slice(index + 1);
          map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
            if (newEnd > newStart) ranges.push([after.map(newStart, -1), after.map(newEnd, 1)]);
          });
        }
      }
      if (ranges.length === 0) return null;
      const mark = type.create({ a, t: authorMinutes() });
      const tr = state.tr;
      for (const [from, to] of ranges) {
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!node.isText) return;
          const start = Math.max(from, pos);
          const end = Math.min(to, pos + node.nodeSize);
          if (end > start && !type.isInSet(node.marks)) tr.addMark(start, end, mark);
        });
      }
      return tr.docChanged ? tr.setMeta("addToHistory", false) : null;
    },
  });
}
