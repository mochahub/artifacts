import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { home, pickServer } from "../config.ts";
import { CliError, type Output, UsageError } from "../output.ts";

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** A `[mcp_servers.artifacts]` block, replacing any there was. Everything else in the file stays. */
export function codexConfig(current: string, url: string, tokenEnv?: string) {
  const block = [
    "[mcp_servers.artifacts]",
    `url = ${JSON.stringify(url)}`,
    ...(tokenEnv ? [`bearer_token_env_var = ${JSON.stringify(tokenEnv)}`] : []),
  ].join("\n");
  const lines = current.split("\n");
  const start = lines.findIndex((line) => line.trim() === "[mcp_servers.artifacts]");
  if (start < 0) return `${current}${current && !current.endsWith("\n") ? "\n\n" : ""}${block}\n`;
  const after = lines.findIndex((line, i) => i > start && line.trim().startsWith("["));
  const end = after < 0 ? lines.length : after;
  return [...lines.slice(0, start), block, ...(after < 0 ? [] : ["", ...lines.slice(end)])].join("\n");
}

/**
 * `artifacts mcp install` (07): opt-in, because the skill and a connector side by side give an agent
 * every tool twice. Claude Code owns its config, so its own command writes it.
 */
export function mcpInstall(
  flags: { claude?: boolean; codex?: boolean; tokenEnv?: string; server?: string },
  out: Output,
) {
  if (flags.tokenEnv && !ENV_NAME.test(flags.tokenEnv)) {
    throw new UsageError("--token-env wants the name of an environment variable.");
  }
  const url = `${pickServer(flags.server)}/api/mcp`;
  const both = !flags.claude && !flags.codex;
  const done: string[] = [];
  if (flags.claude || both) {
    const header = flags.tokenEnv ? ["--header", `Authorization: Bearer \${${flags.tokenEnv}}`] : [];
    const args = ["claude", "mcp", "add", "--transport", "http", ...header, "artifacts", url];
    const found = Bun.which("claude");
    if (found) {
      const added = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
      if (!added.success) throw new CliError(`claude mcp add failed:\n${added.stderr.toString()}`);
      done.push("claude");
    } else if (flags.claude) {
      throw new CliError(`Claude Code isn't on this machine's PATH. Run this where it is: ${args.join(" ")}`);
    }
  }
  if (flags.codex || both) {
    const path = join(process.env.CODEX_HOME ?? join(home(), ".codex"), "config.toml");
    mkdirSync(dirname(path), { recursive: true });
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    writeFileSync(path, codexConfig(current, url, flags.tokenEnv));
    done.push("codex");
  }
  out.result({ url, installed: done }, () => {
    out.say(`✓ ${done.join(" and ")} will use ${url}`);
    if (!flags.tokenEnv) {
      if (done.includes("codex")) out.say("  Sign in with: codex mcp login artifacts");
      if (done.includes("claude")) out.say("  In Claude Code, run /mcp and sign in.");
    }
  });
}
