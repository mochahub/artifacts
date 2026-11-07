import { mkdirSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import {
  Artifact,
  ArtifactLinks,
  CreateWiki,
  Slug,
  VersionBundle,
  WikiCreated,
  WikiSpace,
} from "@artifacts/schema";
import type { Client } from "../client.ts";
import type { Input } from "../command.ts";
import { CliError, type Output } from "../output.ts";
import { signedIn } from "../session.ts";
import { namedArtifact, resolveArtifact } from "../target.ts";
import { isEmpty, writeFiles } from "./library.ts";

export function wikiSummary(space: WikiSpace): string[] {
  const page = (p: WikiSpace["pages"][number]) =>
    `  ${p.slug}  ${p.title}${p.untrusted ? " [untrusted]" : ""}${p.summary ? `: ${p.summary}` : ""}${p.origin ? ` (${p.origin})` : ""}`;
  return [
    `${space.project.name} (${space.project.audience.label})`,
    "Rules",
    ...(space.rules ? [page(space.rules)] : ["  No rules page yet."]),
    "Pages",
    ...(space.pages.length ? space.pages.map(page) : ["  none"]),
    "Sources",
    ...(space.sources.length ? space.sources.map(page) : ["  none"]),
    "Garden",
    ...(space.garden.length ? space.garden.map((f) => `${f.kind} ${f.slug}: ${f.message}`) : ["  none"]),
  ];
}

export function linksSummary(links: ArtifactLinks): string[] {
  if (!links.wiki) return [];
  return [
    `Role: ${links.role}${links.untrusted ? " [untrusted]" : ""}${links.origin ? ` (${links.origin})` : ""}`,
    ...(["outgoing", "backlinks", "sources"] as const).flatMap((kind) => [
      kind === "outgoing" ? "Links" : kind === "backlinks" ? "Linked from" : "Sources",
      ...(links[kind].length
        ? links[kind].map(
            (p) =>
              `  ${p.project}/${p.slug}${p.title ? `  ${p.title}` : ""}${!p.exists ? " [wanted]" : ""}${p.untrusted ? " [untrusted]" : ""}${p.summary ? `: ${p.summary}` : ""}${p.origin ? ` (${p.origin})` : ""}`,
          )
        : ["  none"]),
    ]),
  ];
}

/** `![alt](dest "title")` and `[text](<dest>)`: the destination is group 2. */
const LINK_DEST = /(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^)\s]+)((?:\s+"[^"\n]*")?\))/g;
/** `::chart{src=dest}`: the destination is group 2. */
const CHART_SRC = /(::chart\{[^}\n]*?\bsrc=)("[^"\n]*"|'[^'\n]*'|[^\s}]+)/g;

/**
 * Points the files a page refers to at the copies beside it: they go in `<slug>/`, so a link that
 * was `img/a.png` in the bundle is `<slug>/img/a.png` from the exported page. Only a destination that
 * resolves to a file of that version's bundle changes.
 */
export function rewriteLocalFiles(markdown: string, slug: string, srcDir: string, files: Set<string>) {
  const used = new Set<string>();
  /** The bundle path a destination names, or null for anything else: an address, a fragment, another page. */
  const local = (raw: string) => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(raw)) return null;
    let path = raw.replace(/[?#].*$/, "");
    try {
      path = decodeURIComponent(path);
    } catch {}
    const resolved = posix.normalize(posix.join(srcDir, path));
    if (resolved.startsWith("..") || !files.has(resolved)) return null;
    used.add(resolved);
    return `${slug}/${resolved}`;
  };
  const rewritten = markdown
    .replace(LINK_DEST, (all, open: string, dest: string, close: string) => {
      const angled = dest.startsWith("<");
      const next = local(angled ? dest.slice(1, -1) : dest);
      if (!next) return all;
      return `${open}${angled || /[\s()]/.test(next) ? `<${next}>` : next}${close}`;
    })
    .replace(CHART_SRC, (all, open: string, dest: string) => {
      const quote = /^["']/.test(dest) ? dest[0] : "";
      const next = local(quote ? dest.slice(1, -1) : dest);
      if (!next) return all;
      const q = quote || (/[\s}]/.test(next) ? '"' : "");
      return `${open}${q}${next}${q}`;
    });
  return { markdown: rewritten, used };
}

/** Where a page's Markdown source sits in its bundle, so its relative paths can be resolved. */
const sourceDir = (manifest: Record<string, unknown>) => {
  const pages = Array.isArray(manifest.pages) ? (manifest.pages as { kind?: string; src?: string }[]) : [];
  const src = pages.find((page) => page.kind === "article")?.src;
  return src ? posix.dirname(src) : ".";
};

/** `artifacts wiki export <wiki> <dir>`: every page and source I can see, as Markdown with front matter. */
async function exportWiki(client: Client, wiki: string, dir: string, out: Output) {
  const space = WikiSpace.parse(await client.get(`/api/wikis/${wiki}`));
  const root = resolve(dir);
  if (!isEmpty(root)) throw new CliError(`${root} isn't empty. Use another folder.`);
  mkdirSync(root, { recursive: true });
  const entries = [...(space.rules ? [space.rules] : []), ...space.pages, ...space.sources];
  const cache = new Map<string, Uint8Array>();
  const skipped: { slug: string; reason: string }[] = [];
  const left: string[] = [];
  let files = 0;
  let written = 0;
  for (const entry of entries) {
    try {
      const artifact = Artifact.parse(await client.get(`/api/artifacts/by-slug/${wiki}/${entry.slug}`));
      // Both read the version the first answer named, so a checkpoint in between can't mix two versions.
      const pin = `?version=${artifact.latestVersion}`;
      const markdown = await client.text(`/api/artifacts/${artifact.id}/export.md${pin}`);
      const bundle = VersionBundle.parse(
        await client.get(`/api/library/projects/${wiki}/${entry.slug}/bundle${pin}`),
      );
      const { markdown: page, used } = rewriteLocalFiles(
        markdown,
        entry.slug,
        sourceDir(bundle.manifest),
        new Set(bundle.files.map((file) => file.path)),
      );
      const done = await writeFiles(
        join(root, entry.slug),
        bundle.files.filter((file) => used.has(file.path)),
        () => true,
        cache,
      );
      files += done.written;
      left.push(...done.skipped);
      writeFileSync(join(root, `${entry.slug}.md`), page);
      written += 1;
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      skipped.push({ slug: entry.slug, reason: error.message });
    }
  }
  const result = { wiki, dir: root, pages: written, files, skipped, left };
  out.result(result, () => {
    out.say(`✓ Exported ${written} pages and ${files} files from ${wiki} to ${root}`);
    for (const item of skipped) out.warn(`! Left out ${item.slug}: ${item.reason}`);
    if (left.length > 0) out.warn(`! Left out files: ${left.join(", ")}`);
  });
}

export async function wikiCommand(
  {
    args: { sub, target, dir },
    rest,
    flags,
    usage,
  }: Input<
    "sub" | "target" | "dir",
    { name?: string; personal?: boolean; "only-me"?: boolean; team?: string; server?: string }
  >,
  out: Output,
) {
  if (
    !target ||
    rest.length !== (sub === "export" ? 3 : 2) ||
    (sub === "export" && !dir) ||
    !["create", "show", "links", "export"].includes(sub ?? "")
  )
    throw usage();
  if (
    sub !== "create" &&
    (flags.name !== undefined ||
      flags.personal !== undefined ||
      flags["only-me"] !== undefined ||
      flags.team !== undefined)
  )
    throw usage();
  if (sub === "links") namedArtifact(target);
  else if (!Slug.safeParse(target).success) throw usage();
  if (
    sub === "create" &&
    !CreateWiki.safeParse({
      slug: target,
      name: flags.name ?? target,
      onlyMe: flags["only-me"],
      team: flags.team,
      personal: flags.personal,
    }).success
  )
    throw usage();
  const client = await signedIn(flags.server);
  if (sub === "export") return exportWiki(client, target, dir as string, out);
  if (sub === "create") {
    const result = WikiCreated.parse(
      await client.post("/api/wikis", {
        slug: target,
        name: flags.name ?? target,
        onlyMe: flags["only-me"],
        team: flags.team,
        personal: flags.personal ?? false,
      }),
    );
    return out.result(result, () => out.say(`${result.name} (${result.audience.label})\n${result.url}`));
  }
  if (sub === "show") {
    const result = WikiSpace.parse(await client.get(`/api/wikis/${target}`));
    return out.result(result, () =>
      wikiSummary(result).forEach((line) => {
        out.say(line);
      }),
    );
  }
  const artifact = await resolveArtifact(client, target);
  const result = ArtifactLinks.parse(await client.get(`/api/artifacts/${artifact.id}/links`));
  out.result(result, () =>
    linksSummary(result).forEach((line) => {
      out.say(line);
    }),
  );
}
