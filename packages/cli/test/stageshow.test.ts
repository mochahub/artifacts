import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, sandbox } from "./sandbox.ts";

const SOURCE = join(import.meta.dir, "../src/skill/stageshow.ts");
const OUTPUT = join(import.meta.dir, "../src/output.ts");

/** A home with an `npx` that writes down how it was called, so nothing reaches the network. */
function box(exit = 0) {
  const { home, env } = sandbox();
  const bin = join(home, "bin");
  mkdirSync(bin);
  const log = join(home, "npx.log");
  writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "npx $*" >> "${log}"\necho "from npx"\nexit ${exit}\n`);
  chmodSync(join(bin, "npx"), 0o755);
  return { home, log, env: { ...env, PATH: `${bin}:${process.env.PATH}` } };
}

/** Runs the setup question on its own, because the rest of setup needs a server. */
async function offer(env: Record<string, string>, answer: string | null, yes = false) {
  const script = `
    import { createOutput } from ${JSON.stringify(OUTPUT)};
    import { offerStageshow } from ${JSON.stringify(SOURCE)};
    await offerStageshow(${yes}, createOutput(false));
    process.exit(0);
  `;
  const child = Bun.spawn(["bun", "-e", script], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  if (answer !== null) child.stdin.write(`${answer}\n`);
  child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

describe("Stageshow", () => {
  test("says it's third party, and an empty answer means no", async () => {
    const { env, log } = box();
    const { stdout, stderr, code } = await offer(env, "");
    expect(code).toBe(0);
    expect(stdout).toContain("third party");
    expect(stdout).toContain("https://github.com/benjitaylor/skills");
    expect(stderr).toContain("Install Stageshow? [y/N]");
    expect(existsSync(log)).toBe(false);
  });

  test("with no one to answer, nothing is installed", async () => {
    const { env, log } = box();
    expect((await offer(env, null)).code).toBe(0);
    expect(existsSync(log)).toBe(false);
  });

  test("yes installs the tested commit, and says it's third party again", async () => {
    const { env, log } = box();
    const { stdout } = await offer(env, "y");
    expect(stdout).toContain("Installing Stageshow, a third-party skill");
    const command = readFileSync(log, "utf8");
    expect(command).toMatch(/npx --yes skills@\d+\.\d+\.\d+ add benjitaylor\/skills#[0-9a-f]{40} /);
    expect(command).toContain("--skill stageshow --global --agent claude-code codex --copy --yes");
  });

  test("isn't asked again once it's there", async () => {
    const { env, log, home } = box();
    mkdirSync(join(home, ".claude/skills/stageshow"), { recursive: true });
    writeFileSync(join(home, ".claude/skills/stageshow/SKILL.md"), "---\nname: stageshow\n---\n");
    const { stdout, stderr } = await offer(env, "y");
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(existsSync(log)).toBe(false);
  });

  test("a failed install at setup warns and carries on", async () => {
    const { env } = box(1);
    const { stderr, code } = await offer(env, null, true);
    expect(code).toBe(0);
    expect(stderr).toContain("didn't install");
  });

  test("skill install --stageshow keeps --json stdout clean", async () => {
    const { env, log, home } = box();
    const result = await cli(["skill", "install", "--stageshow", "--json"], env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).installed).toContain(join(home, ".claude/skills/artifacts"));
    expect(result.stderr).toContain("third-party");
    expect(result.stderr).toContain("from npx");
    expect(existsSync(log)).toBe(true);
    expect(existsSync(join(home, ".claude/skills/artifacts/references/stageshow.md"))).toBe(true);
  });

  test("skill install --stageshow fails when it can't install", async () => {
    const { env } = box(1);
    expect((await cli(["skill", "install", "--stageshow"], env)).code).toBe(1);
  });
});
