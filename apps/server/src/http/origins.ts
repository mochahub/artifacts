import type { Context } from "hono";
import type { Deps } from "../deps.ts";
import type { Env } from "../env.ts";

/** The hosted MCP endpoint, and the audience of every connector's token (04, "Connectors"). */
export const MCP_PATH = "/api/mcp";

/** The viewer origins: PUBLIC_URL, MORE_URLS and always the home domain (SPEC §7.3). */
export function viewerOrigins(env: Env, homeDomain: string | null): string[] {
  const known = env.viewerOrigins;
  if (!homeDomain || known.some((origin) => new URL(origin).hostname === homeDomain)) return known;
  return [...known, `https://${homeDomain}`];
}

/** The viewer origin this request came in on. Issuer and audience follow it, across every domain. */
export async function requestOrigin(c: Context, deps: Pick<Deps, "origins">): Promise<string | null> {
  const host = c.req.header("host")?.toLowerCase();
  return (await deps.origins()).find((origin) => new URL(origin).host === host) ?? null;
}
