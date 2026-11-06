import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import child from "../../../sandbox/src/child.js" with { type: "text" };
import host from "../../../sandbox/src/host.js" with { type: "text" };
import prelude from "../../../sandbox/src/prelude.js" with { type: "text" };
import { asBun } from "../bun.ts";
import { home } from "../config.ts";
import { CliError, type Output } from "../output.ts";
import helper from "./helper.mjs" with { type: "text" };

const PACKAGES = ["playwright-core@1.64.1", "sharp@0.35.5", "mermaid@12.2.0", "quickjs-emscripten@0.32.0"];

export const helperDir = () => process.env.ARTIFACTS_HELPER_DIR ?? join(home(), ".artifacts/playwright");

const marker = (dir: string) => join(dir, ".installed");

/** WebKit and the image tools are installed, at the versions this CLI pins. */
export function helperInstalled(dir = helperDir()) {
  return existsSync(marker(dir)) && readFileSync(marker(dir), "utf8") === PACKAGES.join("\n");
}

/** Installs Playwright, sharp, Mermaid and the helper on first use. */
export function ensureHelper(out: Output): string {
  const dir = helperDir();
  mkdirSync(dir, { recursive: true });
  // Only when changed: another process may be starting one of these right now.
  for (const [name, text] of [
    ["render.mjs", helper],
    ["sandbox-child.js", child],
    ["sandbox-prelude.js", prelude],
    ["sandbox-host.js", host],
  ] as const) {
    const path = join(dir, name);
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text);
  }
  if (helperInstalled(dir)) return dir;

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
  writeFileSync(marker(dir), PACKAGES.join("\n"));
  return dir;
}
