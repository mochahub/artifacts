import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { ARTICLE_SCHEMA } from "@artifacts/schema/sanitize";
import type { Element, ElementContent, Nodes, Root } from "hast";
import { toString as hastText } from "hast-util-to-string";
import rehypeParse from "rehype-parse";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { chartSvg } from "./chart.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();

const VERDICT = /\{(Verified|Unverified)\}/g;
const CALLOUT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/;

export type ArticleInput = {
  /** Markdown path in the bundle, for relative image paths. */
  path: string;
  source: string;
  root: string;
  /** Bundle path to blob hash. */
  blobHash(path: string): string | undefined;
  /** "page/board/frame" to the frame's 2x render hash. */
  frameHash(ref: string): string | undefined;
  /** Mermaid sources already drawn to SVG, by source text. */
  mermaid: Map<string, string>;
};

export type ArticleOutput = {
  html: string;
  blocks: { blockKey: string; contentHash: string; text: string }[];
  outline: { id: string; title: string; level: number }[];
  readingMinutes: number;
  problems: { rule: string; severity: "error" | "warning"; message: string }[];
};

/** Every ```mermaid block, so the render helper can draw them first. */
export function mermaidSources(markdown: string): string[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const sources: string[] = [];
  visit(tree, "code", (node) => {
    if (node.lang === "mermaid") sources.push(node.value);
  });
  return sources;
}

const element = (
  tagName: string,
  properties: Element["properties"],
  children: ElementContent[],
): Element => ({
  type: "element",
  tagName,
  properties,
  children,
});

const parseFragment = (html: string) => unified().use(rehypeParse, { fragment: true }).parse(html) as Root;

/** The Markdown pipeline in 05. Output is sanitized here, and again by the server. */
export function buildArticle(input: ArticleInput): ArticleOutput {
  const blocks: ArticleOutput["blocks"] = [];
  const outline: ArticleOutput["outline"] = [];
  const problems: ArticleOutput["problems"] = [];

  const directives = () => (tree: Root) => {
    visit(tree as unknown as Nodes, (node) => {
      const directive = node as unknown as {
        type: string;
        name?: string;
        attributes?: Record<string, string>;
        data?: Record<string, unknown>;
      };
      if (!directive.type.endsWith("Directive")) return;
      if (directive.name === "frame") {
        directive.data = {
          hName: "div",
          hProperties: { "data-embed": "frame", "data-ref": directive.attributes?.ref ?? "" },
        };
      } else if (directive.name === "chart") {
        directive.data = {
          hName: "div",
          hProperties: { "data-embed": "chart", "data-ref": directive.attributes?.src ?? "" },
        };
      }
    });
    visit(tree as unknown as Nodes, (node) => {
      const code = node as unknown as {
        type: string;
        lang?: string;
        value?: string;
        data?: Record<string, unknown>;
      };
      if (code.type === "code" && code.lang === "mermaid") {
        code.data = {
          hName: "div",
          hProperties: { "data-embed": "mermaid" },
          hChildren: [{ type: "text", value: code.value }],
        };
      }
    });
  };

  const decorate = () => (tree: Root) => {
    // Embeds and images, everywhere in the tree.
    visit(tree, "element", (node, index, parent) => {
      if (node.tagName === "img") {
        const src = String(node.properties.src ?? "");
        if (!/^[a-z]+:/i.test(src)) {
          const path = normalize(join(dirname(input.path), src))
            .split(sep)
            .join("/");
          const hash = input.blobHash(path);
          if (hash) node.properties.src = `artifacts:blob/${hash}`;
          else
            problems.push({
              rule: "files/missing",
              severity: "error",
              message: `${input.path}: ${src} isn't in the bundle.`,
            });
        }
      }
      const embed = node.properties["data-embed"] ?? node.properties.dataEmbed;
      if (!embed || !parent || index === undefined) return;
      const ref = String(node.properties["data-ref"] ?? node.properties.dataRef ?? "");
      if (embed === "frame") {
        const hash = input.frameHash(ref);
        if (!hash) {
          problems.push({
            rule: "files/missing",
            severity: "error",
            message: `${input.path}: no frame ${ref}.`,
          });
          return;
        }
        parent.children[index] = element("figure", { dataFrameRef: ref }, [
          element("img", { src: `artifacts:blob/${hash}`, alt: ref.split("/").at(-1) ?? ref }, []),
        ]);
      } else {
        const svg =
          embed === "chart"
            ? chartSvg(
                JSON.parse(readFileSync(join(input.root, normalize(join(dirname(input.path), ref))), "utf8")),
              )
            : input.mermaid.get(hastText(node));
        if (!svg) {
          problems.push({
            rule: "files/missing",
            severity: "error",
            message: `${input.path}: a diagram wasn't drawn.`,
          });
          return;
        }
        parent.children[index] = element("figure", {}, parseFragment(svg).children as ElementContent[]);
      }
    });

    // Figures: an image followed by an italic paragraph (05).
    const merged: Root["children"] = [];
    const children = tree.children.filter((child) => child.type !== "text" || child.value.trim() !== "");
    for (let i = 0; i < children.length; i++) {
      const node = children[i] as Root["children"][number];
      const next = children[i + 1];
      const image =
        node.type === "element" && node.tagName === "p" && node.children.length === 1
          ? node.children[0]
          : null;
      const caption =
        next?.type === "element" && next.tagName === "p" && next.children.length === 1
          ? next.children[0]
          : null;
      if (
        image?.type === "element" &&
        image.tagName === "img" &&
        caption?.type === "element" &&
        caption.tagName === "em"
      ) {
        merged.push(element("figure", {}, [image, element("figcaption", {}, caption.children)]));
        i += 1;
      } else merged.push(node);
    }
    tree.children = merged;

    // Callouts and verdicts.
    visit(tree, "element", (node) => {
      if (node.tagName !== "blockquote") return;
      const first = node.children.find((child) => child.type === "element") as Element | undefined;
      const text = first?.children[0];
      if (text?.type !== "text") return;
      const match = CALLOUT.exec(text.value);
      if (!match) return;
      text.value = text.value.slice(match[0].length);
      node.properties.dataCallout = (match[1] as string).toLowerCase();
    });
    visit(tree, "text", (node, index, parent) => {
      if (!parent || index === undefined || !VERDICT.test(node.value)) return;
      VERDICT.lastIndex = 0;
      const parts: ElementContent[] = [];
      let last = 0;
      for (const match of node.value.matchAll(VERDICT)) {
        parts.push({ type: "text", value: node.value.slice(last, match.index) });
        const word = match[1] as string;
        parts.push(element("span", { dataVerdict: word.toLowerCase() }, [{ type: "text", value: word }]));
        last = match.index + match[0].length;
      }
      parts.push({ type: "text", value: node.value.slice(last) });
      parent.children.splice(index, 1, ...parts);
      return index + parts.length;
    });

    // Block ids (05): heading slug, or <heading>/p<n> below it.
    let heading = "intro";
    let n = 0;
    const seen = new Set<string>();
    for (const node of tree.children) {
      if (node.type !== "element") continue;
      const level = /^h([1-6])$/.exec(node.tagName);
      let key: string;
      if (level) {
        key = String(node.properties.id);
        heading = key;
        n = 0;
        outline.push({ id: key, title: hastText(node), level: Number(level[1]) });
      } else {
        n += 1;
        key = `${heading}/p${n}`;
      }
      if (seen.has(key)) {
        problems.push({
          rule: "article/blocks",
          severity: "error",
          message: `${input.path}: block id "${key}" is used twice.`,
        });
      }
      seen.add(key);
      node.properties.dataBlock = key;
      const text = normalizeText(hastText(node));
      blocks.push({ blockKey: key, contentHash: sha256(text), text });
    }
  };

  const html = String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkDirective)
      .use(directives as never)
      .use(remarkRehype)
      .use(rehypeSlug)
      .use(decorate)
      .use(rehypeSanitize, ARTICLE_SCHEMA)
      .use(rehypeStringify)
      .processSync(input.source),
  );

  const words = blocks.reduce((sum, block) => sum + block.text.split(" ").length, 0);
  return { html, blocks, outline, readingMinutes: Math.max(1, Math.round(words / 220)), problems };
}
