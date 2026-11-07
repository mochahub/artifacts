import { TEMPLATE_SUMMARY } from "@artifacts/kit/templates";
import { type Manifest, PublishPrepared, PublishResult, SUMMARY_MAX } from "@artifacts/schema";
import { detectAgent } from "./agent.ts";
import { type LocalBrand, loadBrand } from "./brand/cache.ts";
import { renderPath } from "./bundle/layout.ts";
import { loadManifest } from "./bundle/manifest.ts";
import type { Client } from "./client.ts";
import { gitRepo, repoRoot } from "./git.ts";
import { hasErrors, type Problem, printProblems } from "./lint/problem.ts";
import { projectRules } from "./lint/project.ts";
import { renamedProblems } from "./lint/renamed.ts";
import { staticLint } from "./lint/static.ts";
import { CliError, type Output, UsageError } from "./output.ts";
import { type RenderResult, render } from "./render/render.ts";

const MAX_FRAME_BYTES = 3 * 1024 * 1024;

/** Lint, then render if nothing stops it. `lint: false` is `render`, which lets a draft without a summary through. */
export async function collect(
  root: string,
  out: Output,
  options: { lint: boolean; brand?: LocalBrand | null },
) {
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
            message: `artifact.json has no "summary". In up to ${SUMMARY_MAX} characters, say what this holds and why it mattered: it's what a later agent reads instead of the whole artifact.`,
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
    if (bytes > MAX_FRAME_BYTES) {
      problems.push({ rule: "weight/frame", severity: "error", message: `${frame} is over 3 MB at 3x.` });
    }
  }
  return { manifest, problems, rendered };
}

/** The gate everything published goes through, with a sign-in or (for artifacts pack) without. */
export async function collectForPublish(root: string, out: Output, brand?: LocalBrand, client?: Client) {
  const { manifest, problems, rendered } = await collect(root, out, { lint: true, brand });
  if (!manifest || !rendered || hasErrors(problems)) {
    printProblems(problems, out);
    throw new CliError("Lint found errors, so nothing was published.");
  }
  if (client) {
    problems.push(
      ...(await renamedProblems(client, manifest.project, manifest.slug, {
        frames: new Set(rendered.frames.map((frame) => frame.frameKey)),
        blocks: new Set(rendered.blocks.map((block) => `${block.pageKey}/${block.blockKey}`)),
      })),
    );
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
  rendered: RenderResult,
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
    declared.push({ path: renderPath(hash), sha256: hash, size: Bun.file(source).size, type: "image/webp" });
  }
  const commit = {
    message: flags.message ?? null,
    name: flags.name ?? null,
    summary: manifest.summary,
    wiki: manifest.wiki ?? null,
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

/** Straight to the bucket, on the presigned URLs prepare handed out. */
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

function parseNotes(notes: string[]) {
  const parsed: Record<string, string> = {};
  for (const note of notes) {
    const split = note.indexOf("=");
    if (split < 1) throw new UsageError(`--note wants <frame>=<text>, not "${note}".`);
    parsed[note.slice(0, split)] = note.slice(split + 1);
  }
  return parsed;
}

export type PublishFlags = { message?: string; name?: string; notes: string[] };

export async function publishRoot(
  root: string,
  flags: PublishFlags,
  client: Client,
  out: Output,
  brand?: LocalBrand,
) {
  const { manifest, rendered, problems } = await collectForPublish(root, out, brand, client);
  const notes = parseNotes(flags.notes);
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

/** A brand's sample, rendered but not published. */
export async function previewRoot(root: string, brand: LocalBrand, out: Output) {
  const { problems, rendered } = await collect(root, out, { lint: true, brand });
  if (!rendered) {
    printProblems(problems, out);
    throw new CliError("Fix the problems above, then preview again.");
  }
  return { contactSheet: rendered.contactSheet, frames: rendered.frames.length, problems };
}
