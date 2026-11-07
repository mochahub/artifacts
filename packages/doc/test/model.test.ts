import { describe, expect, test } from "bun:test";
import type { NodeType } from "prosemirror-model";
import { EditorState, type Plugin, TextSelection } from "prosemirror-state";
import { ySyncPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import { authorPlugin, authorRuns, normalizedText } from "../src/attribution.ts";
import { blockIdPlugin, idRepairs, isBlockId, mintBlockId } from "../src/ids.ts";
import { editorSchema, type ProseMirrorJSON } from "../src/schema.ts";
import { contentHash, docToY, FRAGMENT, fixIds, topBlocks, validate, yToDoc } from "../src/ydoc.ts";

const para = (id: string | null, text: string): ProseMirrorJSON => ({
  type: "paragraph",
  attrs: { id },
  content: text ? [{ type: "text", text }] : [],
});

function state(blocks: ProseMirrorJSON[]) {
  let n = 0;
  const mint = () => `~new${String(n++).padStart(7, "0")}`;
  return EditorState.create({
    doc: editorSchema.nodeFromJSON({ type: "doc", content: blocks }),
    plugins: [blockIdPlugin(mint)],
  });
}

const ids = (s: EditorState) => {
  const out: unknown[] = [];
  s.doc.forEach((node) => {
    out.push(node.attrs.id);
  });
  return out;
};

describe("block ids", () => {
  test("mint", () => {
    for (let i = 0; i < 200; i++) expect(isBlockId(mintBlockId())).toBe(true);
  });

  test("typing keeps the id", () => {
    const s = state([para("~aaaaaaaaaa", "Hello")]);
    const next = s.apply(s.tr.insertText("!", 6));
    expect(ids(next)).toEqual(["~aaaaaaaaaa"]);
  });

  test("changing the block type keeps the id", () => {
    const s = state([para("~aaaaaaaaaa", "Hello")]);
    const tr = s.tr.setBlockType(1, 2, editorSchema.nodes.heading as NodeType, {
      id: "~aaaaaaaaaa",
      level: 2,
    });
    expect(ids(s.applyTransaction(tr).state)).toEqual(["~aaaaaaaaaa"]);
  });

  test("a split inside a block: the first part keeps it, the new block gets a new id", () => {
    const s = state([para("~aaaaaaaaaa", "Hello world"), para("~bbbbbbbbbb", "Next")]);
    const next = s.applyTransaction(s.tr.split(7)).state;
    expect(ids(next)).toEqual(["~aaaaaaaaaa", "~new0000000", "~bbbbbbbbbb"]);
  });

  test("a split at the end: the new block gets a new id", () => {
    const s = state([para("~aaaaaaaaaa", "Hello")]);
    const next = s.applyTransaction(
      s.tr.split(6, 1, [{ type: editorSchema.nodes.paragraph as NodeType }]),
    ).state;
    expect(ids(next)).toEqual(["~aaaaaaaaaa", "~new0000000"]);
  });

  test("a split at offset 0: the content keeps the id, the empty block before it gets a new one", () => {
    const s = state([para("~aaaaaaaaaa", "Hello")]);
    const next = s.applyTransaction(s.tr.split(1)).state;
    expect(ids(next)).toEqual(["~new0000000", "~aaaaaaaaaa"]);
    expect(next.doc.child(1).textContent).toBe("Hello");
  });

  test("a merge: the first block keeps its id, the second's is retired", () => {
    const s = state([para("~aaaaaaaaaa", "One"), para("~bbbbbbbbbb", "Two")]);
    const next = s.applyTransaction(s.tr.join(5)).state;
    expect(ids(next)).toEqual(["~aaaaaaaaaa"]);
    expect(next.doc.textContent).toBe("OneTwo");
  });

  test("a duplicate (a copy) gets a new id; the first holder keeps it", () => {
    const s = state([para("~aaaaaaaaaa", "One"), para("~bbbbbbbbbb", "Two")]);
    const copy = editorSchema.nodeFromJSON(para("~aaaaaaaaaa", "Copy"));
    const next = s.applyTransaction(s.tr.insert(s.doc.content.size, copy)).state;
    expect(ids(next)).toEqual(["~aaaaaaaaaa", "~bbbbbbbbbb", "~new0000000"]);
  });

  test("moving a block keeps its id", () => {
    const s = state([para("~aaaaaaaaaa", "One"), para("~bbbbbbbbbb", "Two")]);
    const second = s.doc.child(1);
    const tr = s.tr.delete(5, 10).insert(0, second);
    expect(ids(s.applyTransaction(tr).state)).toEqual(["~bbbbbbbbbb", "~aaaaaaaaaa"]);
  });

  test("y-sync transactions are left alone", () => {
    const s = state([para("~aaaaaaaaaa", "One")]);
    const tr = s.tr.insert(s.doc.content.size, editorSchema.nodeFromJSON(para(null, "Remote")));
    tr.setMeta(ySyncPluginKey, { isChangeOrigin: true });
    expect(ids(s.applyTransaction(tr).state)).toEqual(["~aaaaaaaaaa", null]);
  });

  test("pasted blocks lose their ids", () => {
    const s = state([para("~aaaaaaaaaa", "One")]);
    const plugin = s.plugins[0] as Plugin;
    const slice = s.doc.slice(0, s.doc.content.size);
    const pasted = (plugin.props.transformPasted as NonNullable<Plugin["props"]["transformPasted"]>).call(
      plugin,
      slice,
      null as never,
      false,
    );
    expect(pasted.content.firstChild?.attrs.id).toBeNull();
  });

  test("the server's repair: first holder keeps it, malformed and missing are fixed", () => {
    expect(
      idRepairs([
        { id: "~aaaaaaaaaa", empty: false },
        { id: "bad", empty: false },
        { id: "~aaaaaaaaaa", empty: false },
        { id: null, empty: true },
      ]),
    ).toEqual([1, 2, 3]);
    const ydoc = docToY({
      type: "doc",
      content: [para("~aaaaaaaaaa", "One"), para("~aaaaaaaaaa", "Two"), para(null, "Three")],
    });
    const changed: unknown[] = [];
    ydoc.on("afterTransaction", (tr: Y.Transaction) => changed.push(tr.origin));
    expect(fixIds(ydoc)).toEqual([1, 2]);
    expect(changed).toEqual(["server"]);
    const after = topBlocks(ydoc).map((block) => block.id);
    expect(after[0]).toBe("~aaaaaaaaaa");
    expect(new Set(after).size).toBe(3);
    expect(after.every(isBlockId)).toBe(true);
  });
});

describe("validate", () => {
  const good = () => docToY({ type: "doc", content: [para("~aaaaaaaaaa", "One")] });

  test("a good document", () => {
    expect(validate(good())).toEqual({ ok: true });
  });

  test("unknown nodes are refused", () => {
    const ydoc = good();
    ydoc.getXmlFragment(FRAGMENT).insert(1, [new Y.XmlElement("script")]);
    expect(validate(ydoc).ok).toBe(false);
  });

  test("unknown attributes and marks are refused", () => {
    const ydoc = good();
    (ydoc.getXmlFragment(FRAGMENT).get(0) as Y.XmlElement).setAttribute("onclick", "x");
    expect(validate(ydoc).ok).toBe(false);
    const other = good();
    const text = (other.getXmlFragment(FRAGMENT).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.format(0, 1, { blink: {} });
    expect(validate(other).ok).toBe(false);
  });

  test("bad content is refused", () => {
    const ydoc = good();
    const list = new Y.XmlElement("bullet_list");
    list.setAttribute("id", "~bbbbbbbbbb");
    list.insert(0, [new Y.XmlText("loose text")]);
    ydoc.getXmlFragment(FRAGMENT).insert(1, [list]);
    expect(validate(ydoc).ok).toBe(false);
  });

  test("an atom the server doesn't have is refused; a copy is fine", () => {
    const hash = "a".repeat(64);
    const ydoc = docToY({
      type: "doc",
      content: [{ type: "atom", attrs: { id: "~aaaaaaaaaa", kind: "image", hash } }],
    });
    expect(validate(ydoc, undefined, { atoms: (h) => h === hash })).toEqual({ ok: true });
    expect(validate(ydoc, undefined, { atoms: () => false }).ok).toBe(false);
  });

  test("merged table cells are refused", () => {
    const cell = (colspan: number) => ({
      type: "table_cell",
      attrs: { colspan, rowspan: 1, colwidth: null, align: null },
      content: [para(null, "x")],
    });
    const ydoc = docToY({
      type: "doc",
      content: [
        { type: "table", attrs: { id: "~aaaaaaaaaa" }, content: [{ type: "table_row", content: [cell(2)] }] },
      ],
    });
    expect(validate(ydoc).ok).toBe(false);
  });

  test("touched limits the check", () => {
    const ydoc = good();
    (ydoc.getXmlFragment(FRAGMENT).get(0) as Y.XmlElement).setAttribute("onclick", "x");
    expect(validate(ydoc, new Set(["~zzzzzzzzzz"]))).toEqual({ ok: true });
  });
});

describe("attribution", () => {
  const authored = (text: string, a: string, t = 1): ProseMirrorJSON => ({
    type: "text",
    text,
    marks: [{ type: "author", attrs: { a, t } }],
  });

  test("runs are offsets into the normalized text", () => {
    const node: ProseMirrorJSON = {
      type: "paragraph",
      attrs: { id: "~aaaaaaaaaa" },
      content: [authored("  Hello   ", "a1"), authored("big\n world ", "a2", 5)],
    };
    expect(normalizedText(node)).toBe("Hello big world");
    expect(authorRuns(node)).toEqual([
      { s: 0, e: 5, a: "a1", t: 1 },
      { s: 6, e: 15, a: "a2", t: 5 },
    ]);
  });

  test("list items are spaced as the read pipeline spaces them", () => {
    const item = (text: string, a: string) => ({
      type: "list_item",
      content: [{ type: "paragraph", content: [authored(text, a)] }],
    });
    const node: ProseMirrorJSON = {
      type: "bullet_list",
      attrs: { id: "~aaaaaaaaaa", tight: true },
      content: [item("one", "a1"), item("two", "a2")],
    };
    expect(normalizedText(node)).toBe("one two");
    expect(authorRuns(node)).toEqual([
      { s: 0, e: 3, a: "a1", t: 1 },
      { s: 4, e: 7, a: "a2", t: 1 },
    ]);
  });

  test("the content hash follows the text, not the marks", () => {
    const plain = para("~aaaaaaaaaa", "Hello world");
    const marked: ProseMirrorJSON = { ...plain, content: [authored("Hello world", "a9")] };
    expect(contentHash(plain)).toBe(contentHash(marked));
    expect(contentHash(plain)).not.toBe(contentHash(para("~aaaaaaaaaa", "Hello")));
  });

  test("the author plugin marks typing, not peers' text, and survives the CRDT", () => {
    const s = EditorState.create({
      doc: editorSchema.nodeFromJSON({ type: "doc", content: [para("~aaaaaaaaaa", "")] }),
      plugins: [authorPlugin(() => "a3")],
    });
    const typed = s.applyTransaction(
      s.tr.setSelection(TextSelection.create(s.doc, 1)).insertText("Hi"),
    ).state;
    const json = typed.doc.toJSON() as ProseMirrorJSON;
    expect(json.content?.[0]?.content?.[0]?.marks?.[0]).toMatchObject({ type: "author", attrs: { a: "a3" } });
    const back = yToDoc(docToY(json));
    expect(authorRuns(back.content?.[0] as ProseMirrorJSON)).toMatchObject([{ s: 0, e: 2, a: "a3" }]);

    const remote = typed.tr.insertText("!", 3).setMeta(ySyncPluginKey, { isChangeOrigin: true });
    const after = typed.applyTransaction(remote).state.doc.toJSON() as ProseMirrorJSON;
    expect(after.content?.[0]?.content?.at(-1)?.marks ?? []).toEqual([]);
  });
});

describe("links", () => {
  test("only http, https, mailto and relative links are allowed", async () => {
    const { safeHref } = await import("../src/schema.ts");
    for (const ok of [
      "https://example.com",
      "http://x",
      "mailto:a@b.c",
      "/brain/pricing",
      "#top",
      "?q=1",
      "page",
    ])
      expect(safeHref(ok)).toBe(true);
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:x",
      "java\tscript:x",
      " javascript:x",
      "data:text/html,x",
      "vbscript:x",
    ])
      expect(safeHref(bad)).toBe(false);
  });

  test("a javascript: link arriving in an update is refused", () => {
    const ydoc = docToY({ type: "doc", content: [para("~aaaaaaaaaa", "Click me")] });
    const text = (ydoc.getXmlFragment(FRAGMENT).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.format(0, 5, { link: { href: "javascript:alert(1)", title: null } });
    expect(validate(ydoc)).toMatchObject({ ok: false });
    const fine = docToY({ type: "doc", content: [para("~aaaaaaaaaa", "Click me")] });
    ((fine.getXmlFragment(FRAGMENT).get(0) as Y.XmlElement).get(0) as Y.XmlText).format(0, 5, {
      link: { href: "https://example.com", title: null },
    });
    expect(validate(fine)).toEqual({ ok: true });
  });

  test("a pasted javascript: link stays text, and one never draws an href", () => {
    const rule = editorSchema.marks.link?.spec.parseDOM?.[0] as { getAttrs(dom: unknown): unknown };
    const dom = (href: string) => ({ getAttribute: (name: string) => (name === "href" ? href : null) });
    expect(rule.getAttrs(dom("javascript:alert(1)"))).toBe(false);
    expect(rule.getAttrs(dom("https://example.com"))).toEqual({ href: "https://example.com", title: null });
    const toDOM = editorSchema.marks.link?.spec.toDOM as (mark: unknown) => [string, Record<string, unknown>];
    expect(toDOM({ attrs: { href: "javascript:x", title: null } })[1]).not.toHaveProperty("href");
  });

  test("Markdown with a javascript: link keeps it exact, as an atom", async () => {
    const { markdownToDoc } = await import("../src/markdown.ts");
    const { doc } = markdownToDoc("[x](javascript:alert(1))\n", {
      mint: mintBlockId,
      atom: () => "a".repeat(64),
    });
    expect(doc.content?.[0]?.type).toBe("atom");
  });
});
