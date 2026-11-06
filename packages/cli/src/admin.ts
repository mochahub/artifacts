import { Health, Meta, SetupResponse } from "@artifacts/schema";
import { clientName, detectAgent } from "./agent.ts";
import { Client } from "./client.ts";
import { isSecure, normalizeUrl, saveServer } from "./config.ts";
import { setToken } from "./credentials/index.ts";
import { CliError, type Output } from "./output.ts";
import { ask, askNewPassword, askSecret } from "./prompt.ts";
import { login, serverName } from "./session.ts";

const REPO = "mochahub/artifacts";
export const IMAGE = "ghcr.io/mochahub/artifacts";
/** A release's own number. It ends up in a URL, a .env line and a command's arguments, so nothing else passes. */
export const VERSION_NUMBER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Where releases come from can be moved for tests, but a binary is never fetched over plain http from elsewhere. */
function secure(url: string) {
  if (!isSecure(url)) throw new CliError(`${url} isn't https, so the CLI won't download from it.`);
  return url;
}
export const releasesUrl = () =>
  secure(process.env.ARTIFACTS_RELEASES_URL ?? `https://github.com/${REPO}/releases/download`);
const latestUrl = () =>
  secure(process.env.ARTIFACTS_LATEST_URL ?? `https://api.github.com/repos/${REPO}/releases/latest`);

export async function latestVersion(): Promise<string> {
  const response = await fetch(latestUrl(), { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new CliError(`Couldn't read the latest release (${response.status}).`);
  const { tag_name: tag } = (await response.json()) as { tag_name: string };
  const version = String(tag).replace(/^v/, "");
  if (!VERSION_NUMBER.test(version))
    throw new CliError(`The latest release is called "${tag}", which isn't a version.`);
  return version;
}

export const health = async (url: string) => Health.parse(await new Client(url).get("/api/health"));
export const meta = async (url: string) => Meta.parse(await new Client(url).get("/api/meta"));

type Wait = { timeoutMs: number; pollMs: number; failure: string; fatal?: (error: unknown) => boolean };

/** Checks until `check` passes. A check that throws counts as not yet, unless `fatal` says the wait is over. */
export async function waitFor(check: () => boolean | Promise<boolean>, wait: Wait) {
  const deadline = Date.now() + wait.timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch (error) {
      if (wait.fatal?.(error)) throw error;
    }
    if (Date.now() > deadline) throw new CliError(wait.failure);
    await Bun.sleep(wait.pollMs);
  }
}

/** Until the server answers its health check, on `version` if one is given. */
export const waitHealthy = (url: string, wait: Wait & { version?: string }) =>
  waitFor(async () => {
    const running = await health(url);
    return wait.version ? running.version === wait.version : running.ok;
  }, wait);

export type ClaimAnswers = { org?: string; name?: string; email?: string; password?: string };

/**
 * Google is optional, so Enter skips it, and with nobody at the keyboard it's only used if it's set.
 * A server stores these and leaves them off until an admin tests them in Settings.
 */
async function askGoogle(url: string, out: Output) {
  const clientId = process.env.ARTIFACTS_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.ARTIFACTS_GOOGLE_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };
  if (!process.stdin.isTTY) return undefined;
  const { viewerOrigins } = await meta(url);
  out.say("Google sign-in is optional. To use it, add these redirect URIs to a Web application client:");
  for (const origin of new Set([url, ...viewerOrigins])) {
    out.say(`  ${origin}/api/auth/google/callback`);
  }
  const id = await ask("Google client ID (Enter to skip):");
  if (!id) return undefined;
  return { clientId: id, clientSecret: await askSecret("Google client secret:") };
}

/** Claims a server in setup mode, with the same questions everywhere it's reached from. */
export async function claim(url: string, setupToken: string, answers: ClaimAnswers, out: Output) {
  const orgName = answers.org ?? (await ask("Organization name:"));
  const name = answers.name ?? (await ask("Your name:"));
  const email = answers.email ?? (await ask("Email:"));
  const password = answers.password ?? process.env.ARTIFACTS_PASSWORD ?? (await askNewPassword());
  const google = await askGoogle(url, out);
  const result = SetupResponse.parse(
    await new Client(url).post("/api/setup", {
      setupToken,
      orgName,
      name,
      email,
      password,
      clientName: clientName(),
      agent: detectAgent() ?? undefined,
      ...(google ? { google } : {}),
    }),
  );
  await setToken(url, result.token);
  saveServer({ url, name: serverName(url) });
  out.say(`Created ${orgName} with you as owner. This machine is signed in as you.`);
  if (google) out.say(`Google is saved but off. Open ${url}/settings/google and press Test to turn it on.`);
  return result.person;
}

/** `setup <url>`: claim it if it's in setup mode, or sign in to it. */
export async function setupExisting(rawUrl: string, answers: ClaimAnswers, out: Output) {
  const url = normalizeUrl(rawUrl);
  if ((await health(url)).setupMode) {
    const token =
      process.env.ARTIFACTS_SETUP_TOKEN ??
      (await askSecret("Setup token (Railway: your project, then artifacts, then Variables, SETUP_TOKEN):"));
    return claim(url, token, answers, out);
  }
  return login(url, out);
}
