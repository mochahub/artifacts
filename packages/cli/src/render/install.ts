import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "../config.ts";
import { CliError, type Output } from "../output.ts";
// @ts-expect-error: embedded as text
import helper from "./helper.mjs" with { type: "text" };

const PACKAGES = ["playwright-core@1.64.1", "sharp@0.35.5", "mermaid@12.2.0"];

export const helperDir = () => process.env.ARTIFACTS_HELPER_DIR ?? join(home(), ".artifacts/playwright");

/** Spawns this binary as Bun (07), so nobody needs Bun or Node installed. */
export function asBun(args: string[], cwd: string, env: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, ...args], {
    cwd,
    env: { ...process.env, BUN_BE_BUN: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Installs Playwright, sharp, Mermaid and the helper on first use. */
export function ensureHelper(out: Output): string {
  const dir = helperDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "render.mjs"), helper);
  if (existsSync(join(dir, ".installed"))) return dir;

  out.say("First render: installing WebKit and the image tools. This takes a minute.");
  if (!existsSync(join(dir, "package.json"))) writeFileSync(join(dir, "package.json"), '{"private":true}\n');
  const add = asBun(["add", ...PACKAGES], dir);
  if (!add.success) throw new CliError(`Installing the renderer failed:\n${add.stderr.toString()}`);
  const browser = asBun(["node_modules/playwright-core/cli.js", "install", "webkit"], dir);
  if (!browser.success) {
    const hint =
      process.platform === "linux"
        ? `\nWebKit needs system libraries, once, as root:\n  sudo env BUN_BE_BUN=1 ${process.execPath} ${dir}/node_modules/playwright-core/cli.js install-deps webkit`
        : "";
    throw new CliError(`Installing WebKit failed:\n${browser.stderr.toString()}${hint}`);
  }
  writeFileSync(join(dir, ".installed"), PACKAGES.join("\n"));
  return dir;
}
