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
  "fillOpacity",
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
// A paint is a colour word, a hex or rgb()/hsl() colour, or a reference to something in the same SVG
// (computed styles quote it: `url("#a")`).
// An allowlist, because CSS escapes (`\75rl(`) get past any test for "url(".
const PAINT =
  /^(?:none|currentColor|transparent|[a-zA-Z]{3,20}|#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%/]{1,60}\)|url\((?:"#[\w-]+"|#[\w-]+)\))$/;
// Images are bundle files only: a relative or protocol-relative `src` would load from the viewer's own origin.
const BLOB_SRC = /^artifacts:blob\/[\w-]{1,128}$/;

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
    img: [["src", BLOB_SRC], "alt", "title", "width", "height"],
    code: [["className", /^language-[\w-]+$/]],
    th: ["align", "colSpan", "rowSpan"],
    td: ["align", "colSpan", "rowSpan"],
    input: [["type", "checkbox"], ["disabled", true], "checked"],
    ...Object.fromEntries(
      SVG_TAGS.map((tag) => [
        tag,
        [
          ...SVG_ATTRIBUTES,
          ["fill", PAINT],
          ["stroke", PAINT],
          ["markerEnd", INTERNAL_URL],
          ["markerStart", INTERNAL_URL],
        ],
      ]),
    ),
  },
};

const processor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeSanitize, ARTICLE_SCHEMA)
  .use(rehypeStringify);

export const sanitizeArticle = (html: string) => String(processor.processSync(html));
