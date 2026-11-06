import { DAY_MS, HOUR_MS } from "@artifacts/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { OrgRow } from "../db/index.ts";
import { guestLinks, guests, oauthGrants, people, sessions, shareLinks, tokens } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { MCP_PATH, requestOrigin } from "../http/origins.ts";
import type { Caller, GuestLink } from "./caller.ts";
import { isLiveLink } from "./links.ts";
import { sha256 } from "./secrets.ts";
import {
  GUEST_COOKIE,
  isSecureRequest,
  personView,
  RECENT_AUTH_MS,
  SESSION_COOKIE,
  SESSION_DAYS,
  setSessionCookie,
} from "./sessions.ts";

/**
 * A connector's token is for the MCP endpoint on the origin it was issued for, and nothing else:
 * "audience-bound" (MCP, authorization). So it can't reach the rest of the API, and one taken from
 * a client can't be replayed against another of this deployment's domains.
 */
async function checkAudience(c: Context, deps: Deps, token: typeof tokens.$inferSelect) {
  const [grant] = token.grantId
    ? await deps.db.select().from(oauthGrants).where(eq(oauthGrants.id, token.grantId)).limit(1)
    : [];
  const origin = await requestOrigin(c, deps);
  if (
    !grant ||
    grant.revokedAt ||
    c.req.path !== MCP_PATH ||
    !origin ||
    token.audience !== `${origin}${MCP_PATH}`
  ) {
    throw new ApiError("unauthenticated", "This token isn't valid here.");
  }
}

async function byToken(c: Context, deps: Deps, org: OrgRow, secret: string): Promise<Caller> {
  const now = deps.clock.now();
  const [token] = await deps.db
    .select()
    .from(tokens)
    .where(and(eq(tokens.orgId, org.id), eq(tokens.tokenHash, sha256(secret)), isNull(tokens.revokedAt)))
    .limit(1);
  // A bad token never falls through to a cookie: the caller meant to use it, so say it failed.
  if (!token || (token.expiresAt && token.expiresAt <= now)) {
    throw new ApiError("unauthenticated", "This token isn't valid. Run artifacts login.");
  }
  if (token.kind === "oauth") await checkAudience(c, deps, token);
  if (!token.lastUsedAt || now.getTime() - token.lastUsedAt.getTime() > HOUR_MS) {
    await deps.db.update(tokens).set({ lastUsedAt: now }).where(eq(tokens.id, token.id));
  }
  if (token.kind === "org") {
    return {
      kind: "orgToken",
      tokenId: token.id,
      createdBy: token.createdBy,
      scopes: token.scopes,
      projectIds: token.projectIds,
    };
  }
  const [person] = await deps.db
    .select()
    .from(people)
    .where(and(eq(people.id, token.personId as string), isNull(people.removedAt)))
    .limit(1);
  if (!person) throw new ApiError("unauthenticated", "This token isn't valid. Run artifacts login.");
  return {
    kind: "cliToken",
    tokenId: token.id,
    scopes: token.scopes,
    person: personView(person),
  };
}

async function bySession(c: Context, deps: Deps, org: OrgRow, secret: string): Promise<Caller | null> {
  const now = deps.clock.now();
  const [row] = await deps.db
    .select({ session: sessions, person: people })
    .from(sessions)
    .innerJoin(people, eq(people.id, sessions.personId))
    .where(and(eq(sessions.orgId, org.id), eq(sessions.tokenHash, sha256(secret)), isNull(people.removedAt)))
    .limit(1);
  if (!row || row.session.expiresAt <= now) return null;
  const { session, person } = row;
  if (now.getTime() - session.lastSeenAt.getTime() > DAY_MS) {
    await deps.db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_DAYS * DAY_MS) })
      .where(eq(sessions.id, session.id));
    setSessionCookie(c, SESSION_COOKIE, secret, SESSION_DAYS, isSecureRequest(c, await deps.origins()));
  }
  return {
    kind: "person",
    sessionId: session.id,
    recentAuth: now.getTime() - session.authAt.getTime() < RECENT_AUTH_MS,
    person: personView(person),
  };
}

async function byGuest(deps: Deps, org: OrgRow, secret: string): Promise<Caller | null> {
  const [guest] = await deps.db
    .select()
    .from(guests)
    .where(and(eq(guests.orgId, org.id), eq(guests.tokenHash, sha256(secret))))
    .limit(1);
  return guest ? guestCaller(deps, org, guest.id) : null;
}

/** A guest's current links. The content port calls this too, to re-check an open frame (04). */
export async function guestCaller(deps: Deps, org: OrgRow, guestId: string): Promise<Caller> {
  const now = deps.clock.now();
  const rows = await deps.db
    .select({ row: guestLinks, link: shareLinks })
    .from(guestLinks)
    .innerJoin(shareLinks, eq(shareLinks.id, guestLinks.shareLinkId))
    .where(eq(guestLinks.guestId, guestId));
  const links: GuestLink[] = rows.map(({ row, link }) => ({
    artifactId: link.artifactId,
    shareLinkId: link.id,
    permission: link.permission,
    name: row.name,
    // Checked on every request, so revoking a link ends access at once (02).
    active: org.settings.linkSharing && isLiveLink(link, now) && row.expiresAt > now,
  }));
  return { kind: "guest", guestId, links };
}

/**
 * The same caller as it is now, or null if it has ended. For something that outlives one request and
 * can't resolve a cookie again, such as an event stream.
 */
export async function currentCaller(deps: Deps, org: OrgRow, caller: Caller): Promise<Caller | null> {
  const now = deps.clock.now();
  if (caller.kind === "guest") return guestCaller(deps, org, caller.guestId);
  if (caller.kind === "person") {
    const [row] = await deps.db
      .select({ session: sessions, person: people })
      .from(sessions)
      .innerJoin(people, eq(people.id, sessions.personId))
      .where(and(eq(sessions.id, caller.sessionId), isNull(people.removedAt)))
      .limit(1);
    if (!row || row.session.expiresAt <= now) return null;
    return { ...caller, person: personView(row.person) };
  }
  if (caller.kind === "cliToken" || caller.kind === "orgToken") {
    const [token] = await deps.db.select().from(tokens).where(eq(tokens.id, caller.tokenId)).limit(1);
    if (!token || token.revokedAt || (token.expiresAt && token.expiresAt <= now)) return null;
    if (caller.kind === "orgToken") return { ...caller, scopes: token.scopes, projectIds: token.projectIds };
    const [person] = await deps.db
      .select()
      .from(people)
      .where(and(eq(people.id, caller.person.id), isNull(people.removedAt)))
      .limit(1);
    if (!person) return null;
    return { ...caller, scopes: token.scopes, person: personView(person) };
  }
  return null;
}

/** Bearer token, then session cookie, then guest cookie (04, "Callers"). */
export async function resolveCaller(c: Context, deps: Deps, org: OrgRow): Promise<Caller> {
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) return byToken(c, deps, org, header.slice(7));
  const session = getCookie(c, SESSION_COOKIE);
  if (session) {
    const caller = await bySession(c, deps, org, session);
    if (caller) return caller;
  }
  const guest = getCookie(c, GUEST_COOKIE);
  if (guest) {
    const caller = await byGuest(deps, org, guest);
    if (caller) return caller;
  }
  return { kind: "anonymous" };
}
