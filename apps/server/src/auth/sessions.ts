import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { Deps } from "../api/deps.ts";
import type { Db } from "../db/index.ts";
import { type people, sessions, tokens } from "../db/schema.ts";
import { newApiToken, randomSecret, sha256 } from "./secrets.ts";

export const SESSION_COOKIE = "art_session";
export const GUEST_COOKIE = "art_guest";
const DAY = 24 * 3600_000;
export const SESSION_DAYS = 30;
export const RECENT_AUTH_MS = 10 * 60_000;
export const DEFAULT_CLI_SCOPES = ["publish", "comment", "read", "manage", "data"];

/** `Secure` everywhere except plain-http origins, where a browser would drop it (local Compose, dev, e2e). */
export function isSecureRequest(c: Context, origins: string[]): boolean {
  const host = c.req.header("host")?.toLowerCase();
  const origin = origins.find((candidate) => new URL(candidate).host === host);
  return origin === undefined || origin.startsWith("https:");
}

export function setSessionCookie(c: Context, name: string, secret: string, days: number, secure: boolean) {
  setCookie(c, name, secret, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: days * 24 * 3600,
  });
}

export const clearCookie = (c: Context, name: string) => deleteCookie(c, name, { path: "/" });

/** Starts a session and sets its cookie. Every way of proving a credential ends here (04). */
export async function startSession(c: Context, deps: Deps, orgId: string, personId: string) {
  const secret = randomSecret();
  const now = deps.clock.now();
  await deps.db.insert(sessions).values({
    id: Bun.randomUUIDv7(),
    orgId,
    tokenHash: sha256(secret),
    personId,
    domain: (c.req.header("host") ?? "").split(":")[0] ?? "",
    authAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + SESSION_DAYS * DAY),
    userAgent: c.req.header("user-agent") ?? null,
    ip: deps.clientIp(c),
  });
  setSessionCookie(c, SESSION_COOKIE, secret, SESSION_DAYS, isSecureRequest(c, await deps.origins()));
}

/** Creates a CLI token and returns its secret, which is shown this once. */
export async function createCliToken(
  db: Pick<Db, "insert">,
  values: { orgId: string; personId: string; name: string; now: Date },
): Promise<string> {
  const secret = newApiToken();
  await db.insert(tokens).values({
    id: Bun.randomUUIDv7(),
    orgId: values.orgId,
    kind: "cli",
    personId: values.personId,
    name: values.name,
    tokenHash: sha256(secret),
    scopes: DEFAULT_CLI_SCOPES,
    createdBy: values.personId,
    createdAt: values.now,
  });
  return secret;
}

export const personView = (row: typeof people.$inferSelect) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
});

export const endSessions = (db: Db, personId: string) =>
  db.delete(sessions).where(eq(sessions.personId, personId));
