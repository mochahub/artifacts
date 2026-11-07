import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildArticle, mermaidSources } from "@artifacts/schema/article";
import { BLOCK_ID_PATTERN } from "@artifacts/schema/constants";
import type { AtomKind } from "@artifacts/schema/editing";
import { mintBlockId } from "../src/ids.ts";
import { docToMarkdown, markdownToDoc } from "../src/markdown.ts";
import { editorSchema, type ProseMirrorJSON } from "../src/schema.ts";
import { docToY, validate, yToDoc } from "../src/ydoc.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "editing");
const fixtures = readdirSync(FIXTURES).filter((name) => name.endsWith(".md"));

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function atomStore() {
  const atoms = new Map<string, { kind: AtomKind; source: string }>();
  return {
    atoms,
    atom(kind: AtomKind, source: string) {
      const hash = sha256(source);
      atoms.set(hash, { kind, source });
      return hash;
    },
    source: (hash: string) => atoms.get(hash)?.source ?? "",
  };
}

function html(source: string, blockIds?: string[]) {
  const mermaid = new Map(
    mermaidSources(source).map((code) => [code, `<svg><text>${code.length}</text></svg>`]),
  );
  return buildArticle({
    path: "index.md",
    source,
    project: "acme",
    readFile: () => {
      throw new Error("no files");
    },
    blobHash: (path) => sha256(path),
    frameHash: (ref) => sha256(ref),
    mermaid,
    blockIds,
  });
}

describe("round trip over fixtures/editing", () => {
  for (const name of fixtures) {
    test(name, () => {
      const source = readFileSync(join(FIXTURES, name), "utf8");
      const store = atomStore();
      const { doc, ids } = markdownToDoc(source, { mint: mintBlockId, atom: store.atom });
      expect(ids.every((id) => BLOCK_ID_PATTERN.test(id))).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      // The schema accepts it.
      editorSchema.nodeFromJSON(doc).check();

      // Markdown → doc → Y.Doc → doc → Markdown.
      const ydoc = docToY(doc);
      expect(validate(ydoc, undefined, { atoms: (hash) => store.atoms.has(hash) })).toEqual({ ok: true });
      const back = yToDoc(ydoc);
      const { markdown, blockIds } = docToMarkdown(back, store.source);
      expect(blockIds).toEqual(ids);

      // The read pipeline draws the same HTML.
      const before = html(source);
      const after = html(markdown);
      expect(after.problems).toEqual(before.problems);
      expect(after.html).toBe(before.html);

      // With the ids, every block carries its lasting id.
      const withIds = html(markdown, blockIds);
      expect(withIds.problems.filter((p) => p.rule === "article/blocks")).toEqual([]);

      // A second round trip changes nothing.
      const again = markdownToDoc(markdown, { ids: blockIds, mint: mintBlockId, atom: store.atom });
      expect(again.ids).toEqual(ids);
      expect(docToMarkdown(yToDoc(docToY(again.doc)), store.source).markdown).toBe(markdown);

      // Atoms come back byte for byte.
      for (const { source: atom } of store.atoms.values()) expect(markdown).toContain(atom);
    });
  }

  test("the atom kinds", () => {
    const source = readFileSync(join(FIXTURES, "atoms.md"), "utf8");
    const store = atomStore();
    const { doc } = markdownToDoc(source, { mint: mintBlockId, atom: store.atom });
    const kinds = (doc.content ?? []).filter((n) => n.type === "atom").map((n) => n.attrs?.kind);
    expect(kinds).toEqual([
      "image",
      "image",
      "mermaid",
      "chart",
      "frame",
      "html",
      "markdown",
      "markdown",
      "markdown",
      "markdown",
      "markdown",
      "markdown",
    ]);
    // The image and its caption are one atom: the figure the read pipeline merges.
    const figure = [...store.atoms.values()].find((atom) => atom.source.includes("flow.png"));
    expect(figure?.source).toBe(
      "![A diagram of the flow](images/flow.png)\n\n*The flow, from intake to answer.*",
    );
  });

  test("given ids are kept, and the rest minted", () => {
    const store = atomStore();
    const ids = ["~aaaaaaaaaa", "~bbbbbbbbbb"];
    const result = markdownToDoc("# A\n\nB\n\nC\n", { ids, mint: mintBlockId, atom: store.atom });
    expect(result.ids.slice(0, 2)).toEqual(ids);
    expect(result.ids[2]).toMatch(BLOCK_ID_PATTERN);
  });

  test("empty paragraphs write nothing and give no id", () => {
    const doc: ProseMirrorJSON = {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { id: "~aaaaaaaaaa" }, content: [{ type: "text", text: "One" }] },
        { type: "paragraph", attrs: { id: "~bbbbbbbbbb" } },
        { type: "paragraph", attrs: { id: "~cccccccccc" }, content: [{ type: "text", text: "Two" }] },
      ],
    };
    expect(docToMarkdown(doc, () => "")).toEqual({
      markdown: "One\n\nTwo\n",
      blockIds: ["~aaaaaaaaaa", "~cccccccccc"],
    });
  });

  test("a typed wiki link is written raw, and typed Markdown syntax is escaped", () => {
    const doc: ProseMirrorJSON = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "~aaaaaaaaaa" },
          content: [{ type: "text", text: "See [[Pricing]] and *not emphasis*" }],
        },
        {
          type: "paragraph",
          attrs: { id: "~bbbbbbbbbb" },
          content: [{ type: "text", text: "# not a heading" }],
        },
      ],
    };
    const { markdown } = docToMarkdown(doc, () => "");
    expect(markdown).toContain("[[Pricing]]");
    expect(html(markdown).html).toContain('<a href="/acme/pricing">Pricing</a>');
    expect(html(markdown).html).not.toContain("<em>");
    expect(html(markdown).html).not.toContain("<h1");
  });

  test("adjacent lists of one kind stay two lists", () => {
    const item = (text: string) => ({
      type: "list_item",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    const doc: ProseMirrorJSON = {
      type: "doc",
      content: [
        { type: "bullet_list", attrs: { id: "~aaaaaaaaaa", tight: true }, content: [item("a")] },
        { type: "bullet_list", attrs: { id: "~bbbbbbbbbb", tight: true }, content: [item("b")] },
        { type: "ordered_list", attrs: { id: "~cccccccccc", tight: true, start: 1 }, content: [item("c")] },
        { type: "ordered_list", attrs: { id: "~dddddddddd", tight: true, start: 1 }, content: [item("d")] },
      ],
    };
    const { blockIds } = docToMarkdown(doc, () => "");
    expect(blockIds).toEqual(["~aaaaaaaaaa", "~bbbbbbbbbb", "~cccccccccc", "~dddddddddd"]);
  });
});
