import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "ci-paths.ts");
test("docs shortcuts require a proven cumulative documentation-only branch", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ci-paths-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd });
    expect(result.success).toBe(true);
    return result.stdout.toString().trim();
  };
  const commit = (path: string) => {
    writeFileSync(join(cwd, path), `${path}\n`);
    git("add", ".");
    git("commit", "-qm", path);
    return git("rev-parse", "HEAD");
  };
  const check = (before: string, ref = "refs/heads/topic") => {
    const result = Bun.spawnSync([process.execPath, script, before], {
      cwd,
      env: { ...process.env, GITHUB_REF: ref },
    });
    expect(result.success).toBe(true);
    return result.stdout.toString().trim();
  };
  try {
    git("init", "-q");
    git("config", "user.name", "CI regression");
    git("config", "user.email", "ci@example.invalid");
    const base = commit("README.md");
    git("update-ref", "refs/remotes/origin/main", base);
    commit("CONTRIBUTING.md");
    expect(check(base)).toBe("full=false");
    expect(check(base, "refs/heads/main")).toBe("full=true");
    const code = commit("code.ts");
    commit("FOLLOWUP.md");
    expect(check(code)).toBe("full=true");
    git("reset", "--hard", base);
    commit("DOCS.md");
    git("update-ref", "-d", "refs/remotes/origin/main");
    expect(check(base)).toBe("full=true");
    expect(check("0".repeat(40))).toBe("full=true");
    expect(check("unknown")).toBe("full=true");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
