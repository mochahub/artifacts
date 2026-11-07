import { createHash } from "node:crypto";
import { dirname, join, normalize, sep } from "node:path";
import type { Element, ElementContent, Nodes, Root } from "hast";
import { toString as hastText } from "hast-util-to-string";
import type { RootContent as MdContent, Root as MdRoot } from "mdast";
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
import { BLOCK_ID_PATTERN } from "./constants.ts";
import { ARTICLE_SCHEMA } from "./sanitize.ts";
import { remarkWikilinks } from "./wiki.ts";

/** A stray `%` ("100%.png") isn't valid percent-encoding; it stays as written and fails as a missing file. */
export const cleanUrl = (url: string) => {
  const bare = url.trim().split(/[?#]/)[0] as string;
  try {
    return decodeURI(bare);
  } catch {
    return bare;
  }
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();

const VERDICT = /\{(Verified|Unverified)\}/g;
/** `:::stats`, `:::compare` and `:::steps` around ordinary Markdown (05). The viewer draws them. */
const COMPONENTS = new Set(["stats", "compare", "steps"]);
const CALLOUT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/;

export type ArticleInput = {
  /** Markdown path in the bundle, for relative image paths. */
  path: string;
  source: string;
  /** A chart's JSON, for a file already in the bundle. A caller with no files has none to give. */
  readFile(path: string): string;
  /** Bundle path to blob hash. */
  blobHash(path: string): string | undefined;
  /** "page/board/frame" to the frame's 2x render hash. */
  frameHash(ref: string): string | undefined;
  /** Mermaid sources already drawn to SVG, by source text. */
  mermaid: Map<string, string>;
  /** The project, so `[[Page]]` links resolve to `/<project>/<slug>` (SPEC 16). Without it they stay text. */
  project?: string;
  /**
   * An edited page's lasting block ids (13), one per group of `articleBlocks`, in order. Each becomes its
   * element's `data-block` and its blocks row's key; headings keep their slug as `id` and in the outline.
   */
  blockIds?: string[];
};

export type ArticleOutput = {
  html: string;
  blocks: { blockKey: string; contentHash: string; text: string }[];
  outline: { id: string; title: string; level: number }[];
  readingMinutes: number;
  problems: { rule: string; severity: "error" | "warning"; message: string }[];
};

/**
 * A built article as a publish records it: its page, with the hash of its HTML, and its blocks on that
 * page. The CLI and the hosted MCP both publish articles, so they make the same records.
 */
export function articleRecords(
  built: Pick<ArticleOutput, "blocks" | "outline" | "readingMinutes">,
  page: {
    id: string;
    title: string;
    group: string | null;
    position: number;
    htmlHash: string | undefined;
    theme: { accent?: string; font?: string; display?: string; radius?: number } | null;
  },
) {
  return {
    page: {
      key: page.id,
      kind: "article" as const,
      title: page.title,
      group: page.group,
      position: page.position,
      meta: {
        htmlHash: page.htmlHash,
        outline: built.outline,
        readingMinutes: built.readingMinutes,
        ...(page.theme ? { theme: page.theme } : {}),
      },
    },
    blocks: built.blocks.map((block) => ({ ...block, pageKey: page.id })),
  };
}

const soleChild = (node: MdContent | undefined, type: string) =>
  node?.type === "paragraph" && node.children.length === 1 && node.children[0]?.type === type;

/**
 * The top-level blocks of a parsed article as an editor sees them (13, "Ids in versions"): each node is
 * one block, except that an image paragraph and the italic caption after it are one, the figure the read
 * pipeline merges. `markdownToDoc` groups with this too, so ids pair with the same blocks on both sides.
 */
export function articleBlocks(root: MdRoot): MdContent[][] {
  const groups: MdContent[][] = [];
  for (let i = 0; i < root.children.length; i++) {
    const node = root.children[i] as MdContent;
    const next = root.children[i + 1];
    if (soleChild(node, "image") && soleChild(next, "emphasis")) {
      groups.push([node, next as MdContent]);
      i += 1;
    } else groups.push([node]);
  }
  return groups;
}

/** How many blocks an article's Markdown has, as `articleBlocks` groups them: one lasting id each. */
export function articleBlockCount(markdown: string): number {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkDirective).parse(markdown) as MdRoot;
  return articleBlocks(tree).length;
}

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

/**
 * The Markdown pipeline in 05, for the CLI and for articles published through the MCP. Output is
 * sanitized here, and again by the server at commit whichever way it came.
 */
export function buildArticle(input: ArticleInput): ArticleOutput {
  const blocks: ArticleOutput["blocks"] = [];
  const outline: ArticleOutput["outline"] = [];
  const problems: ArticleOutput["problems"] = [];
  const blockIds = input.blockIds;

  // Lasting ids ride on the mdast nodes, so they reach their elements through remark-rehype (13).
  const lasting = () => (tree: MdRoot) => {
    if (!blockIds) return;
    const groups = articleBlocks(tree);
    const fail = (message: string) =>
      problems.push({ rule: "article/blocks", severity: "error", message: `${input.path}: ${message}` });
    if (blockIds.length > groups.length) fail(`${blockIds.length} block ids for ${groups.length} blocks.`);
    const used = new Set<string>();
    for (const [index, group] of groups.entries()) {
      const id = blockIds[index];
      const first = group[0];
      if (id === undefined || !first) continue;
      if (!BLOCK_ID_PATTERN.test(id)) {
        fail(`block id "${id.slice(0, 40)}" isn't valid.`);
        continue;
      }
      if (used.has(id)) {
        fail(`block id "${id}" is used twice.`);
        continue;
      }
      used.add(id);
      const data = (first.data ?? {}) as { hProperties?: Record<string, unknown> };
      first.data = { ...data, hProperties: { ...data.hProperties, dataBlock: id } } as typeof first.data;
    }
  };

  const directives = () => (tree: Root) => {
    visit(tree as unknown as Nodes, (node) => {
      const directive = node as unknown as {
        type: string;
        name?: string;
        attributes?: Record<string, string>;
        data?: Record<string, unknown>;
      };
      if (!directive.type.endsWith("Directive")) return;
      if (directive.type === "containerDirective" && COMPONENTS.has(directive.name ?? "")) {
        directive.data = { hName: "div", hProperties: { dataComponent: directive.name } };
      } else if (directive.name === "frame") {
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
          // Percent-encoded, as Markdown writes it ("my%20pic.png"); the bundle has the file's own name.
          const path = normalize(join(dirname(input.path), cleanUrl(src)))
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
        parent.children[index] = element(
          "figure",
          { dataFrameRef: ref, dataBlock: node.properties.dataBlock },
          [element("img", { src: `artifacts:blob/${hash}`, alt: ref.split("/").at(-1) ?? ref }, [])],
        );
      } else {
        let svg: string | undefined;
        if (embed === "chart") {
          // Only a file the crawl let into the bundle (inside the folder, links checked) is read.
          const path = normalize(join(dirname(input.path), cleanUrl(ref)))
            .split(sep)
            .join("/");
          try {
            if (input.blobHash(path)) svg = chartSvg(JSON.parse(input.readFile(path)));
          } catch {
            // A chart file that isn't the shape ::chart wants is reported below, not a crash.
          }
        } else svg = input.mermaid.get(hastText(node));
        if (!svg) {
          problems.push({
            rule: "files/missing",
            severity: "error",
            message: `${input.path}: a diagram wasn't drawn.`,
          });
          return;
        }
        parent.children[index] = element(
          "figure",
          { dataBlock: node.properties.dataBlock },
          parseFragment(svg).children as ElementContent[],
        );
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
        merged.push(
          element("figure", { dataBlock: (node as Element).properties.dataBlock }, [
            image,
            element("figcaption", {}, caption.children),
          ]),
        );
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

    // Block ids (05): heading slug, or <heading>/p<n> below it. With lasting ids (13), an element's own
    // `data-block`, and `<last id>/x<n>` for what the pipeline adds itself, such as footnotes.
    let heading = "intro";
    let n = 0;
    const seen = new Set<string>();
    for (const node of tree.children) {
      if (node.type !== "element") continue;
      const level = /^h([1-6])$/.exec(node.tagName);
      if (level)
        outline.push({ id: String(node.properties.id), title: hastText(node), level: Number(level[1]) });
      let key: string;
      const own = node.properties.dataBlock;
      if (blockIds) {
        if (typeof own === "string" && own) {
          key = own;
          heading = own;
          n = 0;
        } else {
          n += 1;
          key = `${heading}/x${n}`;
        }
      } else if (level) {
        key = String(node.properties.id);
        heading = key;
        n = 0;
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
      .use(remarkWikilinks(input.project) as never)
      .use(lasting as never)
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
