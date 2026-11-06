/** Spawns this binary as Bun (07), so nobody needs Bun or Node installed. */
export function asBun(args: string[], cwd: string, env: Record<string, string> = {}) {
  // What runs here is npm packages and the page code they render, which have no use for the token.
  const { ARTIFACTS_TOKEN: _token, ...rest } = process.env;
  return Bun.spawnSync([process.execPath, ...args], {
    cwd,
    env: { ...rest, BUN_BE_BUN: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}
