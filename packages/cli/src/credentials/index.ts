import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, normalizeUrl, readConfig, writePrivateFile } from "../config.ts";
import { CliError } from "../output.ts";

const SERVICE = "artifacts";
const filePath = () => join(configDir(), "credentials.json");
const KEYCHAIN_WAIT_MS = 30_000;

/** The keychain is there, but it's waiting on a person. The file fallback can't help with that. */
export class KeychainBlocked extends CliError {
  override name = "KeychainBlocked";
}

/**
 * macOS ties a keychain item to the binary that wrote it, so a replaced CLI opens a dialog, and the
 * call waits for an answer however long that takes. An agent can't answer it.
 */
export function waitForKeychain<T>(work: Promise<T>, ms = KEYCHAIN_WAIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const blocked = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new KeychainBlocked(
            `The system keychain is waiting for permission to use your Artifacts token, and nobody answered in ${Math.round(ms / 1000)} seconds. This happens once after the CLI is replaced.\nChoose Always Allow in the keychain dialog and run this again, or run artifacts login.`,
          ),
        ),
      ms,
    );
  });
  return Promise.race([work, blocked]).finally(() => clearTimeout(timer));
}

type Backend = {
  get(url: string): Promise<string | null>;
  set(url: string, token: string): Promise<void>;
  remove(url: string): Promise<void>;
};

const fileBackend: Backend = {
  async get(url) {
    if (!existsSync(filePath())) return null;
    const all = JSON.parse(readFileSync(filePath(), "utf8")) as Record<string, string>;
    return all[url] ?? null;
  },
  async set(url, token) {
    const all = existsSync(filePath())
      ? (JSON.parse(readFileSync(filePath(), "utf8")) as Record<string, string>)
      : {};
    writePrivateFile(filePath(), JSON.stringify({ ...all, [url]: token }, null, 2));
  },
  async remove(url) {
    if (!existsSync(filePath())) return;
    const all = JSON.parse(readFileSync(filePath(), "utf8")) as Record<string, string>;
    delete all[url];
    writePrivateFile(filePath(), JSON.stringify(all, null, 2));
  },
};

const keychain: Backend = {
  get: (url) => waitForKeychain(Bun.secrets.get({ service: SERVICE, name: url })),
  // An item an earlier binary wrote can't be updated without a dialog, so replace it.
  async set(url, token) {
    await waitForKeychain(Bun.secrets.delete({ service: SERVICE, name: url }));
    await waitForKeychain(Bun.secrets.set({ service: SERVICE, name: url, value: token }));
  },
  async remove(url) {
    await waitForKeychain(Bun.secrets.delete({ service: SERVICE, name: url }));
  },
};

/** Tries the keychain; headless Linux has none, so it falls back to a 0600 file, with a warning (07). */
async function withFallback<T>(use: (backend: Backend) => Promise<T>): Promise<T> {
  if (process.env.ARTIFACTS_CREDENTIALS === "file") return use(fileBackend);
  try {
    return await use(keychain);
  } catch (error) {
    if (error instanceof KeychainBlocked) throw error;
    console.error(`No system keychain here, so the token is in ${filePath()} (mode 0600).`);
    return use(fileBackend);
  }
}

/**
 * ARTIFACTS_TOKEN belongs to one server: ARTIFACTS_URL if that's set, else the default server in
 * config. Without this, `--server https://elsewhere` (or a command a prompt-injected agent was talked
 * into running) would send the CI token to a host it was never made for.
 */
function envTokenFits(url: string) {
  try {
    if (process.env.ARTIFACTS_URL) return normalizeUrl(process.env.ARTIFACTS_URL) === url;
    const servers = readConfig().servers;
    const own = servers.find((server) => server.default) ?? servers[0];
    // With no server known at all, `--server` is the only way to name one, so the token goes there.
    return !own || own.url === url;
  } catch {
    return false;
  }
}

export const getToken = async (url: string): Promise<string | null> => {
  if (process.env.ARTIFACTS_TOKEN && envTokenFits(url)) return process.env.ARTIFACTS_TOKEN;
  return (await withFallback((backend) => backend.get(url))) ?? (await fileBackend.get(url));
};
export const setToken = (url: string, token: string) => withFallback((backend) => backend.set(url, token));
export async function removeToken(url: string) {
  await withFallback((backend) => backend.remove(url));
  await fileBackend.remove(url);
}
