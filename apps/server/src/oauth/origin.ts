import type { Context } from "hono";
import type { Deps } from "../api/deps.ts";

export const MCP_PATH = "/api/mcp";
export const OAUTH_SCOPES = ["read", "comment", "publish"] as const;

/** The viewer origin this request came in on. Issuer and audience follow it, across every domain. */
export async function requestOrigin(c: Context, deps: Deps): Promise<string | null> {
  const host = c.req.header("host")?.toLowerCase();
  return (await deps.origins()).find((origin) => new URL(origin).host === host) ?? null;
}
