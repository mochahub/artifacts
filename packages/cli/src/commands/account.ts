import { Me, RecoverResponse } from "@artifacts/schema";
import { Client } from "../client.ts";
import type { Input } from "../command.ts";
import { normalizeUrl, pickServer, readConfig, writeConfig } from "../config.ts";
import { getToken, removeToken } from "../credentials/index.ts";
import type { Output } from "../output.ts";
import { ask, askSecret } from "../prompt.ts";
import { login, serverName, signedIn } from "../session.ts";

export async function loginCommand(
  { args: { url: given }, flags }: Input<"url", { server?: string }>,
  out: Output,
) {
  const url = given ? normalizeUrl(given) : pickServer(flags.server);
  const person = await login(url, out);
  out.result({ server: url, person }, () => out.say(`Signed in to ${serverName(url)} as ${person.name}.`));
}

export async function whoami({ flags }: Input<never, { server?: string }>, out: Output) {
  const client = await signedIn(flags.server);
  const me = Me.parse(await client.get("/api/me"));
  out.result({ ...me, server: client.url }, () =>
    out.say(`${me.person.name} (${me.person.email}), ${me.person.role} of ${me.org.name}, on ${client.url}`),
  );
}

export async function logout({ flags }: Input<never, { server?: string }>, out: Output) {
  const url = pickServer(flags.server);
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

export async function recover(
  { args: { url: given }, flags, usage }: Input<"url", { email?: string }>,
  out: Output,
) {
  if (!given) throw usage();
  const url = normalizeUrl(given);
  const setupToken = process.env.ARTIFACTS_SETUP_TOKEN ?? (await askSecret("Setup token:"));
  const owner = flags.email ?? (await ask("An owner's email:"));
  const { resetUrl } = RecoverResponse.parse(
    await new Client(url).post("/api/recover", { setupToken, email: owner }),
  );
  out.result({ resetUrl }, () => out.say(`Works once, for one hour:\n  ${resetUrl}`));
}
