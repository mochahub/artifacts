import { defaultSchema } from "hast-util-sanitize";
import rehypeParse from "rehype-parse";
import rehypeSanitize, { type Options } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";

const SVG_TAGS = [
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "marker",
  "title",
  "desc",
];

const SVG_ATTRIBUTES = [
  "viewBox",
  "xmlns",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "dx",
  "dy",
  "d",
  "points",
  "fill",
  "fillOpacity",
  "stroke",
  "strokeWidth",
  "strokeOpacity",
  "strokeDasharray",
  "strokeLinecap",
  "strokeLinejoin",
  "opacity",
  "transform",
  "textAnchor",
  "dominantBaseline",
  "fontSize",
  "fontFamily",
  "fontWeight",
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "refX",
  "refY",
  "orient",
  "role",
  "ariaLabel",
];

const INTERNAL_URL = /^url\(#[\w-]+\)$/;

/**
 * The article allowlist (05). The CLI uses it to build articles and the server re-applies it at
 * commit, because the CLI can't be trusted. No script, style, iframe, foreignObject or event
 * attributes; images only as `artifacts:blob/<hash>`, which the viewer maps to the render route.
 */
export const ARTICLE_SCHEMA: Options = {
  ...defaultSchema,
  // Heading slugs stay as ids, and markers need theirs for url(#…). The viewer reads no globals by id.
  clobber: ["name"],
  clobberPrefix: "",
  tagNames: [...(defaultSchema.tagNames ?? []), "figure", "figcaption", "mark", ...SVG_TAGS],
  strip: ["script", "style", "foreignObject"],
  protocols: { href: ["http", "https", "mailto"], src: ["artifacts"], cite: ["http", "https"] },
  attributes: {
    ...defaultSchema.attributes,
    "*": ["id", "ariaHidden", "dataBlock", "dataVerdict", "dataCallout", "dataFrameRef"],
    a: ["href", "title"],
    img: ["src", "alt", "title", "width", "height"],
    code: [["className", /^language-[\w-]+$/]],
    th: ["align", "colSpan", "rowSpan"],
    td: ["align", "colSpan", "rowSpan"],
    input: [["type", "checkbox"], ["disabled", true], "checked"],
    ...Object.fromEntries(
      SVG_TAGS.map((tag) => [
        tag,
        [...SVG_ATTRIBUTES, ["markerEnd", INTERNAL_URL], ["markerStart", INTERNAL_URL]],
      ]),
    ),
  },
};

const processor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeSanitize, ARTICLE_SCHEMA)
  .use(rehypeStringify);

export const sanitizeArticle = (html: string) => String(processor.processSync(html));
