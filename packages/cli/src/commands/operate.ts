import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Meta } from "@artifacts/schema";
import { Client } from "../client.ts";
import { pickServer, readConfig, type ServerEntry } from "../config.ts";
import { CliError, type Output, UsageError } from "../output.ts";
import { confirm } from "../prompt.ts";
import { railway, railwayDir, railwayJson, SERVICE, variables } from "../railway/cli.ts";
import { installSkill } from "../skill/install.ts";
import { VERSION } from "../version.ts";
import { health } from "./account.ts";

const REPO = "mochahub/artifacts";
export const IMAGE = "ghcr.io/mochahub/artifacts";
const releases = () => process.env.ARTIFACTS_RELEASES_URL ?? `https://github.com/${REPO}/releases/download`;
const latestUrl = () =>
  process.env.ARTIFACTS_LATEST_URL ?? `https://api.github.com/repos/${REPO}/releases/latest`;

const target = () => {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `artifacts-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
};

async function latestVersion(): Promise<string> {
  const response = await fetch(latestUrl(), { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new CliError(`Couldn't read the latest release (${response.status}).`);
  const { tag_name: tag } = (await response.json()) as { tag_name: string };
  return tag.replace(/^v/, "");
}

/** Download, check the SHA-256 from the release, swap atomically (07). */
async function replaceBinary(version: string, out: Output) {
  if (process.execPath.endsWith("/bun")) {
    out.warn("Running from source, so there's no binary to replace.");
    return;
  }
  const name = target();
  const base = `${releases()}/v${version}`;
  const [binary, sums] = await Promise.all([fetch(`${base}/${name}`), fetch(`${base}/SHA256SUMS`)]);
  if (!binary.ok || !sums.ok) throw new CliError(`v${version} has no download for this machine.`);
  const body = new Uint8Array(await binary.arrayBuffer());
  const expected = (await sums.text())
    .split("\n")
    .find((line) => line.trim().endsWith(name))
    ?.split(/\s+/)[0];
  const actual = createHash("sha256").update(body).digest("hex");
  if (!expected || expected !== actual)
    throw new CliError("The download doesn't match its checksum, so nothing changed.");
  const temporary = join(dirname(process.execPath), `.artifacts-${process.pid}`);
  writeFileSync(temporary, body);
  chmodSync(temporary, 0o755);
  renameSync(temporary, process.execPath);
  out.say(`✓ CLI ${VERSION} to ${version}`);
}

function upgradeRailway(server: ServerEntry, version: string, out: Output) {
  const dir = railwayDir(server.name);
  railway(["service", "source", "connect", "--image", `${IMAGE}:${version}`, "--service", SERVICE], dir);
  out.say(`Moved the service to ${IMAGE}:${version}`);
}

function upgradeDocker(server: ServerEntry, version: string, out: Output) {
  const dir = server.docker?.dir as string;
  const path = join(dir, ".env");
  if (!existsSync(path)) throw new CliError(`There's no deployment in ${dir}.`);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/^ARTIFACTS_IMAGE=.*$/m, `ARTIFACTS_IMAGE=${IMAGE}:${version}`),
  );
  const up = Bun.spawnSync(["docker", "compose", "up", "-d"], { cwd: dir, stdout: "ignore", stderr: "pipe" });
  if (!up.success) throw new CliError(`docker compose failed:\n${up.stderr.toString()}`);
  out.say(`Moved the server to ${IMAGE}:${version}`);
}

export async function upgradeCommand(flags: { server?: boolean; to?: string; target?: string }, out: Output) {
  const version = flags.to ?? (await latestVersion());
  if (!flags.server) await replaceBinary(version, out);
  installSkill({}, out);

  const url = (() => {
    try {
      return pickServer(flags.target);
    } catch {
      return null;
    }
  })();
  const entry = url ? readConfig().servers.find((server) => server.url === url) : undefined;
  if (!entry || !url) return out.result({ cli: version, server: null }, () => {});
  const meta = Meta.parse(await new Client(url).get("/api/meta"));
  if (!flags.server && meta.version === version)
    return out.result({ cli: version, server: version }, () => {});
  if (entry.railway) upgradeRailway(entry, version, out);
  else if (entry.docker) upgradeDocker(entry, version, out);
  else {
    if (flags.server)
      throw new CliError("This server wasn't set up from here, so it can't be upgraded from here.");
    return out.result({ cli: version, server: meta.version }, () => {});
  }
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const running = await health(url).catch(() => null);
    if (running?.version === version) break;
    if (Date.now() > deadline) throw new CliError("The server didn't come back on the new version.");
    await Bun.sleep(Number(process.env.ARTIFACTS_RAILWAY_POLL_MS ?? 5000));
  }
  out.result({ cli: version, server: version }, () =>
    out.say(`✓ Server ${meta.version} to ${version}, healthy`),
  );
}

export async function domainCommand(
  sub: string | undefined,
  domain: string | undefined,
  flags: { target?: string },
  out: Output,
) {
  const url = pickServer(flags.target);
  const entry = readConfig().servers.find((server) => server.url === url);
  if (!entry?.railway) throw new CliError("artifacts domain only works for servers set up on Railway.");
  const dir = railwayDir(entry.name);
  if (sub === "list") {
    const list = railwayJson<unknown>(["domain", "list", "--service", SERVICE], dir);
    return out.result(list, () => out.say(JSON.stringify(list, null, 2)));
  }
  if (sub !== "add" || !domain) throw new UsageError("Usage: artifacts domain add <domain> | list");
  const printed = railway(["domain", domain, "--service", SERVICE, "--port", "8080"], dir);
  const current = variables(dir).MORE_URLS ?? "";
  const origin = `https://${domain}`;
  const more = [...new Set([...current.split(",").filter(Boolean), origin])].join(",");
  railway(["variable", "set", `MORE_URLS=${more}`, "--service", SERVICE], dir);
  let primary = false;
  if (await confirm(`Use ${domain} in copied links?`).catch(() => false)) {
    railway(["variable", "set", `PUBLIC_URL=${origin}`, "--service", SERVICE], dir);
    primary = true;
  }
  out.result({ domain, primary, dns: printed.trim() }, () => {
    out.say(printed.trim());
    out.say(`✓ ${domain} added. Add the DNS records above; passkeys keep working.`);
  });
}
