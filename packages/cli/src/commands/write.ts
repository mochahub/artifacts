import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PublishPrepared, PublishResult } from "@artifacts/schema";
import article from "../../../kit/src/article.css" with { type: "text" };
// @ts-expect-error: embedded as text
import backend from "../../../kit/src/backend.js" with { type: "text" };
// @ts-expect-error: embedded as text
import data from "../../../kit/src/data.js" with { type: "text" };
// @ts-expect-error: embedded as text
import frames from "../../../kit/src/frames/index.js" with { type: "text" };
import tokens from "../../../kit/src/tokens.css" with { type: "text" };
import { detectAgent } from "../agent.ts";
import { findRoot, loadManifest, type Problem } from "../bundle/manifest.ts";
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

async function collect(root: string, out: Output, options: { lint: boolean }) {
  const { manifest, problems } = loadManifest(root);
  if (!manifest) return { manifest: null, problems, rendered: null };
  const checked = await staticLint(root, manifest);
  problems.push(...checked.problems, ...(await projectRules(root, manifest)));
  if (hasErrors(problems)) return { manifest, problems, rendered: null };
  const rendered = render(root, manifest, checked.files, options, out);
  problems.push(...rendered.problems);
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

export async function lintCommand(out: Output) {
  const root = findRoot();
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

export async function renderCommand(out: Output) {
  const root = findRoot();
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

function gitRepo(root: string): string | null {
  const result = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (!result.success) return null;
  const match = /[:/]([^/:]+\/[^/]+?)(\.git)?\s*$/.exec(result.stdout.toString());
  return match?.[1] ?? null;
}

async function upload(missing: PublishPrepared["missing"], sources: Map<string, string>, out: Output) {
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

export async function publishCommand(flags: PublishFlags, out: Output) {
  const root = findRoot();
  const client: Client = await signedIn(flags.server);
  const { manifest, problems, rendered } = await collect(root, out, { lint: true });
  if (!manifest || !rendered || hasErrors(problems)) {
    printProblems(problems, out);
    throw new CliError("Lint found errors, so nothing was published.");
  }
  const renamed = await renamedProblems(client, manifest.project, manifest.slug, {
    frames: new Set(rendered.frames.map((frame) => frame.frameKey)),
    blocks: new Set(rendered.blocks.map((block) => `${block.pageKey}/${block.blockKey}`)),
  });
  problems.push(...(renamed as Problem[]));
  printProblems(problems, out);
  if (hasErrors(problems)) throw new CliError("Lint found errors, so nothing was published.");
  const articles = rendered.pages.filter((page) => page.kind === "article").length;
  out.say(
    `✓ lint     ${rendered.frames.length} frames, ${articles} articles, ${problems.length || "no"} problems`,
  );
  out.say(`✓ render   ${rendered.frames.length} frames in WebKit at 1x, 2x and 3x`);

  const notes: Record<string, string> = {};
  for (const note of flags.notes) {
    const split = note.indexOf("=");
    if (split < 1) throw new UsageError(`--note wants <frame>=<text>, not "${note}".`);
    notes[note.slice(0, split)] = note.slice(split + 1);
  }

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

  const prepared = PublishPrepared.parse(
    await client.post("/api/publish/prepare", {
      project: manifest.project,
      projectName: manifest.projectName,
      repo: gitRepo(root),
      slug: manifest.slug,
      title: manifest.title,
      visibility: manifest.visibility,
      files: declared,
    }),
  );
  await upload(prepared.missing, sources, out);

  const result = PublishResult.parse(
    await client.post("/api/publish/commit", {
      uploadId: prepared.uploadId,
      message: flags.message ?? null,
      name: flags.name ?? null,
      notes,
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
    }),
  );

  out.result(result, () => {
    out.say(
      `✓ upload   ${result.uploaded.files} new files (${Math.round(result.uploaded.bytes / 1024)} KB); ${result.reused} already stored`,
    );
    out.say(`✓ v${result.version}       ${result.url}`);
    const changed = [...(result.changes.frames.changed ?? []), ...(result.changes.blocks.changed ?? [])];
    if (changed.length > 0) out.say(`  changed  ${changed.join(", ")}`);
    if (result.threadsOnChanged.length > 0) {
      out.say(`  threads on changed frames  ${result.threadsOnChanged.map((n) => `#${n}`).join(", ")}`);
    }
  });
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

/** `artifacts init` (07): a manifest, a starter page and a pinned copy of the kit. */
export function initCommand(flags: { project?: string; slug?: string; kind?: string }, out: Output) {
  const root = process.cwd();
  if (existsSync(join(root, "artifact.json"))) throw new CliError("There's already an artifact.json here.");
  const kind = (flags.kind ?? "canvas") as keyof typeof STARTERS;
  const starter = STARTERS[kind];
  if (!starter) throw new UsageError("--kind is canvas, article or prototype.");
  const slugify = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  const project = flags.project ?? (slugify(basename(root)) || "project");
  const slug = flags.slug ?? "overview";

  writeFileSync(
    join(root, "artifact.json"),
    `${JSON.stringify({ project, slug, title: basename(root), pages: [starter.page("main")] }, null, 2)}\n`,
  );
  mkdirSync(join(root, starter.file, ".."), { recursive: true });
  writeFileSync(join(root, starter.file), starter.body);
  mkdirSync(join(root, "fixtures"), { recursive: true });
  mkdirSync(join(root, "vendor/artifacts-kit"), { recursive: true });
  writeFileSync(join(root, "vendor/artifacts-kit/frames.js"), frames);
  writeFileSync(join(root, "vendor/artifacts-kit/data.js"), data);
  writeFileSync(join(root, "vendor/artifacts-kit/backend.js"), backend);
  writeFileSync(join(root, "vendor/artifacts-kit/tokens.css"), tokens);
  writeFileSync(join(root, "vendor/artifacts-kit/article.css"), article);
  writeFileSync(join(root, "vendor/artifacts-kit/VERSION"), `${VERSION}\n`);

  const ignore = join(root, ".gitignore");
  const current = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!current.split("\n").includes(".artifacts/")) {
    writeFileSync(ignore, `${current}${current && !current.endsWith("\n") ? "\n" : ""}.artifacts/\n`);
  }
  out.result({ project, slug, kind }, () =>
    out.say(`✓ Wrote artifact.json for ${project}/${slug}. Next: artifacts render`),
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
