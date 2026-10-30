import type { Deps } from "./deps.ts";

const SIX_HOURS = 6 * 3600_000;
let cached: { at: number; version: string | null } | null = null;

/** The newest release, for the admin's "new version" notice. Unknown when GitHub can't say. */
export async function latestRelease(deps: Deps) {
  const repo = deps.env.githubReleasesRepo;
  if (!repo) return null;
  const now = deps.clock.now().getTime();
  if (cached && now - cached.at < SIX_HOURS) return cached.version;
  const version = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(3000),
  })
    .then(async (response) => {
      if (!response.ok) return null;
      return ((await response.json()) as { tag_name?: string }).tag_name?.replace(/^v/, "") ?? null;
    })
    .catch(() => null);
  cached = { at: now, version };
  return version;
}
