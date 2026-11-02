import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Manifest, normalizeRepo, PublishPrepared, PublishResult } from "@artifacts/schema";
import { TEMPLATE_SUMMARY, TEMPLATES } from "@artifacts/schema/templates";
import article from "../../../kit/src/article.css" with { type: "text" };
// @ts-expect-error: embedded as text
import backend from "../../../kit/src/backend.js" with { type: "text" };
import components from "../../../kit/src/components.css" with { type: "text" };
// @ts-expect-error: embedded as text
import data from "../../../kit/src/data.js" with { type: "text" };
// @ts-expect-error: embedded as text
import frames from "../../../kit/src/frames/index.js" with { type: "text" };
// @ts-expect-error: embedded as text
import icons from "../../../kit/src/icons.js" with { type: "text" };
import tokens from "../../../kit/src/tokens.css" with { type: "text" };
import { detectAgent } from "../agent.ts";
import { type LocalBrand, loadBrand } from "../brand/cache.ts";
import { findRoot, loadManifest, type Problem, repoRoot, WORK } from "../bundle/manifest.ts";
import type { Client } from "../client.ts";
import { staticLint } from "../lint/static.ts";
import { CliError, type Output, UsageError } from "../output.ts";
import { render } from "../render/render.ts";
import { VERSION } from "../version.ts";
import { signedIn } from "./account.ts";
import { renamedProblems } from "./review.ts";

function printProblems(problems: Problem[], out: Output) {
  for (const problem of problems) {
    out.warn(`${problem.severity === "error" ? "✗" : "!"} ${problem.rule}  ${problem.message}`);
  }
}

const hasErrors = (problems: Problem[]) => problems.some((problem) => problem.severity === "error");

/** Project-specific rules from lint.rules.js beside the manifest (07). */
async function projectRules(root: string, manifest: unknown): Promise<Problem[]> {
  const path = join(root, "lint.rules.js");
  if (!existsSync(path)) return [];
  const { default: rules } = (await import(path)) as {
    default: {
      id: string;
      severity: Problem["severity"];
      check(ctx: unknown): string[] | Promise<string[]>;
    }[];
  };
  const problems: Problem[] = [];
  for (const rule of rules) {
    for (const message of await rule.check({ root, manifest })) {
      problems.push({ rule: rule.id, severity: rule.severity, message });
    }
  }
  return problems;
}

async function collect(root: string, out: Output, options: { lint: boolean; brand?: LocalBrand | null }) {
  const { manifest, problems } = loadManifest(root);
  if (!manifest) return { manifest: null, problems, rendered: null };
  const checked = await staticLint(root, manifest);
  problems.push(...checked.problems, ...(await projectRules(root, manifest)));
  // After the render check: a missing summary shouldn't stop someone looking at the contact sheet.
  const summary: Problem[] =
    options.lint && !manifest.summary
      ? [
          {
            rule: "manifest/summary",
            severity: "error",
            message:
              'artifact.json has no "summary". In up to 280 characters, say what this holds and why it mattered: it\'s what a later agent reads instead of the whole artifact.',
          },
        ]
      : [];
  if (hasErrors(problems)) return { manifest, problems: [...problems, ...summary], rendered: null };
  const brand = options.brand === undefined ? await loadBrand(out) : options.brand;
  const rendered = render(root, manifest, checked.files, { ...options, brand }, out);
  problems.push(...rendered.problems, ...summary);
  const weights = new Map<string, number>();
  for (const frame of rendered.frames)
    weights.set(frame.frameKey, Bun.file(rendered.renders.get(frame.renders["3x"]) ?? "").size);
  for (const [frame, bytes] of weights) {
    if (bytes > 3 * 1024 * 1024) {
      problems.push({ rule: "weight/frame", severity: "error", message: `${frame} is over 3 MB at 3x.` });
    }
  }
  return { manifest, problems, rendered };
}

export async function lintCommand(want: string | undefined, out: Output) {
  const root = findRoot(undefined, want);
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

export async function renderCommand(want: string | undefined, out: Output) {
  const root = findRoot(undefined, want);
  const { problems, rendered } = await collect(root, out, { lint: false });
  if (!rendered) {
    printProblems(problems, out);
    throw new CliError("Fix the problems above, then render again.");
  }
  out.result({ frames: rendered.frames.length, contactSheet: rendered.contactSheet, problems }, () => {
    printProblems(problems, out);
    out.say(`✓ render   ${rendered.frames.length} frames in WebKit at 1x, 2x and 3x`);
    out.say(`Look at it: ${rendered.contactSheet}`);
  });
}

/** This folder's git remote as `owner/name`, which is how a project is found again from another folder. */
export function gitRepo(root: string): string | null {
  const result = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
  });
  return result.success ? normalizeRepo(result.stdout.toString()) : null;
}

export async function uploadFiles(
  missing: PublishPrepared["missing"],
  sources: Map<string, string>,
  out: Output,
) {
  const queue = [...missing];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const source = sources.get(item.sha256);
        if (!source) throw new CliError(`Nothing to upload for ${item.sha256}.`);
        for (let attempt = 1; ; attempt++) {
          const response = await fetch(item.url, {
            method: "PUT",
            headers: item.headers,
            body: Bun.file(source),
          }).catch(() => null);
          // 412: the object is already there, and commit decides whether its content is right (05).
          if (response?.ok || response?.status === 412) break;
          if (attempt === 3) {
            throw new CliError(`Uploading a file failed (${response?.status ?? "no connection"}).`);
          }
          out.warn("Retrying an upload.");
          await Bun.sleep(500 * 2 ** attempt);
        }
      }
    }),
  );
}

export type PublishFlags = { message?: string; name?: string; notes: string[]; server?: string };

export async function publishCommand(want: string | undefined, flags: PublishFlags, out: Output) {
  const root = findRoot(undefined, want);
  const result = await publishRoot(root, flags, await signedIn(flags.server), out);
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

/** A brand's sample, rendered but not published. */
export async function previewRoot(root: string, brand: LocalBrand, out: Output) {
  const { problems, rendered } = await collect(root, out, { lint: true, brand });
  if (!rendered) {
    printProblems(problems, out);
    throw new CliError("Fix the problems above, then preview again.");
  }
  return { contactSheet: rendered.contactSheet, frames: rendered.frames.length, problems };
}

/** Lint, render, upload and commit one folder. */
export async function publishRoot(
  root: string,
  flags: PublishFlags,
  client: Client,
  out: Output,
  brand?: LocalBrand,
) {
  const { manifest, rendered, problems } = await collectForPublish(root, out, brand, client);
  const notes: Record<string, string> = {};
  for (const note of flags.notes) {
    const split = note.indexOf("=");
    if (split < 1) throw new UsageError(`--note wants <frame>=<text>, not "${note}".`);
    notes[note.slice(0, split)] = note.slice(split + 1);
  }
  const articles = rendered.pages.filter((page) => page.kind === "article").length;
  out.say(
    `✓ lint     ${rendered.frames.length} frames, ${articles} articles, ${problems.length || "no"} problems`,
  );
  out.say(`✓ render   ${rendered.frames.length} frames in WebKit at 1x, 2x and 3x`);

  const { declared, sources, commit } = publishBody(rendered, manifest, { ...flags, notes });
  const prepared = PublishPrepared.parse(
    await client.post("/api/publish/prepare", {
      project: manifest.project,
      projectName: manifest.projectName,
      repo: gitRepo(repoRoot(root)),
      slug: manifest.slug,
      title: manifest.title,
      visibility: manifest.visibility,
      files: declared,
    }),
  );
  await uploadFiles(prepared.missing, sources, out);
  return PublishResult.parse(
    await client.post("/api/publish/commit", { uploadId: prepared.uploadId, ...commit }),
  );
}

type Rendered = NonNullable<Awaited<ReturnType<typeof collect>>["rendered"]>;

/** The gate everything published goes through, with a sign-in or (for artifacts pack) without. */
export async function collectForPublish(root: string, out: Output, brand?: LocalBrand, client?: Client) {
  const { manifest, problems, rendered } = await collect(root, out, { lint: true, brand });
  if (!manifest || !rendered || hasErrors(problems)) {
    printProblems(problems, out);
    throw new CliError("Lint found errors, so nothing was published.");
  }
  if (client) {
    const renamed = await renamedProblems(client, manifest.project, manifest.slug, {
      frames: new Set(rendered.frames.map((frame) => frame.frameKey)),
      blocks: new Set(rendered.blocks.map((block) => `${block.pageKey}/${block.blockKey}`)),
    });
    problems.push(...(renamed as Problem[]));
  }
  if (manifest.summary === TEMPLATE_SUMMARY) {
    problems.push({
      rule: "manifest/summary",
      severity: "warning",
      message: "The summary is still the template's. It's what a later agent reads, so write your own.",
    });
  }
  printProblems(problems, out);
  if (hasErrors(problems)) throw new CliError("Lint found errors, so nothing was published.");
  return { manifest, problems, rendered };
}

/** What a publish declares and commits: the same whether the CLI or a connector sends it. */
export function publishBody(
  rendered: Rendered,
  manifest: Manifest,
  flags: { message?: string; name?: string; notes: Record<string, string> },
) {
  const sources = new Map<string, string>();
  const declared: { path: string; sha256: string; size: number; type: string }[] = [];
  for (const file of rendered.files.values()) {
    sources.set(file.hash, file.source);
    declared.push({ path: file.path, sha256: file.hash, size: file.size, type: file.type });
  }
  for (const [hash, source] of rendered.renders) {
    if (sources.has(hash)) continue;
    sources.set(hash, source);
    declared.push({
      path: `__renders/${hash}.webp`,
      sha256: hash,
      size: Bun.file(source).size,
      type: "image/webp",
    });
  }
  const commit = {
    message: flags.message ?? null,
    name: flags.name ?? null,
    summary: manifest.summary,
    tags: manifest.tags,
    notes: flags.notes,
    agent: detectAgent(),
    files: Object.fromEntries(
      [...rendered.files.values()].map((file) => [
        file.path,
        { hash: file.hash, size: file.size, type: file.type },
      ]),
    ),
    backendHash: rendered.backendHash,
    pages: rendered.pages,
    frames: rendered.frames,
    blocks: rendered.blocks,
  };
  return { declared, sources, commit };
}

const STARTERS = {
  canvas: {
    page: (id: string) => ({
      id,
      kind: "canvas",
      boards: [{ id: "main", title: "Main", src: "boards/main.html" }],
      styles: ["vendor/artifacts-kit/tokens.css"],
      scripts: ["vendor/artifacts-kit/frames.js"],
    }),
    file: "boards/main.html",
    body: `<a-phone data-frame="welcome" data-title="Welcome">
  <main class="art-safe" style="padding-inline:20px">
    <h1 class="art-title">Welcome</h1>
  </main>
</a-phone>
`,
  },
  article: {
    page: (id: string) => ({ id, kind: "article", src: "README.md" }),
    file: "README.md",
    body: "# Title\n\nWrite the plan here.\n",
  },
  prototype: {
    page: (id: string) => ({ id, kind: "prototype", src: "index.html" }),
    file: "index.html",
    body: "<!doctype html>\n<title>Prototype</title>\n<h1>Prototype</h1>\n",
  },
} as const;

/** The kit, as `init` copies it. */
export const kitFiles = (): Record<string, string> => ({
  "vendor/artifacts-kit/frames.js": frames,
  "vendor/artifacts-kit/data.js": data,
  "vendor/artifacts-kit/backend.js": backend,
  "vendor/artifacts-kit/icons.js": icons,
  "vendor/artifacts-kit/tokens.css": tokens,
  "vendor/artifacts-kit/components.css": components,
  "vendor/artifacts-kit/article.css": article,
  "vendor/artifacts-kit/VERSION": `${VERSION}\n`,
});

/** `.artifacts/` holds renders and working folders, so it stays out of git. */
function ignoreArtifacts(root: string) {
  const ignore = join(root, ".gitignore");
  const current = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!current.split("\n").includes(".artifacts/")) {
    writeFileSync(ignore, `${current}${current && !current.endsWith("\n") ? "\n" : ""}.artifacts/\n`);
  }
}

/**
 * `artifacts init` (07): a manifest, a starter page and a pinned copy of the kit. They go in the
 * gitignored working folder, because the server holds the published copy; `--in-repo` writes them here.
 */
export function initCommand(
  flags: { project?: string; slug?: string; kind?: string; template?: string; inRepo?: boolean },
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
  const base = flags.inRepo ? process.cwd() : repoRoot();
  const project = flags.project ?? (slugify(basename(base)) || "project");
  const slug = flags.slug ?? flags.template ?? "overview";
  // It becomes a folder name, and only the server's own check looks at it otherwise.
  if (!/^[a-z0-9-]{1,40}$/.test(slug))
    throw new UsageError("--slug uses a-z, 0-9 and -, up to 40 characters.");
  const root = flags.inRepo ? base : join(base, WORK, slug);
  if (existsSync(join(root, "artifact.json"))) {
    throw new CliError(
      flags.inRepo
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
        path === "artifact.json"
          ? body
              .replaceAll("{{project}}", project)
              .replaceAll("{{slug}}", slug)
              .replaceAll("{{title}}", quoted(basename(base)))
          : body,
      );
    }
  } else {
    writeFileSync(
      join(root, "artifact.json"),
      `${JSON.stringify({ project, slug, title: basename(base), pages: [starter.page("main")] }, null, 2)}\n`,
    );
    mkdirSync(join(root, starter.file, ".."), { recursive: true });
    writeFileSync(join(root, starter.file), starter.body);
  }
  mkdirSync(join(root, "fixtures"), { recursive: true });
  mkdirSync(join(root, "vendor/artifacts-kit"), { recursive: true });
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
  target: string | undefined,
  flags: { version?: string; page?: string; server?: string },
  out: Output,
) {
  const { pickServer } = await import("../config.ts");
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
    const command = process.platform === "darwin" ? "open" : "xdg-open";
    if (!process.env.ARTIFACTS_NO_BROWSER) Bun.spawn([command, link], { stdout: "ignore", stderr: "ignore" });
  });
}
