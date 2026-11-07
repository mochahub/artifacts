import type { Author, Suggestion } from "@artifacts/schema";
import { Fragment, type Node as ProseNode, Slice } from "prosemirror-model";
import { type EditorState, Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { ySyncPluginKey } from "y-prosemirror";
import { diff, tokens } from "../article/diff.ts";
import { agentShort } from "../format.ts";

const isRemote = (tr: Transaction) => !!tr.getMeta(ySyncPluginKey);

/**
 * A link the editor will make: http(s), mailto, or a path on this site (`/x`, `./x`, `../x`, `#x`).
 * Anything else (javascript:, data:, a scheme-relative `//host`) is refused, here and on paste.
 */
export function safeHref(href: string) {
  const value = href.trim();
  if (/^(\/(?!\/)|\.\.?\/|#)/.test(value)) return true;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Pasted or dropped links keep their words and lose an address that isn't safe. */
export function safeLinksPlugin() {
  const strip = (fragment: Fragment): Fragment => {
    const out: ProseNode[] = [];
    fragment.forEach((node) => {
      const marks = node.marks.filter((m) => m.type.name !== "link" || safeHref(String(m.attrs.href ?? "")));
      const content = node.isLeaf ? node.content : strip(node.content);
      out.push(node.isText ? node.mark(marks) : node.type.create(node.attrs, content, marks));
    });
    return Fragment.from(out);
  };
  return new Plugin({
    props: { transformPasted: (slice) => new Slice(strip(slice.content), slice.openStart, slice.openEnd) },
  });
}

/** The top-level block holding a position, by its lasting id. */
export function blockAt(
  doc: ProseNode,
  pos: number,
): { id: string | null; from: number; node: ProseNode } | null {
  const index = doc.resolve(Math.min(pos, doc.content.size)).index(0);
  const node = doc.maybeChild(index);
  if (!node) return null;
  let from = 0;
  for (let i = 0; i < index; i++) from += doc.child(i).nodeSize;
  return { id: (node.attrs.id as string | null) ?? null, from, node };
}

export function blockById(doc: ProseNode, id: string) {
  let found: { from: number; node: ProseNode } | null = null;
  doc.forEach((node, from) => {
    if (!found && node.attrs.id === id) found = { from, node };
  });
  return found as { from: number; node: ProseNode } | null;
}

const authorKey = new PluginKey<{ ranges: [number, number][] }>("author");

/**
 * Marks what this person types with their author key (13, "Attribution"). The server refuses an update
 * whose inserted text carries anyone else's key, and ProseMirror would otherwise carry over the mark of
 * the words beside the caret, which may be Claude's. Ranges wait while an IME composes, so re-marking
 * never cancels a word in progress on iPhone, and are marked when the composition ends.
 */
export function authorPlugin(key: () => string | null) {
  let current: EditorView | null = null;
  return new Plugin<{ ranges: [number, number][] }>({
    key: authorKey,
    state: {
      init: () => ({ ranges: [] }),
      apply(tr, value) {
        if (tr.getMeta(authorKey) === "done") return { ranges: [] };
        if (!tr.docChanged) return value;
        const ranges: [number, number][] = value.ranges
          .map(([from, to]): [number, number] => [tr.mapping.map(from, -1), tr.mapping.map(to, 1)])
          .filter(([from, to]) => to > from);
        if (isRemote(tr)) return { ranges };
        tr.mapping.maps.forEach((map, index) => {
          map.forEach((_oldStart, _oldEnd, start, end) => {
            if (end <= start) return;
            const rest = tr.mapping.slice(index + 1);
            ranges.push([rest.map(start, -1), rest.map(end, 1)]);
          });
        });
        return { ranges };
      },
    },
    appendTransaction(_trs, _old, state) {
      const pending = authorKey.getState(state)?.ranges ?? [];
      const a = key();
      if (pending.length === 0 || !a) return null;
      if (current?.composing) return null;
      const type = state.schema.marks.author;
      if (!type) return null;
      const tr = state.tr.setMeta(authorKey, "done").setMeta("addToHistory", false);
      const mark = type.create({ a, t: Math.floor(Date.now() / 60_000) });
      for (const [from, to] of pending) {
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!node.isText) return;
          const start = Math.max(from, pos);
          const end = Math.min(to, pos + node.nodeSize);
          if (end <= start || node.marks.some((m) => m.type === type && m.attrs.a === a)) return;
          tr.removeMark(start, end, type).addMark(start, end, mark);
        });
      }
      return tr;
    },
    view(view) {
      current = view;
      const onEnd = () =>
        setTimeout(() => {
          // A composition can end as the editor closes (iOS ends it on blur).
          if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta("composed", true));
        }, 0);
      view.dom.addEventListener("compositionend", onEnd);
      return { destroy: () => view.dom.removeEventListener("compositionend", onEnd) };
    },
  });
}

/**
 * Tells the others where this person is (13, "Presence"): the caret's block, and the blocks changed in
 * the last moments, which the server holds so an agent's replace there becomes a suggestion.
 */
export function presencePlugin(report: (block: string | null, pending: string[]) => void) {
  const recent = new Map<string, number>();
  let last = "";
  let timer = 0;
  const send = (state: EditorState) => {
    const now = Date.now();
    for (const [id, at] of recent) if (now - at > 2000) recent.delete(id);
    const block = blockAt(state.doc, state.selection.head)?.id ?? null;
    const pending = [...recent.keys()].slice(0, 50);
    const next = JSON.stringify([block, pending]);
    if (next === last) return;
    last = next;
    report(block, pending);
  };
  return new Plugin({
    view: () => ({
      update(view, previous) {
        const state = view.state;
        if (state.doc !== previous.doc) {
          const id = blockAt(state.doc, state.selection.head)?.id;
          if (id) recent.set(id, Date.now());
          clearTimeout(timer);
          timer = window.setTimeout(() => send(view.state), 2100);
        }
        send(state);
      },
      destroy: () => clearTimeout(timer),
    }),
  });
}

const pencilKey = new PluginKey<DecorationSet>("pencil");

/** The blue pencil, live: a line under every run of text whose author mark is an agent's. */
export function pencilPlugin(agents: () => Set<string>) {
  const build = (doc: ProseNode) => {
    const keys = agents();
    const decorations: Decoration[] = [];
    if (keys.size)
      doc.descendants((node, pos) => {
        if (!node.isText) return;
        const mark = node.marks.find((m) => m.type.name === "author" && keys.has(m.attrs.a));
        if (mark)
          decorations.push(
            Decoration.inline(pos, pos + node.nodeSize, {
              class: "pen",
              "data-author": String(mark.attrs.a),
            }),
          );
      });
    return DecorationSet.create(doc, decorations);
  };
  return new Plugin<DecorationSet>({
    key: pencilKey,
    state: {
      init: (_config, state) => build(state.doc),
      apply: (tr, old) => (tr.docChanged || tr.getMeta(pencilKey) ? build(tr.doc) : old),
    },
    props: { decorations: (state) => pencilKey.getState(state) },
  });
}
export const redrawPencil = (view: EditorView) => view.dispatch(view.state.tr.setMeta(pencilKey, true));

export type SuggestionActions = {
  accept(id: string): void;
  reject(id: string): void;
};

const suggestKey = new PluginKey<{ list: Suggestion[]; set: DecorationSet }>("suggestions");

/** The words of a server rendering, read as data: it's parsed, never put on the page as HTML. */
export const textOf = (html: string | null) =>
  html ? (new DOMParser().parseFromString(html, "text/html").body.textContent ?? "") : "";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Old words struck, new ones in the blue pencil: the compare marks, drawn as text nodes only. */
export function diffWords(before: string, after: string) {
  const box = el("p", "sug-text");
  const a = tokens(before);
  const b = tokens(after);
  for (const op of diff(a, b)) {
    if (op.op === "same") box.append(a[op.a] ?? "");
    else if (op.op === "remove") box.append(el("del", "s", a[op.a]));
    else box.append(el("ins", "s", b[op.b]));
  }
  return box;
}

export const suggestionLabel = (author: Author) =>
  `${author.kind === "agent" ? agentShort(author.agent ?? author.name) : author.name} suggests`;

function card(suggestion: Suggestion, doc: ProseNode, index: number, total: number, act: SuggestionActions) {
  const box = el("div", "sug");
  box.dataset.suggestion = suggestion.id;
  box.contentEditable = "false";
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", suggestionLabel(suggestion.author));
  const target = suggestion.block ? blockById(doc, suggestion.block) : null;
  const before = suggestion.op === "insert" ? "" : (target?.node.textContent ?? "");
  const after = suggestion.op === "delete" ? "" : textOf(suggestion.html) || (suggestion.markdown ?? "");
  if (suggestion.op !== "meta") box.append(diffWords(before, after));
  const head = el("div", "hd");
  const mark = el("span", "av agent");
  mark.setAttribute("aria-hidden", "true");
  mark.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/></svg>';
  head.append(mark, el("b", undefined, suggestionLabel(suggestion.author)), el("span", "grow"));
  if (total > 1) head.append(el("span", undefined, `${index + 1} of ${total}`));
  box.prepend(head);
  const why =
    suggestion.op === "delete"
      ? "Remove this block."
      : suggestion.op === "meta"
        ? `Change the page's ${Object.keys(suggestion.meta ?? {}).join(", ")}.`
        : null;
  if (suggestion.note || why) box.append(el("div", "why", suggestion.note ?? why ?? ""));
  if (suggestion.status === "stale")
    box.append(el("div", "ss", "The text changed since this was suggested."));
  const acts = el("div", "acts");
  const reject = el("button", "btn soft", "Reject");
  reject.type = "button";
  reject.addEventListener("click", () => act.reject(suggestion.id));
  const accept = el("button", "btn ink", "Accept");
  accept.type = "button";
  accept.addEventListener("click", () => act.accept(suggestion.id));
  acts.append(reject, accept);
  box.append(acts);
  return box;
}

/** Suggestions inline, under the block they change (or after the block they follow, for an insert). */
export function suggestionsPlugin(act: SuggestionActions) {
  const build = (doc: ProseNode, list: Suggestion[]) => {
    const open = list.filter((s) => s.status === "open" || s.status === "stale");
    const decorations: Decoration[] = [];
    open.forEach((suggestion, index) => {
      let at = 0;
      let side = -1;
      if (suggestion.block) {
        const target = blockById(doc, suggestion.block);
        if (!target) return;
        at = target.from + target.node.nodeSize;
        if (suggestion.op !== "insert")
          decorations.push(
            Decoration.node(target.from, at, { class: suggestion.op === "delete" ? "sug-gone" : "sug-on" }),
          );
      } else if (suggestion.op === "meta") side = -2;
      decorations.push(
        Decoration.widget(at, () => card(suggestion, doc, index, open.length, act), {
          key: `${suggestion.id}:${suggestion.status}`,
          side,
          ignoreSelection: true,
          stopEvent: () => true,
        }),
      );
    });
    return DecorationSet.create(doc, decorations);
  };
  return new Plugin<{ list: Suggestion[]; set: DecorationSet }>({
    key: suggestKey,
    state: {
      init: (_config, state) => ({ list: [], set: build(state.doc, []) }),
      apply(tr, value) {
        const list = tr.getMeta(suggestKey) as Suggestion[] | undefined;
        if (list) return { list, set: build(tr.doc, list) };
        if (!tr.docChanged) return value;
        return { list: value.list, set: build(tr.doc, value.list) };
      },
    },
    props: { decorations: (state) => suggestKey.getState(state)?.set },
  });
}
export const setSuggestions = (view: EditorView, list: Suggestion[]) =>
  view.dispatch(view.state.tr.setMeta(suggestKey, list));

/** The open suggestion on the caret's block, for ⌘⌥Y and ⌘⌥N. */
export function suggestionAtCaret(state: EditorState): Suggestion | null {
  const list = suggestKey.getState(state)?.list ?? [];
  const id = blockAt(state.doc, state.selection.head)?.id;
  return list.find((s) => s.status === "open" && s.block === id) ?? null;
}

/** A remote caret: highlighter ink for people, the blue pencil for agents, flagged with whose it is. */
export function caret(user: { name?: string; kind?: string; for?: string | null }) {
  const agent = user.kind === "agent";
  const box = el("span", `ed-caret${agent ? " ag" : ""}`);
  box.setAttribute("aria-hidden", "true");
  const name =
    agent && user.for && !/ for /.test(user.name ?? "")
      ? `${agentShort(user.name ?? "Agent")} for ${user.for}`
      : agentShort(user.name ?? "Someone");
  box.append(el("span", "flag", name));
  return box;
}
