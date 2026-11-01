import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  Artifact,
  isBundlePath,
  LibraryFrames,
  LibraryPage,
  LibraryPages,
  LibraryProjects,
  LibraryRead,
  LibraryView,
  UNTRUSTED_NOTICE,
  VersionBundle,
} from "@artifacts/schema";
import { repoRoot, WORK } from "../bundle/manifest.ts";
import type { Client } from "../client.ts";
import { CliError, type Output, UsageError } from "../output.ts";
import { signedIn } from "./account.ts";
import { artifactRef, versionNumber } from "./review.ts";
import { gitRepo } from "./write.ts";

const query = (values: Record<string, string | undefined>) => {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => !!entry[1]);
  return entries.length > 0 ? `?${new URLSearchParams(entries)}` : "";
};

/** Nothing here reads an artifact.json: these work in a fresh clone, or with no repo at all. */
const namedArtifact = (target: string | undefined) => {
  if (!target) throw new UsageError("Name an artifact: <project>/<slug>.");
  return artifactRef(target);
};

function repoFlag(flags: { repo?: string; here?: boolean }) {
  if (!flags.here) return flags.repo;
  const repo = gitRepo(repoRoot());
  if (!repo) throw new CliError("This folder has no git remote called origin.");
  return repo;
}

/** The result, with the warning that what it holds came from other people. */
const data = <T extends object>(result: T) => ({ untrusted: UNTRUSTED_NOTICE, ...result });

type ListFlags = { repo?: string; here?: boolean; limit?: string; cursor?: string; server?: string };

const card = (entry: LibraryPage["cards"][number], out: Output) => {
  out.say(`${entry.project}/${entry.slug}  v${entry.latestVersion}, ${entry.title}`);
  out.say(`  ${entry.summary}`);
  const { decision, decisionVersion, openComments, archived } = entry.outcome;
  const outcome = [
    decision === "approved" ? `approved v${decisionVersion}` : "",
    decision === "changes_requested" ? `changes requested on v${decisionVersion}` : "",
    openComments > 0 ? `${openComments} open` : "",
    archived ? "archived" : "",
  ].filter(Boolean);
  if (outcome.length > 0) out.say(`  ${outcome.join(", ")}`);
  if (entry.match && entry.match.source !== "title" && entry.match.source !== "summary") {
    out.say(`  ${entry.match.source}: ${entry.match.snippet}`);
  }
};

export async function searchCommand(words: string, flags: ListFlags & { project?: string }, out: Output) {
  if (words.trim().length < 2) throw new UsageError("Usage: artifacts search <words>");
  const client = await signedIn(flags.server);
  const result = LibraryPage.parse(
    await client.get(
      `/api/library/search${query({
        q: words,
        project: flags.project,
        repo: repoFlag(flags),
        limit: flags.limit,
        cursor: flags.cursor,
      })}`,
    ),
  );
  out.result(data(result), () => {
    if (result.cards.length === 0) out.say("Nothing found.");
    for (const entry of result.cards) card(entry, out);
    if (result.nextCursor) out.say(`More: --cursor ${result.nextCursor}`);
  });
}

const PATH_PART = /^[a-z0-9-]{1,60}$/;

export async function listCommand(path: string | undefined, flags: ListFlags, out: Output) {
  const parts = path ? path.split("/") : [];
  if (parts.length > 3 || !parts.every((part) => PATH_PART.test(part))) {
    throw new UsageError("Usage: artifacts list [<project>[/<slug>[/<page>]]]");
  }
  const client = await signedIn(flags.server);
  const [project, slug, page] = parts;
  const window = query({ limit: flags.limit, cursor: flags.cursor });
  if (page) {
    const result = LibraryFrames.parse(
      await client.get(`/api/library/projects/${project}/${slug}/pages/${page}${window}`),
    );
    return out.result(data(result), () => {
      for (const frame of result.frames) {
        out.say(`${frame.key}  ${frame.title ?? ""}${frame.note ? `, ${frame.note}` : ""}`);
      }
    });
  }
  if (slug) {
    const result = LibraryPages.parse(await client.get(`/api/library/projects/${project}/${slug}${window}`));
    return out.result(data(result), () => {
      card(result.card, out);
      for (const row of result.pages) {
        const size = row.kind === "article" ? `${row.blocks} blocks` : `${row.frames} frames`;
        out.say(`  ${row.key}  ${row.kind}, ${size}${row.title ? `, ${row.title}` : ""}`);
      }
    });
  }
  if (project) {
    const result = LibraryPage.parse(await client.get(`/api/library/projects/${project}${window}`));
    return out.result(data(result), () => {
      for (const entry of result.cards) card(entry, out);
      if (result.nextCursor) out.say(`More: --cursor ${result.nextCursor}`);
    });
  }
  const result = LibraryProjects.parse(
    await client.get(
      `/api/library/projects${query({ repo: repoFlag(flags), limit: flags.limit, cursor: flags.cursor })}`,
    ),
  );
  out.result(result, () => {
    if (result.projects.length === 0) out.say("No projects you can see.");
    for (const row of result.projects) out.say(`${row.slug}  ${row.artifacts} artifacts, ${row.name}`);
    if (result.nextCursor) out.say(`More: --cursor ${result.nextCursor}`);
  });
}

export async function readCommand(
  target: string | undefined,
  flags: { page?: string; version?: string; cursor?: string; chars?: string; server?: string },
  out: Output,
) {
  const { project, slug } = namedArtifact(target);
  if (flags.version) versionNumber(flags.version, "--version");
  const client = await signedIn(flags.server);
  const result = LibraryRead.parse(
    await client.get(
      `/api/library/projects/${project}/${slug}/read${query({
        page: flags.page,
        version: flags.version,
        cursor: flags.cursor,
        chars: flags.chars,
      })}`,
    ),
  );
  out.result(data(result), () => {
    out.say(`${result.title}, v${result.version}`);
    for (const item of result.items) {
      const title = item.title ? `${item.title}: ` : "";
      if (item.text || item.title) out.say(`${title}${item.text}\n`);
    }
    if (result.nextCursor) out.say(`More: --cursor ${result.nextCursor}`);
  });
}

export async function viewCommand(
  target: string | undefined,
  flags: {
    page?: string;
    frame?: string;
    size?: string;
    version?: string;
    out?: string;
    server?: string;
  },
  out: Output,
) {
  const { project, slug } = namedArtifact(target);
  if (flags.version) versionNumber(flags.version, "--version");
  const client = await signedIn(flags.server);
  const view = LibraryView.parse(
    await client.get(
      `/api/library/projects/${project}/${slug}/view${query({
        page: flags.page,
        frame: flags.frame,
        size: flags.size,
        version: flags.version,
      })}`,
    ),
  );
  if (!view.image) throw new CliError("This artifact has no picture to show.");
  const image = await client.bytes(view.image);
  const hash = createHash("sha256").update(image).digest("hex").slice(0, 16);
  const path = flags.out ? resolve(flags.out) : join(tmpdir(), `artifacts-view-${hash}.webp`);
  writeFileSync(path, image);
  const { image: _, ...about } = view;
  out.result({ ...about, path, bytes: image.length }, () => out.say(path));
}

/** The CLI runs this file on `artifacts lint`, so a published copy must never land in a working folder. */
const EXECUTES = new Set(["lint.rules.js"]);
const isGenerated = (path: string) => path.split("/").some((part) => part.startsWith("__"));

/** Where a file from the server may land: it's another person's upload, so its path decides nothing. */
export function safeTarget(root: string, path: string) {
  if (!isBundlePath(path)) return null;
  const parts = path.split("/");
  if (EXECUTES.has(parts[parts.length - 1] as string) || parts[0] === ".artifacts") return null;
  const target = resolve(root, path);
  return target.startsWith(`${resolve(root)}${sep}`) ? target : null;
}

async function download(url: string, hash: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new CliError(`A download failed (${response.status}).`);
  const body = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(body).digest("hex") !== hash) {
    throw new CliError("A file doesn't match its hash, so nothing was kept.");
  }
  return body;
}

async function writeFiles(
  root: string,
  files: VersionBundle["files"],
  keep: (path: string) => boolean,
  cache: Map<string, Uint8Array> = new Map(),
) {
  const skipped: string[] = [];
  let written = 0;
  const queue = files.filter((file) => keep(file.path));
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const file = queue.shift();
        if (!file) return;
        const target = safeTarget(root, file.path);
        if (!target) {
          skipped.push(file.path);
          continue;
        }
        const body = cache.get(file.hash) ?? (await download(file.url, file.hash));
        cache.set(file.hash, body);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, body);
        written += 1;
      }
    }),
  );
  return { written, skipped };
}

const isEmpty = (path: string) => !existsSync(path) || readdirSync(path).length === 0;

/** Puts a published version back into a working folder (07). */
export async function pullCommand(
  target: string | undefined,
  flags: { version?: string; dir?: string; force?: boolean; server?: string },
  out: Output,
) {
  const { project, slug } = namedArtifact(target);
  if (flags.version) versionNumber(flags.version, "--version");
  const client = await signedIn(flags.server);
  const bundle = VersionBundle.parse(
    await client.get(`/api/library/projects/${project}/${slug}/bundle${query({ version: flags.version })}`),
  );
  const root = resolve(flags.dir ?? join(repoRoot(), WORK, slug));
  if (!isEmpty(root) && !flags.force) {
    throw new CliError(`${root} isn't empty. Use --force to replace it, or --dir for another folder.`);
  }
  // Built beside it, so a failed download leaves what was there.
  const building = `${root}.pulling-${process.pid}`;
  mkdirSync(building, { recursive: true });
  try {
    const { written, skipped } = await writeFiles(building, bundle.files, (path) => !isGenerated(path));
    if (bundle.rebuilt) {
      writeFileSync(join(building, "artifact.json"), `${JSON.stringify(bundle.manifest, null, 2)}\n`);
    }
    rmSync(root, { recursive: true, force: true });
    mkdirSync(dirname(root), { recursive: true });
    renameSync(building, root);
    const result = {
      project,
      slug,
      version: bundle.version,
      root,
      files: written,
      skipped,
      rebuilt: bundle.rebuilt,
    };
    out.result(result, () => {
      out.say(`✓ Pulled ${project}/${slug} v${bundle.version} into ${root}`);
      if (bundle.rebuilt) {
        out.warn(
          "! This version predates stored manifests, so artifact.json is a best guess. Check its paths.",
        );
      }
      if (skipped.length > 0) out.warn(`! Left out: ${skipped.join(", ")}`);
    });
  } finally {
    rmSync(building, { recursive: true, force: true });
  }
}

async function allCards(client: Client, project: string) {
  const cards: LibraryPage["cards"] = [];
  let cursor: string | null = null;
  do {
    const window: string = query({ limit: "50", cursor: cursor ?? undefined });
    const page = LibraryPage.parse(await client.get(`/api/library/projects/${project}${window}`));
    cards.push(...page.cards);
    cursor = page.nextCursor;
  } while (cursor);
  return cards;
}

/** Every artifact in a project that this person can see, with its history (07). */
export async function exportCommand(
  project: string | undefined,
  flags: { dir?: string; server?: string },
  out: Output,
) {
  if (!project || !/^[a-z0-9-]{1,40}$/.test(project))
    throw new UsageError("Usage: artifacts export <project>");
  const client = await signedIn(flags.server);
  const root = resolve(flags.dir ?? `${project}-export`);
  if (!isEmpty(root)) throw new CliError(`${root} isn't empty. Use --dir for another folder.`);
  const json = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  };
  const cards = await allCards(client, project);
  const cache = new Map<string, Uint8Array>();
  let versions = 0;
  const skipped: string[] = [];
  for (const entry of cards) {
    const base = join(root, entry.slug);
    const artifact = Artifact.parse(await client.get(`/api/artifacts/by-slug/${project}/${entry.slug}`));
    const history = await client.get<{ n: number }[]>(`/api/artifacts/${artifact.id}/versions`);
    json(join(base, "card.json"), entry);
    json(join(base, "versions.json"), history);
    json(join(base, "comments.json"), await client.get(`/api/artifacts/${artifact.id}/threads?status=all`));
    json(join(base, "decisions.json"), await client.get(`/api/artifacts/${artifact.id}/decisions`));
    for (const { n } of history) {
      const bundle = VersionBundle.parse(
        await client.get(
          `/api/library/projects/${project}/${entry.slug}/bundle${query({ version: String(n) })}`,
        ),
      );
      const dir = join(base, `v${n}`);
      const done = await writeFiles(dir, bundle.files, (path) => path !== "__renders", cache);
      skipped.push(...done.skipped);
      if (bundle.rebuilt) json(join(dir, "artifact.json"), bundle.manifest);
      versions += 1;
    }
  }
  const result = { project, dir: root, artifacts: cards.length, versions, skipped };
  out.result(result, () => {
    out.say(`✓ Exported ${cards.length} artifacts and ${versions} versions to ${root}`);
    if (skipped.length > 0) out.warn(`! Left out: ${skipped.join(", ")}`);
  });
}
