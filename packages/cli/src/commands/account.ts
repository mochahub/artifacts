import {
  DevicePollResult,
  DeviceStarted,
  Health,
  Me,
  RecoverResponse,
  SetupResponse,
} from "@artifacts/schema";
import { clientName, detectAgent } from "../agent.ts";
import { ApiCallError, Client } from "../client.ts";
import { normalizeUrl, pickServer, readConfig, saveServer, writeConfig } from "../config.ts";
import { getToken, removeToken, setToken } from "../credentials/index.ts";
import { CliError, type Output } from "../output.ts";
import { ask, askSecret } from "../prompt.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A client with this machine's token for the server the command is about. */
export async function signedIn(server: string | undefined): Promise<Client> {
  const url = pickServer(server);
  const token = await getToken(url);
  if (!token) throw new CliError(`Not signed in to ${url}. Run artifacts login ${url}`);
  return new Client(url, token);
}

/** The same client, or null with no server or token, for callers that must not fail. */
export async function findClient(): Promise<Client | null> {
  const url = pickServer(undefined);
  const token = await getToken(url);
  return token ? new Client(url, token) : null;
}

/** The link comes from the server, so only web pages open: not file:, an app's own scheme, or a path. */
function openBrowser(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    Bun.spawn([command, url], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}

export const serverName = (url: string) => new URL(url).hostname;

/** The device flow (04): prints the code, the person approves in a browser, the CLI collects the token. */
export async function login(url: string, out: Output) {
  const client = new Client(url);
  const started = DeviceStarted.parse(
    await client.post("/api/device/start", { clientName: clientName(), agent: detectAgent() ?? undefined }),
  );
  out.say(`Your code: ${started.userCode}`);
  out.say(`Open ${started.verificationUrl}, sign in, and type the code.`);
  if (!process.env.ARTIFACTS_NO_BROWSER) openBrowser(started.verificationUrl);

  const deadline = Date.now() + started.expiresIn * 1000;
  while (Date.now() < deadline) {
    await wait(started.interval * 1000);
    let poll: unknown;
    try {
      poll = await client.post("/api/device/poll", { deviceCode: started.deviceCode });
    } catch (error) {
      if (error instanceof ApiCallError && error.failure.code === "rate_limited") continue;
      throw error;
    }
    const result = DevicePollResult.parse(poll);
    if (result.status === "denied") throw new CliError("That sign-in was denied.");
    if (result.status === "approved") {
      await setToken(url, result.token);
      saveServer({ url, name: serverName(url) });
      return result.person;
    }
  }
  throw new CliError("The code expired. Run artifacts login again.");
}

export type ClaimAnswers = { org?: string; name?: string; email?: string; password?: string };

/** Claims a server in setup mode, with the same questions everywhere it's reached from. */
export async function claim(url: string, setupToken: string, answers: ClaimAnswers, out: Output) {
  const orgName = answers.org ?? (await ask("Organization name:"));
  const name = answers.name ?? (await ask("Your name:"));
  const email = answers.email ?? (await ask("Email:"));
  const password = answers.password ?? process.env.ARTIFACTS_PASSWORD ?? (await askNewPassword());
  const result = SetupResponse.parse(
    await new Client(url).post("/api/setup", {
      setupToken,
      orgName,
      name,
      email,
      password,
      clientName: clientName(),
      agent: detectAgent() ?? undefined,
    }),
  );
  await setToken(url, result.token);
  saveServer({ url, name: serverName(url) });
  out.say(`Created ${orgName} with you as owner. This machine is signed in as you.`);
  return result.person;
}

async function askNewPassword() {
  for (;;) {
    const first = await askSecret("Password (12 or more characters):");
    if (first.length < 12) {
      console.error("That's under 12 characters.");
      continue;
    }
    if (first === (await askSecret("Again:"))) return first;
    console.error("Those didn't match.");
  }
}

export async function health(url: string) {
  return Health.parse(await new Client(url).get("/api/health"));
}

export async function setupExisting(
  rawUrl: string,
  flags: ClaimAnswers & { setupToken?: string },
  out: Output,
) {
  const url = normalizeUrl(rawUrl);
  if ((await health(url)).setupMode) {
    const token =
      flags.setupToken ??
      process.env.ARTIFACTS_SETUP_TOKEN ??
      (await askSecret("Setup token (Railway: your project, then artifacts, then Variables, SETUP_TOKEN):"));
    return claim(url, token, flags, out);
  }
  return login(url, out);
}

export async function whoami(server: string | undefined, out: Output) {
  const client = await signedIn(server);
  const me = Me.parse(await client.get("/api/me"));
  out.result({ ...me, server: client.url }, () =>
    out.say(`${me.person.name} (${me.person.email}), ${me.person.role} of ${me.org.name}, on ${client.url}`),
  );
}

export async function logout(server: string | undefined, out: Output) {
  const url = pickServer(server);
  const token = await getToken(url);
  if (token && !process.env.ARTIFACTS_TOKEN) {
    // The token is gone locally either way; revoking it is best effort if the server is away.
    await new Client(url, token).post("/api/auth/logout").catch(() => {});
  }
  await removeToken(url);
  const config = readConfig();
  writeConfig({ servers: config.servers.filter((entry) => entry.url !== url) });
  out.result({ ok: true, server: url }, () => out.say(`Signed out of ${url}.`));
}

export async function recover(rawUrl: string, email: string | undefined, out: Output) {
  const url = normalizeUrl(rawUrl);
  const setupToken = process.env.ARTIFACTS_SETUP_TOKEN ?? (await askSecret("Setup token:"));
  const owner = email ?? (await ask("An owner's email:"));
  const { resetUrl } = RecoverResponse.parse(
    await new Client(url).post("/api/recover", { setupToken, email: owner }),
  );
  out.result({ resetUrl }, () => out.say(`Works once, for one hour:\n  ${resetUrl}`));
}
