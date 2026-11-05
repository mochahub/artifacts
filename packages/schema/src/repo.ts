/**
 * A git remote as `owner/name`, lowercased, with any credentials gone: the form `projects.repo` has
 * always held. SSH, HTTPS, `ssh://` and scp-style remotes of one repository all come out the same.
 */
export function normalizeRepo(remote: string | null | undefined): string | null {
  const value = remote?.trim();
  if (!value) return null;
  // scp-style (git@host:owner/name.git) has no scheme, so the path starts after the colon.
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  const path = scheme
    ? value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "")
    : value.includes(":")
      ? value.slice(value.indexOf(":") + 1)
      : value;
  const parts = path
    .split(/[?#]/)[0]
    ?.replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (!parts || parts.length < 2) return null;
  const repo = parts.slice(-2).join("/").toLowerCase();
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
}
