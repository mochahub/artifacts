import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Manifest } from "@artifacts/schema";
import { CliError } from "../output.ts";

export type Problem = { rule: string; severity: "error" | "warning"; message: string; file?: string };

export const manifestPath = (root: string) => join(root, "artifact.json");

/** The nearest artifact.json from `from` upward (07). */
export function findRoot(from = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(manifestPath(dir))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new CliError("No artifact.json here or above. Run artifacts init.");
    dir = parent;
  }
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
