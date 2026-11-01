import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRoot, repoRoot } from "../bundle/manifest.ts";
import { requireHttps } from "../config.ts";
import { CliError, type Output } from "../output.ts";
import { collectForPublish, gitRepo, publishBody, uploadFiles } from "./write.ts";

const PACK = ".artifacts/pack";

type Pack = {
  project: string;
  projectName?: string;
  repo: string | null;
  slug: string;
  title: string;
  visibility?: string;
  payload: { sha256: string; size: number };
};

/**
 * Lint and render here, because the server never runs a browser, and write everything a connector
 * needs to a folder (07). It needs no sign-in: the hosted MCP has that.
 */
export async function packCommand(
  want: string | undefined,
  flags: { message?: string; name?: string },
  out: Output,
) {
  const root = findRoot(undefined, want);
  const { manifest, rendered } = await collectForPublish(root, out);
  const dir = join(root, PACK);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "files"), { recursive: true });
  const { declared, sources, commit } = publishBody(rendered, manifest, {
    message: flags.message,
    name: flags.name,
    notes: {},
  });
  for (const [hash, source] of sources) copyFileSync(source, join(dir, "files", hash));
  const payload = JSON.stringify({ ...commit, declared });
  const sha256 = createHash("sha256").update(payload).digest("hex");
  writeFileSync(join(dir, "files", sha256), payload);
  const pack: Pack = {
    project: manifest.project,
    ...(manifest.projectName ? { projectName: manifest.projectName } : {}),
    repo: gitRepo(repoRoot(root)),
    slug: manifest.slug,
    title: manifest.title,
    ...(manifest.visibility ? { visibility: manifest.visibility } : {}),
    payload: { sha256, size: Buffer.byteLength(payload) },
  };
  writeFileSync(join(dir, "pack.json"), JSON.stringify(pack, null, 2));
  out.result(pack, () => {
    out.say(`✓ Packed ${declared.length} files in ${dir}`);
    out.say("  Next, call artifacts_publish_prepare with:");
    out.say(JSON.stringify(pack));
  });
}

/** Uploads what a plan from artifacts_publish_prepare lists, straight to the bucket. */
export async function packUpload(want: string | undefined, plan: string, out: Output) {
  const root = findRoot(undefined, want);
  const planUrl = new URL(plan);
  requireHttps(planUrl.toString());
  const response = await fetch(planUrl, { redirect: "error" });
  if (!response.ok) throw new CliError(`Couldn't read that plan (${response.status}). It may have expired.`);
  const { missing } = (await response.json()) as {
    missing: { sha256: string; url: string; headers: Record<string, string> }[];
  };
  // A plan is text an agent passed along. Files only ever go back to where the plan itself came from.
  for (const item of missing) {
    if (new URL(item.url).origin !== planUrl.origin) throw new CliError("That plan points somewhere else.");
    if (!/^[0-9a-f]{64}$/.test(item.sha256)) throw new CliError("That plan isn't valid.");
  }
  const dir = join(root, PACK, "files");
  const sources = new Map(missing.map((item) => [item.sha256, join(dir, item.sha256)]));
  for (const [hash, path] of sources) {
    if (!existsSync(path)) throw new CliError(`This pack has no file ${hash}. Run artifacts pack again.`);
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== hash) {
      throw new CliError("A packed file changed. Run artifacts pack again.");
    }
  }
  await uploadFiles(missing, sources, out);
  out.result({ uploaded: missing.length }, () => out.say(`✓ Uploaded ${missing.length} files`));
}
