import type { Element, Root as HastRoot } from "hast";
import type { Link, PhrasingContent, Root, Text } from "mdast";
import rehypeParse from "rehype-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { SLUG_PATTERN, WIKI_LINKS_MAX } from "./constants.ts";
import { RESERVED_SLUGS } from "./manifest.ts";

/** `[[Target]]`, `[[Target|label]]` and `[[wiki/Target]]`, as Obsidian writes them. */
const WIKILINK = /\[\[([^[\]|\n]{1,200})(?:\|([^[\]\n]{1,200}))?\]\]/g;
const SLUG_MAX = 40;

/** The slug a page name becomes: "Pricing & Plans" is `pricing-plans`. Empty when nothing is left. */
export function wikiSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

/** Where a link's target lives: its own wiki unless it names another, as `other-wiki/Page`. */
export function wikiTarget(target: string, project: string): { project: string; slug: string } | null {
  const trimmed = target.trim();
  const slash = trimmed.indexOf("/");
  const space = slash > 0 ? trimmed.slice(0, slash).trim() : project;
  const slug = wikiSlug(slash > 0 ? trimmed.slice(slash + 1) : trimmed);
  if (!SLUG_PATTERN.test(space) || RESERVED_SLUGS.has(space) || !slug || RESERVED_SLUGS.has(slug))
    return null;
  return { project: space, slug };
}

export const wikiHref = (link: { project: string; slug: string }) => `/${link.project}/${link.slug}`;

/**
 * A remark plugin: wiki links become ordinary links to `/<wiki>/<slug>`, which the sanitizer keeps
 * (a path with no scheme) and the viewer routes in place. Code and existing links are left alone.
 */
export function remarkWikilinks(project: string | undefined) {
  return () => (tree: Root) => {
    if (!project) return;
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined || parent.type === "link" || parent.type === "linkReference") return;
      if (!node.value.includes("[[")) return;
      const parts: PhrasingContent[] = [];
      let last = 0;
      for (const match of node.value.matchAll(WIKILINK)) {
        const [whole, target = "", label] = match;
        const to = wikiTarget(target, project);
        if (!to) continue;
        const at = match.index ?? 0;
        if (at > last) parts.push({ type: "text", value: node.value.slice(last, at) });
        const text = (label ?? target).trim();
        const link: Link = { type: "link", url: wikiHref(to), children: [{ type: "text", value: text }] };
        parts.push(link);
        last = at + whole.length;
      }
      if (parts.length === 0) return;
      if (last < node.value.length) parts.push({ type: "text", value: node.value.slice(last) });
      parent.children.splice(index, 1, ...(parts as never[]));
      return index + parts.length;
    });
  };
}

const INTERNAL = /^\/([a-z0-9-]{1,40})\/([a-z0-9-]{1,40})(?:\/[^?#]*)?(?:[?#].*)?$/;

/**
 * Every artifact an article's HTML links to on this server, as `project/slug`, in order and once
 * each. The server runs this on HTML it sanitized itself, so a client can't claim links it lacks.
 */
export function articleLinks(html: string): string[] {
  const tree = unified().use(rehypeParse, { fragment: true }).parse(html) as HastRoot;
  const found = new Set<string>();
  visit(tree, "element", (node: Element) => {
    if (node.tagName !== "a" || found.size >= WIKI_LINKS_MAX) return;
    const match = INTERNAL.exec(String(node.properties.href ?? ""));
    if (!match) return;
    const [, project = "", slug = ""] = match;
    if (RESERVED_SLUGS.has(project)) return;
    found.add(`${project}/${slug}`);
  });
  return [...found];
}
