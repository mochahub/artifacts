import { Artifact, SLUG_PATTERN } from "@artifacts/schema";
import { findRoot, loadManifest } from "./bundle/manifest.ts";
import type { Client } from "./client.ts";
import { CliError, UsageError } from "./output.ts";

/** A `<project>/<slug>` argument, or the nearest artifact.json (07). */
export function artifactRef(target: string | undefined) {
  if (target) {
    const [project, slug, extra] = target.split("/");
    // Slugs are a-z, 0-9 and -, so ".." can't climb out of /api/artifacts/by-slug/ in a URL.
    if (!project || !slug || extra || ![project, slug].every((part) => SLUG_PATTERN.test(part))) {
      throw new UsageError(`Use <project>/<slug>, not "${target}".`);
    }
    return { project, slug };
  }
  const { manifest } = loadManifest(findRoot());
  if (!manifest) throw new CliError("artifact.json isn't valid. Run artifacts lint.");
  return { project: manifest.project, slug: manifest.slug };
}

/** An artifact named on the command line, never the nearest artifact.json. */
export function namedArtifact(target: string | undefined) {
  if (!target) throw new UsageError("Name an artifact: <project>/<slug>.");
  return artifactRef(target);
}

/** A version number from the command line. It lands in a URL, so only digits pass. */
export function versionNumber(value: string, what = "A version") {
  if (!/^\d+$/.test(value)) throw new UsageError(`${what} must be a number, not "${value}".`);
  return value;
}

export async function resolveArtifact(client: Client, target: string | undefined) {
  const { project, slug } = artifactRef(target);
  return Artifact.parse(await client.get(`/api/artifacts/by-slug/${project}/${slug}`));
}
