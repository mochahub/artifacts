import { z } from "zod";

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

const SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;

export const Slug = z
  .string()
  .regex(SLUG_PATTERN, "use 1–40 characters of a-z, 0-9 and -")
  .refine((value) => !RESERVED_SLUGS.has(value), "this word is reserved");

export const Key = z.string().regex(/^[a-z0-9-]{1,60}$/, "use 1–60 characters of a-z, 0-9 and -");

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

export const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "use a colour like #ff9f0a");

export const Visibility = z.enum(["me", "org"]);
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
  z.object({
    id: PageId,
    kind: z.literal("canvas"),
    title: z.string().optional(),
    group: z.string().optional(),
    boards: z
      .array(z.object({ id: Key, title: z.string(), subtitle: z.string().optional(), src: RelPath }))
      .min(1),
    styles: z.array(RelPath).default([]),
    scripts: z.array(RelPath).default([]),
  }),
  z.object({ id: PageId, kind: z.literal("prototype"), src: RelPath, device: Device.default("iphone") }),
  z.object({
    id: PageId,
    kind: z.literal("gallery"),
    title: z.string().optional(),
    items: z.array(z.object({ src: RelPath, caption: z.string().optional() })),
  }),
]);
export type ManifestPage = z.infer<typeof ManifestPage>;

export const Manifest = z.object({
  project: Slug,
  projectName: z.string().optional(),
  slug: Slug,
  title: z.string().min(1).max(120),
  visibility: Visibility.optional(),
  theme: z
    .object({
      accent: Hex.optional(),
      font: z.string().optional(),
      mode: z.enum(["light", "dark", "auto"]).default("auto"),
    })
    .optional(),
  backend: z.object({ src: RelPath }).optional(),
  pages: z.array(ManifestPage).min(1),
});
export type Manifest = z.infer<typeof Manifest>;
