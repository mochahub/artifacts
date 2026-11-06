import { DevicePollResult, DeviceStarted } from "@artifacts/schema";
import { clientName, detectAgent } from "./agent.ts";
import { openBrowser } from "./browser.ts";
import { ApiCallError, Client } from "./client.ts";
import { pickServer, saveServer } from "./config.ts";
import { getToken, setToken } from "./credentials/index.ts";
import { CliError, type Output } from "./output.ts";

export const serverName = (url: string) => new URL(url).hostname;

/** A client with this machine's token for the server the command is about. */
export async function signedIn(server: string | undefined): Promise<Client> {
  const url = pickServer(server);
  const token = await getToken(url);
  if (!token) throw new CliError(`Not signed in to ${url}. Run artifacts login ${url}`);
  return new Client(url, token);
}

/** The default server's client, or null with no server or no token, for callers that must not fail. */
export async function findClient(): Promise<Client | null> {
  let url: string;
  try {
    url = pickServer(undefined);
  } catch (error) {
    if (error instanceof CliError) return null;
    throw error;
  }
  const token = await getToken(url);
  return token ? new Client(url, token) : null;
}

/** The device flow (04): prints the code, the person approves in a browser, the CLI collects the token. */
export async function login(url: string, out: Output) {
  const client = new Client(url);
  const started = DeviceStarted.parse(
    await client.post("/api/device/start", { clientName: clientName(), agent: detectAgent() ?? undefined }),
  );
  out.say(`Your code: ${started.userCode}`);
  out.say(`Open ${started.verificationUrl}, sign in, and type the code.`);
  openBrowser(started.verificationUrl);

  const deadline = Date.now() + started.expiresIn * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(started.interval * 1000);
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
