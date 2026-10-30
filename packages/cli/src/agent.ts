import { hostname } from "node:os";

/** 05, "Agent detection": null means a person is at the keyboard. */
export function detectAgent(): string | null {
  if (process.env.ARTIFACTS_AGENT) return process.env.ARTIFACTS_AGENT;
  if (process.env.CLAUDECODE === "1") return "Claude Code";
  if (Object.keys(process.env).some((key) => key.startsWith("CODEX_"))) return "Codex";
  return null;
}

export const clientName = () => hostname().replace(/\.local$/, "");
