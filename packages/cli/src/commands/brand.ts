import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { Brand, BrandFont, BrandProposal, MAX_FONT_BYTES, OrgBrand } from "@artifacts/schema";
import { BRAND_PROMPT } from "@artifacts/schema/brand-prompt";
import { TEMPLATES } from "@artifacts/schema/templates";
import { z } from "zod";
import { detectAgent } from "../agent.ts";
import type { LocalBrand } from "../brand/cache.ts";
import { CliError, type Output, UsageError } from "../output.ts";
import { signedIn } from "./account.ts";
import { kitFiles, previewRoot, publishRoot } from "./write.ts";

const FontFile = BrandFont.omit({ hash: true, format: true }).extend({ src: z.string().min(1) });
const BrandFile = Brand.omit({ fonts: true }).extend({ fonts: z.array(FontFile).default([]) });

/** brand.json, with each font checked and hashed. Paths stay inside its folder. */
function readBrandFile(path: string | undefined): LocalBrand {
  if (!path) throw new UsageError("Name your brand file: artifacts brand preview brand.json");
  const file = resolve(path);
  if (!existsSync(file)) throw new CliError(`There's no ${path}.`);
  const parsed = BrandFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CliError(`${basename(file)} ${issue?.path.join(".")}: ${issue?.message}`);
  }
  const folder = dirname(file);
  const fontFiles = new Map<string, string>();
  const fonts = parsed.data.fonts.map(({ src, ...font }) => {
    const absolute = resolve(folder, src);
    if (!absolute.startsWith(`${folder}${sep}`) || !existsSync(absolute)) {
      throw new CliError(`Can't read ${src}. Keep fonts beside ${basename(file)}.`);
    }
    if (statSync(absolute).size > MAX_FONT_BYTES) throw new CliError(`${src} is over 4 MB.`);
    const format = extname(absolute).slice(1).toLowerCase();
    if (!["woff2", "woff", "otf", "ttf"].includes(format)) throw new CliError(`${src} isn't a font file.`);
    const hash = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    fontFiles.set(hash, absolute);
    return { ...font, format, hash };
  });
  return { ...Brand.parse({ ...parsed.data, fonts }), fontFiles };
}

/** Every template in one artifact, each in a folder of its own so their styles stay apart. */
function buildSample(brand: LocalBrand, slug: string) {
  const root = mkdtempSync(join(tmpdir(), "artifacts-brand-"));
  const pages: Record<string, unknown>[] = [];
  for (const [name, files] of Object.entries(TEMPLATES)) {
    for (const [path, body] of Object.entries(files)) {
      if (path === "artifact.json") continue;
      const target = join(root, name, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body.replaceAll('ref="cover/main/cover"', `ref="${name}-cover/main/cover"`));
    }
    const manifest = JSON.parse(files["artifact.json"] as string) as { pages: Record<string, unknown>[] };
    const local = (path: string) => (path.startsWith("vendor/") ? path : `${name}/${path}`);
    for (const page of manifest.pages) {
      pages.push({
        ...page,
        id: `${name}-${page.id}`,
        title: `${name}: ${page.title}`,
        ...(page.src ? { src: local(page.src as string) } : {}),
        ...(page.boards
          ? {
              boards: (page.boards as { src: string }[]).map((board) => ({
                ...board,
                src: local(board.src),
              })),
              styles: (page.styles as string[]).map(local),
              scripts: ((page.scripts ?? []) as string[]).map(local),
            }
          : {}),
      });
    }
  }
  for (const [path, body] of Object.entries(kitFiles())) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  writeFileSync(
    join(root, "artifact.json"),
    JSON.stringify({
      project: "brand",
      slug,
      title: `${brand.name}: brand sample`,
      summary: `The ${brand.name} brand across every template, for a person to review before applying it in Settings.`,
      tags: ["brand"],
      visibility: "org",
      theme: { mode: "light" },
      pages,
    }),
  );
  return root;
}

const sampleSlug = (brand: Brand) =>
  `sample-${createHash("sha256").update(JSON.stringify(brand)).digest("hex").slice(0, 10)}`;

export async function brandCommand(
  sub: string | undefined,
  file: string | undefined,
  flags: { server?: string },
  out: Output,
) {
  if (sub === "prompt") return out.result({ prompt: BRAND_PROMPT }, () => out.say(BRAND_PROMPT));
  if (sub === "show" || sub === undefined) {
    const client = await signedIn(flags.server);
    const { brand } = OrgBrand.parse(await client.get("/api/brand"));
    const proposals = z.array(BrandProposal).parse(await client.get("/api/brand/proposals"));
    return out.result({ brand, proposals }, () => {
      out.say(brand ? `Brand: ${brand.name}` : "No brand yet, so the default look applies.");
      if (brand) out.say(JSON.stringify(brand.theme, null, 2));
      for (const row of proposals.filter((entry) => !entry.appliedAt)) {
        out.say(
          `Waiting in Settings: ${row.name}${row.sample ? `, ${row.sample.project}/${row.sample.slug}` : ""}`,
        );
      }
    });
  }
  if (sub === "preview") {
    const brand = readBrandFile(file);
    const root = buildSample(brand, sampleSlug(brand));
    const result = await previewRoot(root, brand, out);
    return out.result(result, () => {
      for (const problem of result.problems) out.warn(`! ${problem.rule}  ${problem.message}`);
      out.say(`Look at it: ${result.contactSheet}`);
    });
  }
  if (sub === "propose") {
    const brand = readBrandFile(file);
    const client = await signedIn(flags.server);
    const slug = sampleSlug(brand);
    const root = buildSample(brand, slug);
    try {
      const published = await publishRoot(
        root,
        { message: `Sample of ${brand.name}`, notes: [] },
        client,
        out,
        brand,
      );
      const { fontFiles: _, ...plain } = brand;
      const { id } = await client.post<{ id: string }>("/api/brand/proposals", {
        brand: plain,
        project: "brand",
        slug,
        agent: detectAgent(),
      });
      return out.result({ id, url: published.url, version: published.version }, () => {
        out.say(`✓ Sample: ${published.url}`);
        out.say("  A person applies it in Settings, Brand. Nothing changes until they do.");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  throw new UsageError("Usage: artifacts brand [show] | prompt | preview <file> | propose <file>");
}
