import { articleBlocks } from "@artifacts/schema/article";
import type { AtomKind } from "@artifacts/schema/editing";
import type {
  Blockquote,
  Code,
  List,
  ListItem,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
  TableRow,
} from "mdast";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify, { type Options as StringifyOptions } from "remark-stringify";
import { unified } from "unified";
import { isBlockId } from "./ids.ts";
import { CALLOUTS, COMPONENT_NAMES, type ProseMirrorJSON, safeHref } from "./schema.ts";

/**
 * Markdown to the editor's document and back (13, "The document model"), with the same remark stack the
 * read pipeline uses. Anything without a lossless editor form becomes an atom holding its exact source.
 */

type Mark = { type: string; attrs?: Record<string, unknown> };
type MdNode = RootContent | PhrasingContent | ListItem | TableRow | TableCell;
type Atoms = (hash: string) => string;

/** `[[Target]]` and `[[Target|label]]`, as `remarkWikilinks` matches them. Written back unescaped. */
const WIKILINK = /\[\[([^[\]|\n]{1,200})(?:\|([^[\]\n]{1,200}))?\]\]/g;
const CALLOUT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/;
const COMPONENTS = new Set<string>(COMPONENT_NAMES);

class Unmappable extends Error {}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkDirective);

export const parseMarkdown = (source: string) => parser.parse(source) as Root;

const soleChild = (node: MdNode | undefined, types: string[]) =>
  node?.type === "paragraph" && node.children.length === 1 && types.includes(node.children[0]?.type ?? "");

const slice = (source: string, first: MdNode, last: MdNode) =>
  source.slice(first.position?.start.offset ?? 0, last.position?.end.offset ?? source.length);

/** The atom kind a top-level group is, or null when the editor can hold it as blocks. */
function atomKind(group: RootContent[]): AtomKind | null {
  const node = group[0] as RootContent;
  if (group.length > 1 || soleChild(node, ["image", "imageReference"])) return "image";
  if (node.type === "code" && node.lang === "mermaid") return "mermaid";
  if (node.type === "leafDirective" && node.name === "chart") return "chart";
  if (node.type === "leafDirective" && node.name === "frame") return "frame";
  if (node.type === "html") return "html";
  return null;
}

const text = (value: string, marks: Mark[]): ProseMirrorJSON[] =>
  value === "" ? [] : [{ type: "text", text: value, ...(marks.length ? { marks } : {}) }];

function inline(children: PhrasingContent[], marks: Mark[]): ProseMirrorJSON[] {
  const out: ProseMirrorJSON[] = [];
  for (const child of children) {
    switch (child.type) {
      case "text":
        out.push(...text(child.value, marks));
        break;
      case "inlineCode":
        out.push(...text(child.value, [...marks, { type: "code" }]));
        break;
      case "emphasis":
        out.push(...inline(child.children, [...marks, { type: "em" }]));
        break;
      case "strong":
        out.push(...inline(child.children, [...marks, { type: "strong" }]));
        break;
      case "delete":
        out.push(...inline(child.children, [...marks, { type: "strike" }]));
        break;
      case "link":
        // A link the editor wouldn't keep (javascript:, data:) stays exact, as an atom the sanitizer draws.
        if (marks.some((mark) => mark.type === "link") || !safeHref(child.url)) throw new Unmappable();
        out.push(
          ...inline(child.children, [
            ...marks,
            { type: "link", attrs: { href: child.url, title: child.title ?? null } },
          ]),
        );
        break;
      case "break":
        out.push({ type: "hard_break", ...(marks.length ? { marks } : {}) });
        break;
      default:
        // Images, references, footnotes, inline HTML and text directives have no editor form.
        throw new Unmappable();
    }
  }
  return out;
}

const listLoose = (list: List) =>
  Boolean(list.spread) ||
  list.children.some((item) =>
    item.spread === null || item.spread === undefined ? item.children.length > 1 : item.spread,
  );

function blocks(children: RootContent[]): ProseMirrorJSON[] {
  if (children.length === 0) return [{ type: "paragraph", attrs: { id: null } }];
  return children.map((child) => block(child, null));
}

function block(node: RootContent, id: string | null): ProseMirrorJSON {
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", attrs: { id }, content: inline(node.children, []) };
    case "heading":
      return { type: "heading", attrs: { id, level: node.depth }, content: inline(node.children, []) };
    case "thematicBreak":
      return { type: "horizontal_rule", attrs: { id } };
    case "code": {
      if (node.lang === "mermaid") throw new Unmappable();
      const lang = node.lang ? (node.meta ? `${node.lang} ${node.meta}` : node.lang) : null;
      return { type: "code_block", attrs: { id, lang }, content: text(node.value, []) };
    }
    case "blockquote": {
      let callout: string | null = null;
      const children = structuredClone(node.children);
      const first = children[0];
      const lead = first?.type === "paragraph" ? first.children[0] : undefined;
      if (lead?.type === "text") {
        const match = CALLOUT.exec(lead.value);
        if (match && first?.type === "paragraph") {
          callout = (match[1] as string).toLowerCase();
          lead.value = lead.value.slice(match[0].length);
          if (lead.value === "") first.children.shift();
        }
      }
      return { type: "blockquote", attrs: { id, callout }, content: blocks(children) };
    }
    case "list": {
      const tight = !listLoose(node);
      const items = node.children.map((item) => ({
        type: "list_item",
        attrs: { checked: item.checked ?? null },
        content: blocks(item.children),
      }));
      return node.ordered
        ? { type: "ordered_list", attrs: { id, tight, start: node.start ?? 1 }, content: items }
        : { type: "bullet_list", attrs: { id, tight }, content: items };
    }
    case "table": {
      const rows = node.children.map((row, r) => ({
        type: "table_row",
        content: row.children.map((cell, c) => ({
          type: r === 0 ? "table_header" : "table_cell",
          attrs: { colspan: 1, rowspan: 1, colwidth: null, align: node.align?.[c] ?? null },
          content: [{ type: "paragraph", attrs: { id: null }, content: inline(cell.children, []) }],
        })),
      }));
      return { type: "table", attrs: { id }, content: rows };
    }
    case "containerDirective": {
      const label = node.children[0]?.data && "directiveLabel" in node.children[0].data;
      if (
        !COMPONENTS.has(node.name) ||
        Object.keys(node.attributes ?? {}).length > 0 ||
        label ||
        node.children.length === 0
      )
        throw new Unmappable();
      return {
        type: "component",
        attrs: { id, name: node.name },
        content: node.children.map((child) => block(child, null)),
      };
    }
    default:
      throw new Unmappable();
  }
}

/**
 * Markdown to a document. Top-level blocks group as `articleBlocks` groups them, and take `ids` in
 * order when given (from `meta.blockIds`), minting the rest. `atom` stores an atom's exact source and
 * returns its hash. Returns the document and the ids it used, one per top-level block.
 */
export function markdownToDoc(
  source: string,
  opts: { ids?: string[]; mint(): string; atom(kind: AtomKind, source: string): string },
): { doc: ProseMirrorJSON; ids: string[] } {
  const root = parseMarkdown(source);
  const used = new Set<string>();
  const ids: string[] = [];
  const content: ProseMirrorJSON[] = [];
  for (const [index, group] of articleBlocks(root).entries()) {
    const given = opts.ids?.[index];
    let id = isBlockId(given) && !used.has(given) ? given : opts.mint();
    while (used.has(id)) id = opts.mint();
    used.add(id);
    ids.push(id);
    const first = group[0] as RootContent;
    const kind = atomKind(group);
    if (kind) {
      const atomSource = slice(source, first, group[group.length - 1] as RootContent);
      content.push({ type: "atom", attrs: { id, kind, hash: opts.atom(kind, atomSource) } });
      continue;
    }
    try {
      content.push(block(first, id));
    } catch (error) {
      if (!(error instanceof Unmappable)) throw error;
      const atomSource = slice(source, first, first);
      content.push({
        type: "atom",
        attrs: { id, kind: "markdown", hash: opts.atom("markdown", atomSource) },
      });
    }
  }
  if (content.length === 0) {
    const id = opts.mint();
    ids.push(id);
    content.push({ type: "paragraph", attrs: { id } });
  }
  return { doc: { type: "doc", content }, ids };
}

// Back to Markdown.

/** A node written as is: an atom's source, a wiki link, a callout's marker. */
type Raw = { type: "raw"; value: string };

const sameMark = (a: Mark, b: Mark) =>
  a.type === b.type && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {});

const MARK_ORDER = ["link", "em", "strong", "strike"];

function wrap(mark: Mark): PhrasingContent & { children: PhrasingContent[] } {
  switch (mark.type) {
    case "em":
      return { type: "emphasis", children: [] };
    case "strong":
      return { type: "strong", children: [] };
    case "strike":
      return { type: "delete", children: [] };
    default:
      return {
        type: "link",
        url: String(mark.attrs?.href ?? ""),
        title: (mark.attrs?.title as string | null) ?? null,
        children: [],
      };
  }
}

/** Text outside code and links keeps its `[[wiki links]]` raw, so they aren't escaped to `\[\[`. */
function splitWikilinks(children: PhrasingContent[], inLink: boolean): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const child of children) {
    if (child.type === "text" && !inLink && child.value.includes("[[")) {
      let last = 0;
      for (const match of child.value.matchAll(WIKILINK)) {
        const at = match.index ?? 0;
        if (at > last) out.push({ type: "text", value: child.value.slice(last, at) });
        out.push({ type: "raw", value: match[0] } as unknown as PhrasingContent);
        last = at + match[0].length;
      }
      if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) });
    } else if ("children" in child) {
      out.push({
        ...child,
        children: splitWikilinks(child.children as PhrasingContent[], inLink || child.type === "link"),
      } as PhrasingContent);
    } else out.push(child);
  }
  return out;
}

/** Inline nodes to mdast phrasing: a mark that continues stays open, so spans nest as they ran. */
function phrasing(nodes: ProseMirrorJSON[] = []): PhrasingContent[] {
  const root: PhrasingContent[] = [];
  const stack: { mark: Mark; node: { children: PhrasingContent[] } }[] = [];
  const top = () => stack[stack.length - 1]?.node.children ?? root;
  for (const node of nodes) {
    const marks = (node.marks ?? [])
      .filter((mark) => MARK_ORDER.includes(mark.type))
      .sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
    let keep = 0;
    while (keep < stack.length && marks.some((mark) => sameMark(mark, (stack[keep] as { mark: Mark }).mark)))
      keep += 1;
    stack.length = keep;
    for (const mark of marks) {
      if (stack.some((open) => sameMark(open.mark, mark))) continue;
      const wrapper = wrap(mark);
      top().push(wrapper);
      stack.push({ mark, node: wrapper });
    }
    const into = top();
    if (node.type === "hard_break") into.push({ type: "break" });
    else if (node.type === "text") {
      const value = node.text ?? "";
      if (node.marks?.some((mark) => mark.type === "code")) into.push({ type: "inlineCode", value });
      else {
        const last = into[into.length - 1];
        if (last?.type === "text") last.value += value;
        else into.push({ type: "text", value });
      }
    }
  }
  return splitWikilinks(root, false);
}

function mdBlocks(nodes: ProseMirrorJSON[] = []): RootContent[] {
  return nodes.map((node) => mdBlock(node, () => "")).filter((node): node is RootContent => node !== null);
}

function mdBlock(node: ProseMirrorJSON, atoms: Atoms): RootContent | null {
  const attrs = node.attrs ?? {};
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", children: phrasing(node.content) };
    case "heading":
      return {
        type: "heading",
        depth: Math.min(6, Math.max(1, Number(attrs.level ?? 1))) as 1,
        children: phrasing(node.content),
      };
    case "horizontal_rule":
      return { type: "thematicBreak" };
    case "code_block": {
      const info = typeof attrs.lang === "string" ? attrs.lang.trim() : "";
      const space = info.search(/\s/);
      const code: Code = {
        type: "code",
        lang: info ? (space < 0 ? info : info.slice(0, space)) : null,
        meta: space < 0 ? null : info.slice(space + 1).trim() || null,
        value: (node.content ?? []).map((child) => child.text ?? "").join(""),
      };
      return code;
    }
    case "blockquote": {
      const children = mdBlocks(node.content);
      const callout =
        typeof attrs.callout === "string" && (CALLOUTS as readonly string[]).includes(attrs.callout);
      if (callout) {
        const marker = {
          type: "raw",
          value: `[!${String(attrs.callout).toUpperCase()}]`,
        } as unknown as PhrasingContent;
        const first = children[0];
        if (first?.type === "paragraph") {
          const rest =
            first.children.length > 0 ? [{ type: "raw", value: "\n" } as unknown as PhrasingContent] : [];
          first.children = [marker, ...rest, ...first.children];
        } else children.unshift({ type: "paragraph", children: [marker] });
      }
      const quote: Blockquote = { type: "blockquote", children: children as Blockquote["children"] };
      return quote;
    }
    case "bullet_list":
    case "ordered_list": {
      const spread = attrs.tight === false;
      const list: List = {
        type: "list",
        ordered: node.type === "ordered_list",
        start: node.type === "ordered_list" ? Number(attrs.start ?? 1) : null,
        spread,
        children: (node.content ?? []).map(
          (item): ListItem => ({
            type: "listItem",
            spread,
            checked: typeof item.attrs?.checked === "boolean" ? item.attrs.checked : null,
            children: mdBlocks(item.content) as ListItem["children"],
          }),
        ),
      };
      return list;
    }
    case "table": {
      const rows = node.content ?? [];
      const table: Table = {
        type: "table",
        align: (rows[0]?.content ?? []).map(
          (cell) => (cell.attrs?.align as "left" | "right" | "center" | null) ?? null,
        ),
        children: rows.map(
          (row): TableRow => ({
            type: "tableRow",
            children: (row.content ?? []).map(
              (cell): TableCell => ({
                type: "tableCell",
                children: phrasing((cell.content ?? []).flatMap((paragraph) => paragraph.content ?? [])),
              }),
            ),
          }),
        ),
      };
      return table;
    }
    case "component":
      return {
        type: "containerDirective",
        name: String(attrs.name ?? "steps"),
        attributes: {},
        children: mdBlocks(node.content) as never,
      };
    case "atom":
      return { type: "raw", value: atoms(String(attrs.hash ?? "")) } as unknown as RootContent;
    default:
      return null;
  }
}

const rawHandler = {
  raw: (node: Raw) => node.value,
};

const stringifyOptions: StringifyOptions = {
  bullet: "-",
  bulletOther: "*",
  bulletOrdered: ".",
  emphasis: "*",
  strong: "*",
  fence: "`",
  fences: true,
  rule: "-",
  listItemIndent: "one",
  incrementListMarker: true,
  handlers: rawHandler as never,
};

const stringify = (root: Root, options: StringifyOptions) =>
  unified()
    .use(remarkGfm)
    .use(remarkDirective)
    .use(remarkStringify, { ...stringifyOptions, ...options })
    .stringify(root);

/** A top-level block that writes nothing: an empty paragraph has no Markdown, and so no id. */
const writesNothing = (node: ProseMirrorJSON) =>
  node.type === "paragraph" &&
  (node.content ?? []).every((child) => child.type === "text" && (child.text ?? "").trim() === "");

/** Two lists of one kind in a row merge unless the second uses the other marker. */
function blockOptions(node: ProseMirrorJSON, previous: ProseMirrorJSON | undefined): StringifyOptions {
  if (!previous || previous.type !== node.type) return {};
  if (node.type === "bullet_list") return { bullet: "*", bulletOther: "-" };
  if (node.type === "ordered_list") return { bulletOrdered: ")" };
  return {};
}

/** One top-level block's Markdown, with no trailing newline, as `artifacts_page_read` lists it. */
export function blockMarkdown(node: ProseMirrorJSON, atoms: Atoms, options: StringifyOptions = {}): string {
  if (node.type === "atom") return atoms(String(node.attrs?.hash ?? ""));
  const md = mdBlock(node, atoms);
  if (!md) return "";
  return stringify({ type: "root", children: [md] }, options).replace(/\n+$/, "");
}

/**
 * A document to Markdown, and the ids of the blocks it wrote, in order: one per `articleBlocks` group of
 * the result, so `buildArticle` pairs them. A block that writes nothing gives no id; a paragraph that
 * merges into the image before it as its caption gives its id up to the image.
 */
export function docToMarkdown(doc: ProseMirrorJSON, atoms: Atoms): { markdown: string; blockIds: string[] } {
  const parts: { text: string; id: string; start: number }[] = [];
  let offset = 0;
  let previous: ProseMirrorJSON | undefined;
  for (const node of doc.content ?? []) {
    if (writesNothing(node)) continue;
    const md = blockMarkdown(node, atoms, blockOptions(node, previous));
    previous = node;
    if (md === "") continue;
    if (parts.length > 0) offset += 2;
    parts.push({ text: md, id: String(node.attrs?.id ?? ""), start: offset });
    offset += md.length;
  }
  const markdown = parts.length ? `${parts.map((part) => part.text).join("\n\n")}\n` : "";
  // Pair the ids with the blocks the Markdown parses back into, by where each group starts.
  const blockIds: string[] = [];
  const taken = new Set<string>();
  let at = 0;
  for (const group of articleBlocks(parseMarkdown(markdown))) {
    const start = group[0]?.position?.start.offset ?? 0;
    while (at + 1 < parts.length && (parts[at + 1] as { start: number }).start <= start) at += 1;
    const id = parts[at]?.id;
    if (!id || taken.has(id)) break;
    taken.add(id);
    blockIds.push(id);
  }
  return { markdown, blockIds };
}
