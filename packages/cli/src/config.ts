import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./output.ts";

export type ServerEntry = {
  url: string;
  name: string;
  default?: boolean;
  railway?: { projectId: string; service: string; environment?: string };
  docker?: { dir: string };
};
export type Config = { servers: ServerEntry[] };

export const home = () => process.env.HOME ?? homedir();
export const configDir = () => join(process.env.XDG_CONFIG_HOME ?? join(home(), ".config"), "artifacts");
const configPath = () => join(configDir(), "config.json");

export function readConfig(): Config {
  if (!existsSync(configPath())) return { servers: [] };
  return JSON.parse(readFileSync(configPath(), "utf8")) as Config;
}

/** Atomic, so a crash can't leave half a config. */
export function writePrivateFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export const writeConfig = (config: Config) =>
  writePrivateFile(configPath(), JSON.stringify(config, null, 2));

/** Adds or updates a server and makes it the default. */
export function saveServer(entry: ServerEntry) {
  const config = readConfig();
  const rest = config.servers.filter((server) => server.url !== entry.url);
  const previous = config.servers.find((server) => server.url === entry.url);
  writeConfig({
    servers: [
      ...rest.map((server) => ({ ...server, default: false })),
      // A server set up here names itself (setup saves the hostname first, then "artifacts" with its
      // Railway details). After that the name stays: railwayDir is named after it, so a later `login`
      // saving the hostname mustn't rename it and point domain and upgrade at an unlinked folder.
      {
        ...previous,
        ...entry,
        name: entry.railway || entry.docker ? entry.name : (previous?.name ?? entry.name),
        default: true,
      },
    ],
  });
}

/** The hosts where plain http is still fine: this machine itself, where nothing crosses a network. */
const isLoopback = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]" ||
  hostname.endsWith(".localhost");

/** Raised for a server address the CLI won't send a password or token to. */
export class InsecureServerError extends CliError {}

/**
 * A password or token only ever goes over HTTPS, or to this machine. Every server address passes
 * through here, whether it was typed, set in the environment, or stored in the config by an older CLI.
 */
export function requireHttps(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
    throw new InsecureServerError(
      `The CLI only signs in over HTTPS, and ${parsed.origin} is plain http: put a reverse proxy in front of the server (the README's HTTPS section shows how) and use its https:// address.`,
    );
  }
  return url;
}

export const normalizeUrl = (url: string) => {
  let parsed: URL;
  try {
    parsed = new URL(url.includes("://") ? url : `https://${url}`);
  } catch {
    throw new CliError(`"${url}" isn't a URL.`);
  }
  // A file: or custom scheme has the origin "null", which is not a server.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(`"${url}" isn't a web address. Use https://.`);
  }
  return requireHttps(parsed.origin);
};

/** --server, then ARTIFACTS_URL, then the default server in config (07). */
export function pickServer(option?: string): string {
  const servers = readConfig().servers;
  if (option) {
    const named = servers.find((server) => server.name === option || server.url === option);
    return named ? requireHttps(named.url) : normalizeUrl(option);
  }
  if (process.env.ARTIFACTS_URL) return normalizeUrl(process.env.ARTIFACTS_URL);
  const chosen = servers.find((server) => server.default) ?? servers[0];
  if (!chosen) throw new CliError("No server yet. Run artifacts setup.");
  return requireHttps(chosen.url);
}
