import { resolve } from "node:path";
import { normalizeRepo } from "@artifacts/schema";

const git = (args: string[], cwd: string) =>
  Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });

/** The repo this folder is in, or the folder itself: where `.artifacts/` lives. */
export function repoRoot(from = process.cwd()): string {
  const result = git(["rev-parse", "--show-toplevel"], from);
  return result.success ? result.stdout.toString().trim() : resolve(from);
}

/** This folder's git remote as `owner/name`, which is how a project is found again from another folder. */
export function gitRepo(root: string): string | null {
  const result = git(["remote", "get-url", "origin"], root);
  return result.success ? normalizeRepo(result.stdout.toString()) : null;
}
