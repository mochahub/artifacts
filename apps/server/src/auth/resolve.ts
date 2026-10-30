import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Deps } from "../api/deps.ts";
import type { OrgRow } from "../db/index.ts";
import { guestLinks, guests, people, sessions, shareLinks, tokens } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import type { Caller, GuestLink } from "./caller.ts";
import { sha256 } from "./secrets.ts";
import {
  GUEST_COOKIE,
  isSecureRequest,
  RECENT_AUTH_MS,
  SESSION_COOKIE,
  SESSION_DAYS,
  setSessionCookie,
} from "./sessions.ts";

const DAY = 24 * 3600_000;
const HOUR = 3600_000;

async function byToken(deps: Deps, org: OrgRow, secret: string): Promise<Caller> {
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
  if (!token.lastUsedAt || now.getTime() - token.lastUsedAt.getTime() > HOUR) {
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
    agent: null,
    person: { id: person.id, name: person.name, email: person.email, role: person.role },
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
  if (now.getTime() - session.lastSeenAt.getTime() > DAY) {
    await deps.db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_DAYS * DAY) })
      .where(eq(sessions.id, session.id));
    setSessionCookie(c, SESSION_COOKIE, secret, SESSION_DAYS, isSecureRequest(c, await deps.origins()));
  }
  return {
    kind: "person",
    sessionId: session.id,
    recentAuth: now.getTime() - session.authAt.getTime() < RECENT_AUTH_MS,
    person: { id: person.id, name: person.name, email: person.email, role: person.role },
  };
}

async function byGuest(deps: Deps, org: OrgRow, secret: string): Promise<Caller | null> {
  const [guest] = await deps.db
    .select()
    .from(guests)
    .where(and(eq(guests.orgId, org.id), eq(guests.tokenHash, sha256(secret))))
    .limit(1);
  return guest ? guestCaller(deps, guest.id) : null;
}

/** A guest's current links. The content port calls this too, to re-check an open frame (04). */
export async function guestCaller(deps: Deps, guestId: string): Promise<Caller> {
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
    active: !link.revokedAt && (!link.expiresAt || link.expiresAt > now) && row.expiresAt > now,
  }));
  return { kind: "guest", guestId, links };
}

/** Bearer token, then session cookie, then guest cookie (04, "Callers"). */
export async function resolveCaller(c: Context, deps: Deps, org: OrgRow): Promise<Caller> {
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) return byToken(deps, org, header.slice(7));
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
