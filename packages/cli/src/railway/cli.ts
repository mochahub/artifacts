import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config.ts";
import { CliError } from "../output.ts";

export const SERVICE = "artifacts";
/** Linked here, so `railway init` never links the user's repo (07). */
export const railwayDir = (name: string) => {
  const dir = join(configDir(), "railway", name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

export function railway(args: string[], cwd: string) {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(["railway", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new CliError(
      "The Railway CLI isn't installed. Run: brew install railway (or npm i -g @railway/cli)",
    );
  }
  if (!result.success) {
    throw new CliError(`railway ${args[0]} failed:\n${(result.stderr ?? "").toString().trim()}`);
  }
  return (result.stdout ?? "").toString();
}

export const railwayJson = <T>(args: string[], cwd: string): T =>
  JSON.parse(railway([...args, "--json"], cwd)) as T;

export function hasRailway() {
  try {
    return Bun.spawnSync(["railway", "--version"], { stdout: "pipe", stderr: "pipe" }).success;
  } catch {
    return false;
  }
}

export function signedInToRailway(cwd: string) {
  try {
    return railwayJson<{ name?: string; email?: string; workspaces?: { id: string; name: string }[] }>(
      ["whoami"],
      cwd,
    );
  } catch {
    return null;
  }
}

type Domain = { domain?: string; serviceDomain?: string; targetPort?: number; port?: number };

/** The generated domains, by the port each one targets. Shapes differ by CLI version, so this reads loosely. */
export function domainsByPort(cwd: string): Map<number, string> {
  const body = railwayJson<
    Domain[] | { domains?: Domain[]; serviceDomains?: Domain[]; customDomains?: Domain[] }
  >(["domain", "list", "--service", SERVICE], cwd);
  const rows = Array.isArray(body)
    ? body
    : [...(body.domains ?? []), ...(body.serviceDomains ?? []), ...(body.customDomains ?? [])];
  const found = new Map<number, string>();
  for (const row of rows) {
    const domain = row.domain ?? row.serviceDomain;
    const port = row.targetPort ?? row.port;
    if (domain && port && !found.has(port)) found.set(port, domain);
  }
  return found;
}

/** `railway variable list --json` gives an object of names to values. */
export const variables = (cwd: string) =>
  railwayJson<Record<string, string>>(["variable", "list", "--service", SERVICE], cwd);

export function isDeployed(cwd: string) {
  const status = railwayJson<{ status?: string; deployment?: { status?: string } }>(
    ["service", "status", "--service", SERVICE],
    cwd,
  );
  return (status.status ?? status.deployment?.status ?? "").toUpperCase() === "SUCCESS";
}
