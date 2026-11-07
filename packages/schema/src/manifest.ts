import { z } from "zod";
import {
  BRAND_NAME_MAX,
  FONT_FORMATS,
  FONT_NAME,
  FONT_WEIGHT,
  HEX_COLOR,
  KEY_PATTERN,
  MAX_BRAND_FONTS,
  RADIUS,
  SCALE,
  SHA256_HEX,
  SLUG_PATTERN,
  SUMMARY_MAX,
  TAG_MAX,
  TAGS_MAX,
  VISIBILITIES,
  WIKI_ROLES,
  WIKI_SOURCES_MAX,
} from "./constants.ts";

/** Project slugs that would collide with viewer routes (06, "Routes"). */
export const RESERVED_SLUGS = new Set([
  "api",
  "s",
  "t",
  "join",
  "reset",
  "device",
  "sign-in",
  "settings",
  "projects",
  "activity",
  "search",
  "setup",
  "assets",
  "internal",
  "well-known",
  "favicon.ico",
  "manifest.webmanifest",
  "sw.js",
]);

export const Slug = z
  .string()
  .regex(SLUG_PATTERN, "use 1–40 characters of a-z, 0-9 and -")
  .refine((value) => !RESERVED_SLUGS.has(value), "this word is reserved");

export const Key = z.string().regex(KEY_PATTERN, "use 1–60 characters of a-z, 0-9 and -");

/** Page ids that would collide with `/:project/:artifact/<word>` routes (06, "Routes"). */
export const RESERVED_PAGE_IDS = new Set(["compare"]);
const PageId = Key.refine((value) => !RESERVED_PAGE_IDS.has(value), "this word is reserved");

/** Whether the file exists is checked by lint, which can see the bundle. */
export const RelPath = z
  .string()
  .min(1)
  .refine(
    (value) => !value.startsWith("/") && !value.split(/[\\/]/).includes(".."),
    "use a relative path inside the bundle",
  );

/**
 * A path a version may list. Anything else could climb out of the folder `artifacts pull` writes to, or
 * land in a place a tool acts on. `RelPath` is for a manifest, which lint has already resolved.
 */
export const isBundlePath = (path: string) =>
  path.length > 0 &&
  path.length <= 500 &&
  !/[\\\0]/.test(path) &&
  !path.startsWith("/") &&
  !/^[a-zA-Z]:/.test(path) &&
  path
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");

export const Hex = z.string().regex(HEX_COLOR, "use a colour like #ff9f0a");

export const Summary = z.string().trim().min(1).max(SUMMARY_MAX);
export const Tags = z.array(z.string().trim().min(1).max(TAG_MAX)).max(TAGS_MAX);

/** A font this repo knows by name, or a family the bundle ships. See `FONT_STACKS` in theme-css.ts. */
export const FontName = z.string().regex(FONT_NAME, "use a font's name");
export const Radius = z.number().min(RADIUS.min).max(RADIUS.max);
const Neutrals = z.object({ bg: Hex, card: Hex, text: Hex, muted: Hex, line: Hex }).partial().strict();
export const Theme = z.object({
  accent: Hex.optional(),
  font: FontName.optional(),
  /** Headings and big numbers. */
  display: FontName.optional(),
  /** Leaving it out means auto. */
  mode: z.enum(["light", "dark", "auto"]).optional(),
  radius: Radius.optional(),
  /** Multiplies type size in templates. */
  scale: z.number().min(SCALE.min).max(SCALE.max).optional(),
  neutrals: Neutrals.optional(),
  neutralsDark: Neutrals.optional(),
});
export type Theme = z.infer<typeof Theme>;
export const BrandFont = z.object({
  family: FontName,
  weight: z.string().regex(FONT_WEIGHT, "use a weight like 400"),
  style: z.enum(["normal", "italic"]).default("normal"),
  format: z.enum(Object.keys(FONT_FORMATS) as [keyof typeof FONT_FORMATS]),
  hash: z.string().regex(SHA256_HEX),
});
export type BrandFont = z.infer<typeof BrandFont>;
export const Brand = z.object({
  name: z.string().trim().min(1).max(BRAND_NAME_MAX),
  theme: Theme.omit({ mode: true }),
  fonts: z.array(BrandFont).max(MAX_BRAND_FONTS).default([]),
});
export type Brand = z.infer<typeof Brand>;

/** What the viewer may apply inside an article's body. 03 and 05 own the list. */
export const ArticleTheme = z.object({
  accent: Hex.optional(),
  font: FontName.optional(),
  display: FontName.optional(),
  radius: Radius.optional(),
});

export const Visibility = z.enum(VISIBILITIES);
export type Visibility = z.infer<typeof Visibility>;

export const Device = z.enum(["iphone", "ipad", "watch", "mac", "browser", "none"]);
export type Device = z.infer<typeof Device>;

export const ManifestPage = z.discriminatedUnion("kind", [
  z.object({
    id: PageId,
    kind: z.literal("article"),
    src: RelPath,
    title: z.string().optional(),
    group: z.string().optional(),
  }),
  z
    .object({
      id: PageId,
      kind: z.literal("canvas"),
      /** Server-owned native board source, in __boards/<id>.json (14). */
      native: z.literal(1).optional(),
      title: z.string().optional(),
      group: z.string().optional(),
      boards: z.array(
        z.object({ id: Key, title: z.string(), subtitle: z.string().optional(), src: RelPath }),
      ),
      styles: z.array(RelPath).default([]),
      scripts: z.array(RelPath).default([]),
    })
    .refine(
      (page) => page.native === 1 || page.boards.length > 0,
      "a canvas needs boards or a native source",
    ),
  z.object({
    id: PageId,
    kind: z.literal("prototype"),
    title: z.string().optional(),
    src: RelPath,
    device: Device.default("iphone"),
  }),
  z.object({
    id: PageId,
    kind: z.literal("gallery"),
    title: z.string().optional(),
    items: z.array(z.object({ src: RelPath, caption: z.string().optional() })),
  }),
]);
export type ManifestPage = z.infer<typeof ManifestPage>;

/**
 * What an artifact is to its wiki (SPEC 16): its role, the sources a page was written from, and for a
 * source, where it came from and whether it can be trusted. Sources are slugs in the same wiki.
 */
export const WikiMeta = z
  .object({
    role: z.enum(WIKI_ROLES).default("page"),
    sources: z.array(z.string().regex(SLUG_PATTERN, "use a source's slug")).max(WIKI_SOURCES_MAX).default([]),
    origin: z
      .string()
      .max(2000)
      .refine((value) => /^https?:\/\/\S+$/.test(value), "use an http or https address")
      .optional(),
    /** From the open web, a guest or anyone outside: agents treat what grew from it with care. */
    untrusted: z.boolean().optional(),
  })
  .strict();
export type WikiMeta = z.infer<typeof WikiMeta>;

export const Manifest = z.object({
  project: Slug,
  projectName: z.string().optional(),
  slug: Slug,
  title: z.string().min(1).max(120),
  summary: Summary.optional(),
  tags: Tags.optional(),
  visibility: Visibility.optional(),
  theme: Theme.optional(),
  /** A template's own look. Anything else wins over it: the org's brand, then `theme`. */
  templateTheme: Theme.optional(),
  backend: z.object({ src: RelPath }).optional(),
  wiki: WikiMeta.optional(),
  pages: z.array(ManifestPage).min(1),
});
export type Manifest = z.infer<typeof Manifest>;
