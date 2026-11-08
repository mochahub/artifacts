// Fail closed: only documentation-only branch pushes may omit executable checks.
// Main always validates its merged SHA before workflow_run can release it.
const before = process.argv[2];
let full = true;
if (
  process.env.GITHUB_REF !== "refs/heads/main" &&
  before &&
  /^[a-f0-9]{40}$/.test(before) &&
  !/^0+$/.test(before)
) {
  // Compare the whole branch, not just the last push: a docs follow-up must
  // never hide an earlier executable change (including a cancelled/failed run).
  const base = Bun.spawnSync(["git", "merge-base", "origin/main", "HEAD"]);
  const sha = base.stdout.toString().trim();
  const diff =
    base.success && /^[a-f0-9]{40}$/.test(sha)
      ? Bun.spawnSync(["git", "diff", "--name-only", "-z", "--no-renames", sha, "HEAD"])
      : undefined;
  if (diff?.success) {
    const paths = diff.stdout.toString().split("\0").filter(Boolean);
    full = paths.length === 0 || paths.some((path) => !isDocumentation(path));
  }
}
console.log(`full=${full}`);

function isDocumentation(path: string): boolean {
  // Never generalize this to all Markdown: skill/templates ship executable product content.
  return /^[^/]+\.md$/.test(path) || /^docs\/.+\.md$/.test(path);
}
