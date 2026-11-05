import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Manifest } from "@artifacts/schema";
import { CliError } from "../output.ts";

export type Problem = { rule: string; severity: "error" | "warning"; message: string; file?: string };

export const manifestPath = (root: string) => join(root, "artifact.json");

export const WORK = ".artifacts/work";

/** The repo this folder is in, or the folder itself: where `.artifacts/` lives. */
export function repoRoot(from = process.cwd()): string {
  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd: from,
    stdout: "pipe",
    stderr: "ignore",
  });
  return result.success ? result.stdout.toString().trim() : resolve(from);
}

/** Every working folder in the nearest `.artifacts/work/`, from `from` upward. */
export function workFolders(from = process.cwd()): string[] {
  let dir = resolve(from);
  for (;;) {
    const work = join(dir, WORK);
    if (existsSync(work)) {
      return readdirSync(work)
        .map((name) => join(work, name))
        .filter((path) => existsSync(manifestPath(path)))
        .sort();
    }
    const parent = dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }
}

/**
 * The nearest artifact.json from `from` upward (07). New artifacts live in the gitignored working
 * folder, so with none on the way up, a single working folder is the answer. `want` picks one of
 * several by slug, or by project/slug.
 */
export function findRoot(from = process.cwd(), want?: string): string {
  if (!want) {
    let dir = resolve(from);
    for (;;) {
      if (existsSync(manifestPath(dir))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const folders = workFolders(from);
  const slug = want?.split("/").pop();
  const matching = want ? folders.filter((path) => path.split("/").pop() === slug) : folders;
  if (matching.length === 1) return matching[0] as string;
  if (want) throw new CliError(`There's no working folder for ${want} in ${WORK}.`);
  if (matching.length > 1) {
    const names = matching.map((path) => path.split("/").pop()).join(", ");
    throw new CliError(`There are several artifacts here: ${names}. Name one, or cd into its folder.`);
  }
  throw new CliError("No artifact.json here or above. Run artifacts init.");
}

export function loadManifest(root: string): { manifest: Manifest | null; problems: Problem[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath(root), "utf8"));
  } catch (error) {
    return {
      manifest: null,
      problems: [
        { rule: "manifest/schema", severity: "error", message: `artifact.json: ${(error as Error).message}` },
      ],
    };
  }
  const parsed = Manifest.safeParse(raw);
  if (parsed.success) return { manifest: parsed.data, problems: [] };
  return {
    manifest: null,
    problems: parsed.error.issues.map((issue) => ({
      rule: "manifest/schema",
      severity: "error",
      message: `artifact.json ${issue.path.join(".")}: ${issue.message}`,
    })),
  };
}
