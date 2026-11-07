import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MINUTE_MS } from "@artifacts/schema";
import { IMAGE, latestVersion, meta, releasesUrl, VERSION_NUMBER, waitHealthy } from "../admin.ts";
import type { Input } from "../command.ts";
import { InsecureServerError, pickServer, readConfig, type ServerEntry } from "../config.ts";
import { sha256 } from "../hash.ts";
import { CliError, type Output, UsageError } from "../output.ts";
import { confirm } from "../prompt.ts";
import { railway, railwayDir, railwayJson, railwaySettings, SERVICE, variables } from "../railway/cli.ts";
import { installSkill } from "../skill/install.ts";
import { olderThan, VERSION } from "../version.ts";

/** The hash for `name` in a SHA256SUMS file: the whole file name has to match, not just its end. */
export function checksumFor(sums: string, name: string): string | undefined {
  for (const line of sums.split("\n")) {
    const [hash, file] = line.trim().split(/\s+/);
    if (file === name || file === `*${name}`) return hash;
  }
  return undefined;
}

const target = () => {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `artifacts-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
};

/** Download, check the SHA-256 from the release, swap atomically (07). */
async function replaceBinary(version: string, out: Output) {
  if (process.execPath.endsWith("/bun")) {
    out.warn("Running from source, so there's no binary to replace.");
    return;
  }
  const name = target();
  const base = `${releasesUrl()}/v${version}`;
  const [binary, sums] = await Promise.all([fetch(`${base}/${name}`), fetch(`${base}/SHA256SUMS`)]);
  if (!binary.ok || !sums.ok) throw new CliError(`v${version} has no download for this machine.`);
  const body = new Uint8Array(await binary.arrayBuffer());
  const expected = checksumFor(await sums.text(), name);
  const actual = sha256(body);
  if (!expected || expected !== actual)
    throw new CliError("The download doesn't match its checksum, so nothing changed.");
  // Written new ("wx") and already executable, so nothing planted at that name is followed or reused.
  const temporary = join(dirname(process.execPath), `.artifacts-${process.pid}`);
  try {
    writeFileSync(temporary, body, { mode: 0o755, flag: "wx" });
    renameSync(temporary, process.execPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new CliError(`Couldn't replace ${process.execPath}: ${(error as Error).message}`);
  }
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
  const image = `${IMAGE}:${version}`;
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/^ARTIFACTS_IMAGE=.*$/m, () => `ARTIFACTS_IMAGE=${image}`),
  );
  // Compose prefers the environment to .env, so an ARTIFACTS_IMAGE there would quietly keep the old server.
  const up = Bun.spawnSync(["docker", "compose", "up", "-d"], {
    cwd: dir,
    env: { ...process.env, ARTIFACTS_IMAGE: image },
    stdout: "ignore",
    stderr: "pipe",
  });
  if (!up.success) throw new CliError(`docker compose failed:\n${up.stderr.toString()}`);
  out.say(`Moved the server to ${IMAGE}:${version}`);
}

export async function upgradeCommand(
  { flags }: Input<never, { server?: boolean; to?: string }>,
  out: Output,
) {
  if (flags.to !== undefined && !VERSION_NUMBER.test(flags.to)) {
    throw new UsageError(`--to wants a version like 0.2.0, not "${flags.to}".`);
  }
  // Looked up first, so a server address the CLI won't use is refused before anything changes.
  const url = (() => {
    try {
      return pickServer();
    } catch (error) {
      if (error instanceof InsecureServerError) throw error;
      return null;
    }
  })();
  const version = flags.to ?? (await latestVersion());
  if (!flags.server) await replaceBinary(version, out);
  // The skill is compiled in, so the new binary is the one that has the new skill.
  if (process.execPath.endsWith("/bun") || flags.server) installSkill({}, out);
  else if (
    !Bun.spawnSync([process.execPath, "skill", "install"], { stdout: "ignore", stderr: "inherit" }).success
  ) {
    out.warn("! The skill didn't update. Run artifacts skill install.");
  }

  // --server leaves the binary alone.
  const cli = flags.server ? VERSION : version;
  const entry = url ? readConfig().servers.find((server) => server.url === url) : undefined;
  if (!entry || !url) return out.result({ cli, server: null }, () => {});
  const running = await meta(url);
  // Without --server, only ever move an older server forward (07).
  if (!flags.server && !olderThan(running.version, version)) {
    return out.result({ cli, server: running.version }, () => {});
  }
  if (entry.railway) upgradeRailway(entry, version, out);
  else if (entry.docker) upgradeDocker(entry, version, out);
  else {
    if (flags.server)
      throw new CliError("This server wasn't set up from here, so it can't be upgraded from here.");
    return out.result({ cli, server: running.version }, () => {});
  }
  await waitHealthy(url, {
    version,
    timeoutMs: 10 * MINUTE_MS,
    pollMs: railwaySettings().pollMs,
    failure: "The server didn't come back on the new version.",
  });
  out.result({ cli, server: version }, () => out.say(`✓ Server ${running.version} to ${version}, healthy`));
}

export async function domainCommand(
  { args: { sub, domain }, flags, usage }: Input<"sub" | "domain", { server?: string }>,
  out: Output,
) {
  const url = pickServer(flags.server);
  const entry = readConfig().servers.find((server) => server.url === url);
  if (!entry?.railway) throw new CliError("artifacts domain only works for servers set up on Railway.");
  const dir = railwayDir(entry.name);
  if (sub === "list") {
    const list = railwayJson<unknown>(["domain", "list", "--service", SERVICE], dir);
    return out.result(list, () => out.say(JSON.stringify(list, null, 2)));
  }
  if (sub !== "add" || !domain) throw usage();
  // It becomes a railway argument and an entry in MORE_URLS, so "--help" or "a.com,https://evil.test" must not pass.
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) {
    throw new UsageError(`"${domain}" isn't a domain name. Use something like art.example.com.`);
  }
  const printed = railway(["domain", domain, "--service", SERVICE, "--port", "8080"], dir);
  const current = variables(dir).MORE_URLS ?? "";
  const origin = `https://${domain}`;
  const more = [...new Set([...current.split(",").filter(Boolean), origin])].join(",");
  railway(["variable", "set", `MORE_URLS=${more}`, "--service", SERVICE], dir);
  let primary = false;
  if (await confirm(`Use ${domain} in copied links?`, { enter: true, unattended: false })) {
    railway(["variable", "set", `PUBLIC_URL=${origin}`, "--service", SERVICE], dir);
    primary = true;
  }
  // Google matches redirects exactly, so a new domain needs its own, and fails until it has one.
  const google = await meta(url)
    .then((body) => body.google)
    .catch(() => null);
  const redirect = google ? `${origin}/api/auth/google/callback` : null;
  out.result({ domain, primary, dns: printed.trim(), googleRedirectUri: redirect }, () => {
    out.say(printed.trim());
    out.say(`✓ ${domain} added. Add the DNS records above; passkeys keep working.`);
    if (redirect) out.say(`  Google sign-in: add ${redirect} to your client's redirect URIs.`);
  });
}
