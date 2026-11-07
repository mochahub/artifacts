import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { TEMPLATES } from "@artifacts/kit/templates";
import { SLUG_PATTERN } from "@artifacts/schema";
import { openBrowser } from "../browser.ts";
import { FIXTURES, KIT_DIR, LOCAL, MANIFEST, WORK } from "../bundle/layout.ts";
import { findRoot, loadManifest } from "../bundle/manifest.ts";
import type { Input } from "../command.ts";
import { pickServer } from "../config.ts";
import { repoRoot } from "../git.ts";
import { kitFiles, STARTERS } from "../kit.ts";
import { hasErrors, printProblems } from "../lint/problem.ts";
import { CliError, type Output, UsageError } from "../output.ts";
import { collect, publishRoot } from "../publish.ts";
import { signedIn } from "../session.ts";

export async function lintCommand({ args: { slug } }: Input<"slug">, out: Output) {
  const root = findRoot(undefined, slug);
  const { problems, rendered } = await collect(root, out, { lint: true });
  const ok = !hasErrors(problems);
  out.result({ ok, problems }, () => {
    printProblems(problems, out);
    if (rendered) {
      const articles = rendered.pages.filter((page) => page.kind === "article").length;
      out.say(`${ok ? "✓" : "✗"} lint   ${rendered.frames.length} frames, ${articles} articles`);
    }
  });
  if (!ok) process.exitCode = 1;
}

export async function renderCommand({ args: { slug } }: Input<"slug">, out: Output) {
  const root = findRoot(undefined, slug);
  const { problems, rendered } = await collect(root, out, { lint: false });
  if (!rendered) {
    printProblems(problems, out);
    throw new CliError("Fix the problems above, then render again.");
  }
  const contactSheet = rendered.frames.length > 0 ? rendered.contactSheet : null;
  out.result({ frames: rendered.frames.length, contactSheet, problems }, () => {
    printProblems(problems, out);
    out.say(`✓ render   ${rendered.frames.length} frames in WebKit at 1x, 2x and 3x`);
    if (contactSheet) out.say(`Look at it: ${contactSheet}`);
  });
}

export async function publishCommand(
  {
    args: { slug },
    flags,
  }: Input<"slug", { message?: string; name?: string; note?: string[]; server?: string }>,
  out: Output,
) {
  const root = findRoot(undefined, slug);
  const publish = { message: flags.message, name: flags.name, notes: flags.note ?? [] };
  const result = await publishRoot(root, publish, await signedIn(flags.server), out);
  out.result(result, () => {
    out.say(
      `✓ upload   ${result.uploaded.files} new files (${Math.round(result.uploaded.bytes / 1024)} KB); ${result.reused} already stored`,
    );
    out.say(`✓ v${result.version}       ${result.url}`);
    if (result.audience) out.say(`  visible to  ${result.audience}`);
    const changed = [...(result.changes.frames.changed ?? []), ...(result.changes.blocks.changed ?? [])];
    if (changed.length > 0) out.say(`  changed  ${changed.join(", ")}`);
    if (result.threadsOnChanged.length > 0) {
      out.say(`  threads on changed frames  ${result.threadsOnChanged.map((n) => `#${n}`).join(", ")}`);
    }
  });
}

/** `.artifacts/` holds renders and working folders, so it stays out of git. */
function ignoreArtifacts(root: string) {
  const ignore = join(root, ".gitignore");
  const current = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!current.split("\n").includes(`${LOCAL}/`)) {
    writeFileSync(ignore, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${LOCAL}/\n`);
  }
}

/**
 * `artifacts init` (07): a manifest, a starter page and a pinned copy of the kit. They go in the
 * gitignored working folder, because the server holds the published copy; `--in-repo` writes them here.
 */
export function initCommand(
  {
    flags: { "in-repo": inRepo, ...flags },
  }: Input<never, { project?: string; slug?: string; kind?: string; template?: string; "in-repo"?: boolean }>,
  out: Output,
) {
  if (flags.template && flags.kind) throw new UsageError("Use --template or --kind, not both.");
  const kind = (flags.kind ?? "canvas") as keyof typeof STARTERS;
  // hasOwn, so "--kind constructor" isn't taken for a starter.
  if (!Object.hasOwn(STARTERS, kind)) throw new UsageError("--kind is canvas, article or prototype.");
  const template = flags.template ? TEMPLATES[flags.template] : undefined;
  if (flags.template && (!template || !Object.hasOwn(TEMPLATES, flags.template))) {
    throw new UsageError(`--template is one of: ${Object.keys(TEMPLATES).join(", ")}.`);
  }
  const starter = STARTERS[kind];
  const slugify = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  const base = inRepo ? process.cwd() : repoRoot();
  const project = flags.project ?? (slugify(basename(base)) || "project");
  const slug = flags.slug ?? flags.template ?? "overview";
  // It becomes a folder name, and only the server's own check looks at it otherwise.
  if (!SLUG_PATTERN.test(slug)) throw new UsageError("--slug uses a-z, 0-9 and -, up to 40 characters.");
  const root = inRepo ? base : join(base, WORK, slug);
  if (existsSync(join(root, MANIFEST))) {
    throw new CliError(
      inRepo
        ? "There's already an artifact.json here."
        : `There's already an artifact called ${slug} here. Pick another --slug.`,
    );
  }
  mkdirSync(root, { recursive: true });

  if (template) {
    // Values are quoted for JSON, because a folder's name becomes the title and can hold anything.
    const quoted = (value: string) => JSON.stringify(value).slice(1, -1);
    for (const [path, body] of Object.entries(template)) {
      const target = join(root, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(
        target,
        path === MANIFEST
          ? body
              .replaceAll("{{project}}", project)
              .replaceAll("{{slug}}", slug)
              .replaceAll("{{title}}", quoted(basename(base)))
          : body,
      );
    }
  } else {
    writeFileSync(
      join(root, MANIFEST),
      `${JSON.stringify({ project, slug, title: basename(base), pages: [starter.page("main")] }, null, 2)}\n`,
    );
    mkdirSync(join(root, starter.file, ".."), { recursive: true });
    writeFileSync(join(root, starter.file), starter.body);
  }
  mkdirSync(join(root, FIXTURES), { recursive: true });
  mkdirSync(join(root, KIT_DIR), { recursive: true });
  for (const [path, body] of Object.entries(kitFiles())) writeFileSync(join(root, path), body);
  ignoreArtifacts(base);
  out.result(
    { project, slug, kind: flags.template ? "template" : kind, template: flags.template, root },
    () => {
      out.say(`✓ Wrote ${project}/${slug} in ${root}`);
      out.say(
        `  Next: ${template ? "write your own" : "add a"} "summary" in artifact.json, then artifacts render`,
      );
    },
  );
}

export async function openCommand(
  { args: { target }, flags }: Input<"target", { version?: string; page?: string; server?: string }>,
  out: Output,
) {
  const url = pickServer(flags.server);
  let path = target;
  if (!path) {
    const { manifest } = loadManifest(findRoot());
    if (!manifest) throw new CliError("artifact.json isn't valid.");
    path = `${manifest.project}/${manifest.slug}`;
  }
  const page = flags.page ? `/${flags.page}` : "";
  const link = `${url}/${path}${flags.version ? `/v/${flags.version}` : ""}${page}`;
  out.result({ url: link }, () => {
    out.say(link);
    openBrowser(link);
  });
}
