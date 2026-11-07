import { type MarkSpec, type NodeSpec, Schema } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

/**
 * The editor's document schema (13, "The document model"). Every block node takes `id`: required and
 * unique on top-level blocks, ignored when nested. The schema has no DOM of its own beyond `toDOM`
 * arrays, so the server, the editor chunk and the tests share it.
 *
 * Wiki links are text: `[[Target]]` and `[[Target|label]]` stay as typed, the serializer writes them
 * unescaped, and the editor draws them with a decoration. An inline node would lose its marks (bold
 * around a link) and its author through y-prosemirror, which keeps marks on text only.
 */

const id = { id: { default: null } };
const idDOM = (attrs: Record<string, unknown>) => (attrs.id ? { "data-block": String(attrs.id) } : {});

/**
 * Whether a link may point here: http, https, mailto, or relative (a path, a fragment, a query). Control
 * characters and spaces are dropped before the scheme is read, as browsers do, so `java\tscript:` is
 * caught too.
 */
export function safeHref(href: unknown): href is string {
  if (typeof href !== "string" || href.length > 4096) return false;
  // Code points up to U+0020 and U+007F to U+009F, dropped as browsers drop them from a URL's start.
  const bare = [...href]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code > 0x20 && (code < 0x7f || code > 0x9f);
    })
    .join("");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(bare);
  return !scheme || ["http", "https", "mailto"].includes((scheme[1] as string).toLowerCase());
}

export const CALLOUTS = ["note", "tip", "important", "warning", "caution"] as const;
export const COMPONENT_NAMES = ["stats", "compare", "steps"] as const;

const tables = tableNodes({
  tableGroup: "block",
  cellContent: "paragraph",
  cellAttributes: { align: { default: null } },
});

const nodes: Record<string, NodeSpec> = {
  doc: { content: "(block | atom)+" },
  paragraph: {
    group: "block",
    content: "inline*",
    attrs: id,
    parseDOM: [{ tag: "p" }],
    toDOM: (node) => ["p", idDOM(node.attrs), 0],
  },
  heading: {
    group: "block",
    content: "inline*",
    attrs: { ...id, level: { default: 1, validate: "number" } },
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node) => [`h${node.attrs.level}`, idDOM(node.attrs), 0],
  },
  blockquote: {
    group: "block",
    content: "block+",
    attrs: { ...id, callout: { default: null } },
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM: (node) => [
      "blockquote",
      { ...idDOM(node.attrs), ...(node.attrs.callout ? { "data-callout": node.attrs.callout } : {}) },
      0,
    ],
  },
  bullet_list: {
    group: "block",
    content: "list_item+",
    attrs: { ...id, tight: { default: true } },
    parseDOM: [{ tag: "ul" }],
    toDOM: (node) => ["ul", idDOM(node.attrs), 0],
  },
  ordered_list: {
    group: "block",
    content: "list_item+",
    attrs: { ...id, tight: { default: true }, start: { default: 1, validate: "number" } },
    parseDOM: [{ tag: "ol", getAttrs: (dom) => ({ start: Number(dom.getAttribute("start") ?? 1) }) }],
    toDOM: (node) => [
      "ol",
      { ...idDOM(node.attrs), ...(node.attrs.start === 1 ? {} : { start: node.attrs.start }) },
      0,
    ],
  },
  list_item: {
    content: "block+",
    attrs: { checked: { default: null } },
    defining: true,
    parseDOM: [{ tag: "li" }],
    toDOM: (node) => [
      "li",
      node.attrs.checked === null ? {} : { "data-checked": String(node.attrs.checked) },
      0,
    ],
  },
  code_block: {
    group: "block",
    content: "text*",
    marks: "author",
    attrs: { ...id, lang: { default: null } },
    code: true,
    defining: true,
    parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
    toDOM: (node) => ["pre", idDOM(node.attrs), ["code", 0]],
  },
  horizontal_rule: {
    group: "block",
    attrs: id,
    parseDOM: [{ tag: "hr" }],
    toDOM: (node) => ["hr", idDOM(node.attrs)],
  },
  component: {
    group: "block",
    content: "block+",
    attrs: { ...id, name: { default: "steps" } },
    defining: true,
    parseDOM: [{ tag: "div[data-component]", getAttrs: (dom) => ({ name: dom.dataset.component }) }],
    toDOM: (node) => ["div", { ...idDOM(node.attrs), "data-component": node.attrs.name }, 0],
  },
  table: { ...tables.table, attrs: id } as NodeSpec,
  table_row: tables.table_row as NodeSpec,
  table_header: tables.table_header as NodeSpec,
  table_cell: tables.table_cell as NodeSpec,
  /** Anything the editor can't represent losslessly: its exact Markdown lives in `edit_atoms` (13, "Atoms"). */
  atom: {
    group: "atom",
    atom: true,
    selectable: true,
    draggable: true,
    attrs: { ...id, kind: { default: "markdown" }, hash: { default: "" } },
    parseDOM: [],
    toDOM: (node) => ["div", { ...idDOM(node.attrs), "data-atom": node.attrs.kind }],
  },
  text: { group: "inline" },
  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
  },
};

/** Mark order is nesting order when the Markdown is written: the earlier mark wraps the later one. */
const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: {}, title: { default: null } },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]",
        // A pasted link to anywhere else stays its text.
        getAttrs: (dom) => {
          const href = dom.getAttribute("href");
          return safeHref(href) ? { href, title: dom.getAttribute("title") } : false;
        },
      },
    ],
    toDOM: (mark) => [
      "a",
      safeHref(mark.attrs.href)
        ? { href: mark.attrs.href, title: mark.attrs.title }
        : { title: mark.attrs.title },
      0,
    ],
  },
  em: {
    parseDOM: [{ tag: "em" }, { tag: "i" }],
    toDOM: () => ["em", 0],
  },
  strong: {
    parseDOM: [{ tag: "strong" }, { tag: "b" }],
    toDOM: () => ["strong", 0],
  },
  strike: {
    parseDOM: [{ tag: "del" }, { tag: "s" }],
    toDOM: () => ["del", 0],
  },
  code: {
    parseDOM: [{ tag: "code" }],
    toDOM: () => ["code", 0],
  },
  /**
   * Attribution, never drawn as formatting: `a` is an author key (`a<n>`), `t` minutes since the Unix
   * epoch. Not inclusive, so typing next to someone's words doesn't take their name.
   */
  author: {
    attrs: { a: {}, t: { default: 0 } },
    inclusive: false,
    parseDOM: [],
    toDOM: (mark) => ["span", { "data-author": mark.attrs.a }, 0],
  },
};

export const editorSchema = new Schema({ nodes, marks });

/** The top-level block types: every one of them carries a lasting id. */
export const TOP_BLOCKS = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "bullet_list",
  "ordered_list",
  "code_block",
  "horizontal_rule",
  "component",
  "table",
  "atom",
]);

/** A ProseMirror document or node as JSON: what the converters, the CRDT and the server pass around. */
export type ProseMirrorJSON = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ProseMirrorJSON[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
};
