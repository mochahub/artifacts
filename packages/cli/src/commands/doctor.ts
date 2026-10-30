import { Meta } from "@artifacts/schema";
import { Client } from "../client.ts";
import { pickServer } from "../config.ts";
import { getToken } from "../credentials/index.ts";
import { CliError, type Output } from "../output.ts";
import { VERSION } from "../version.ts";

type Check = { name: string; ok: boolean; detail: string };

/** Each check says what's wrong and how to fix it (07). */
export async function doctor(server: string | undefined, out: Output) {
  const checks: Check[] = [{ name: "cli", ok: true, detail: `Version ${VERSION}` }];
  let url: string | null = null;
  try {
    url = pickServer(server);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    checks.push({ name: "server", ok: false, detail: error.message });
  }
  if (url) {
    try {
      const meta = Meta.parse(await new Client(url).get("/api/meta"));
      checks.push({ name: "server", ok: true, detail: `${url} runs ${meta.version}` });
      if (VERSION.localeCompare(meta.minCliVersion, undefined, { numeric: true }) < 0) {
        checks.push({ name: "version", ok: false, detail: "This CLI is too old. Run artifacts upgrade." });
      }
    } catch (error) {
      checks.push({ name: "server", ok: false, detail: (error as Error).message });
    }
    const token = await getToken(url);
    if (!token) {
      checks.push({ name: "sign-in", ok: false, detail: `Not signed in. Run artifacts login ${url}` });
    } else {
      try {
        await new Client(url, token).get("/api/me");
        checks.push({ name: "sign-in", ok: true, detail: "The token is valid." });
      } catch (error) {
        checks.push({ name: "sign-in", ok: false, detail: `${(error as Error).message}` });
      }
    }
  }
  const ok = checks.every((check) => check.ok);
  out.result({ ok, checks }, () => {
    for (const check of checks) out.say(`${check.ok ? "✓" : "✗"} ${check.name}  ${check.detail}`);
  });
  if (!ok) process.exitCode = 1;
}
