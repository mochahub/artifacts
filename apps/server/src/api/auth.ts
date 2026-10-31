import { ChangePassword, PasswordSignIn, Reauth, ResetPassword } from "@artifacts/schema";
import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { Caller } from "../auth/caller.ts";
import { sha256 } from "../auth/secrets.ts";
import { clearCookie, personView, SESSION_COOKIE, startSession } from "../auth/sessions.ts";
import { passkeys as passkeyRows, passwords, people, resetLinks, sessions, tokens } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import type { Deps } from "./deps.ts";
import { type ApiContext, parseBody, type Routes } from "./routes.ts";

const MAX_PASSWORD = 256;

/** Verifying against this when the email is unknown keeps both answers the same speed. */
const dummyHash = Bun.password.hash("not a real password", { algorithm: "argon2id" });

const personOf = (caller: Caller) => {
  if (caller.kind !== "person" && caller.kind !== "cliToken")
    throw new ApiError("unauthenticated", "Sign in first.");
  return caller.person;
};
const sessionOf = (caller: Caller) => {
  if (caller.kind !== "person") throw new ApiError("forbidden", "This needs a signed-in browser.");
  return caller;
};

export function authRoutes(
  routes: Routes,
  deps: Deps,
  passkeys: { reauth(c: ApiContext, challengeId: string, response: unknown): Promise<void> },
) {
  const { db, clock, limits } = deps;

  async function checkPassword(orgId: string, email: string, password: string) {
    const [row] = await db
      .select({ person: people, hash: passwords.hash })
      .from(people)
      .leftJoin(passwords, eq(passwords.personId, people.id))
      .where(
        and(eq(people.orgId, orgId), sql`lower(${people.email}) = lower(${email})`, isNull(people.removedAt)),
      )
      .limit(1);
    const ok = await Bun.password.verify(password, row?.hash ?? (await dummyHash));
    // No password row means no password can be right, whatever the dummy hash says.
    return ok && row?.hash ? row.person : null;
  }

  routes.post("/api/auth/password", { public: true }, async (c) => {
    const body = await parseBody(c, PasswordSignIn);
    const account = body.email.toLowerCase();
    limits.checkPassword(account, deps.clientIp(c));
    // No password this long exists (04), so don't hash it, and don't count it against the account.
    if (body.password.length > MAX_PASSWORD) {
      throw new ApiError("unauthenticated", "That email or password isn't right.");
    }
    const person = await checkPassword(c.get("org").id, body.email, body.password);
    if (!person) {
      limits.passwordFailed(account);
      throw new ApiError("unauthenticated", "That email or password isn't right.");
    }
    limits.passwordOk(account);
    await startSession(c, deps, person.orgId, person.id);
    return c.json({ person: personView(person) });
  });

  // A CLI token can end itself, so `artifacts logout` leaves nothing valid behind.
  routes.post("/api/auth/logout", { action: "account.read" }, async (c) => {
    const caller = c.get("caller");
    if (caller.kind === "person") {
      await db.delete(sessions).where(eq(sessions.id, caller.sessionId));
      clearCookie(c, SESSION_COOKIE);
    } else if (caller.kind === "cliToken") {
      await db.update(tokens).set({ revokedAt: clock.now() }).where(eq(tokens.id, caller.tokenId));
    }
    return c.json({ ok: true });
  });

  routes.post("/api/auth/reauth", { action: "account.manage" }, async (c) => {
    const caller = sessionOf(c.get("caller"));
    const body = await parseBody(c, Reauth);
    if (!("password" in body)) {
      await passkeys.reauth(c as ApiContext, body.challengeId, body.response);
      return c.json({ ok: true });
    }
    const account = caller.person.email.toLowerCase();
    limits.checkPassword(account, deps.clientIp(c));
    if (body.password.length > MAX_PASSWORD)
      throw new ApiError("unauthenticated", "That password isn't right.");
    const person = await checkPassword(c.get("org").id, caller.person.email, body.password);
    if (!person) {
      limits.passwordFailed(account);
      throw new ApiError("unauthenticated", "That password isn't right.");
    }
    limits.passwordOk(account);
    await db.update(sessions).set({ authAt: clock.now() }).where(eq(sessions.id, caller.sessionId));
    return c.json({ ok: true });
  });

  routes.get("/api/me", { action: "account.read" }, (c) => {
    const caller = c.get("caller");
    return c.json({
      person: personOf(caller),
      org: { name: c.get("org").name },
      recentAuth: caller.kind === "person" && caller.recentAuth,
    });
  });

  routes.get("/api/me/sessions", { action: "account.manage" }, async (c) => {
    const caller = sessionOf(c.get("caller"));
    const now = clock.now();
    const [open, cli] = await Promise.all([
      db
        .select()
        .from(sessions)
        .where(and(eq(sessions.personId, caller.person.id), gt(sessions.expiresAt, now)))
        .orderBy(desc(sessions.lastSeenAt)),
      db
        .select()
        .from(tokens)
        .where(and(eq(tokens.personId, caller.person.id), eq(tokens.kind, "cli"), isNull(tokens.revokedAt)))
        .orderBy(desc(tokens.createdAt)),
    ]);
    return c.json([
      ...open.map((row) => ({
        id: row.id,
        kind: "session" as const,
        name: row.domain,
        userAgent: row.userAgent,
        lastSeenAt: row.lastSeenAt.toISOString(),
        current: row.id === caller.sessionId,
      })),
      ...cli.map((row) => ({
        id: row.id,
        kind: "cli" as const,
        name: row.name,
        userAgent: null,
        lastSeenAt: row.lastUsedAt?.toISOString() ?? null,
        current: false,
      })),
    ]);
  });

  routes.delete("/api/me/sessions/:id", { action: "account.manage" }, async (c) => {
    const caller = sessionOf(c.get("caller"));
    const id = c.req.param("id") as string;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError("not_found", "Not found.");
    const ended = await db
      .delete(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.personId, caller.person.id)))
      .returning({ id: sessions.id });
    if (ended.length > 0) return c.json({ ok: true });
    const revoked = await db
      .update(tokens)
      .set({ revokedAt: clock.now() })
      .where(and(eq(tokens.id, id), eq(tokens.personId, caller.person.id), isNull(tokens.revokedAt)))
      .returning({ id: tokens.id });
    if (revoked.length === 0) throw new ApiError("not_found", "Not found.");
    return c.json({ ok: true });
  });

  routes.post("/api/me/password", { action: "account.manage", recentAuth: true }, async (c) => {
    const caller = sessionOf(c.get("caller"));
    const { password } = await parseBody(c, ChangePassword);
    await setPassword(c.get("org").id, caller.person.id, password);
    await db
      .delete(sessions)
      .where(and(eq(sessions.personId, caller.person.id), ne(sessions.id, caller.sessionId)));
    return c.json({ ok: true });
  });

  async function setPassword(orgId: string, personId: string, password: string) {
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    const updatedAt = clock.now();
    await db
      .insert(passwords)
      .values({ personId, orgId, hash, updatedAt })
      .onConflictDoUpdate({ target: passwords.personId, set: { hash, updatedAt } });
    // A new password ends the reset links still out there, or a leaked one would undo it.
    await db
      .update(resetLinks)
      .set({ usedAt: updatedAt })
      .where(and(eq(resetLinks.personId, personId), isNull(resetLinks.usedAt)));
  }

  async function liveReset(c: ApiContext) {
    const [link] = await db
      .select()
      .from(resetLinks)
      .where(
        and(
          eq(resetLinks.orgId, c.get("org").id),
          eq(resetLinks.tokenHash, sha256(c.req.param("token") as string)),
        ),
      )
      .limit(1);
    if (!link || link.usedAt || link.expiresAt <= clock.now()) {
      throw new ApiError(
        "gone",
        "This reset link has expired or was already used. Ask an admin for a new one.",
      );
    }
    return link;
  }

  routes.get("/api/reset/:token", { public: true }, async (c) => {
    const link = await liveReset(c as ApiContext);
    const [person] = await db.select().from(people).where(eq(people.id, link.personId)).limit(1);
    if (!person || person.removedAt) throw new ApiError("gone", "This reset link no longer works.");
    return c.json({ email: person.email });
  });

  routes.post("/api/reset/:token", { public: true }, async (c) => {
    const link = await liveReset(c as ApiContext);
    const { password } = await parseBody(c, ResetPassword);
    const used = await db
      .update(resetLinks)
      .set({ usedAt: clock.now() })
      .where(and(eq(resetLinks.id, link.id), isNull(resetLinks.usedAt)))
      .returning({ id: resetLinks.id });
    if (used.length === 0) throw new ApiError("gone", "This reset link was already used.");
    const [person] = await db
      .select()
      .from(people)
      .where(and(eq(people.id, link.personId), isNull(people.removedAt)))
      .limit(1);
    if (!person) throw new ApiError("gone", "This reset link no longer works.");
    await setPassword(link.orgId, person.id, password);
    // A reset is the way back from a suspected takeover, so nothing the attacker holds may outlive it:
    // sessions, CLI tokens and passkeys all end. (A routine password change leaves the last two alone.)
    // Org tokens aren't personal, so they stay.
    const now = clock.now();
    await db.transaction(async (tx) => {
      await tx.delete(sessions).where(eq(sessions.personId, person.id));
      await tx
        .update(tokens)
        .set({ revokedAt: now })
        .where(and(eq(tokens.personId, person.id), eq(tokens.kind, "cli"), isNull(tokens.revokedAt)));
      await tx.delete(passkeyRows).where(eq(passkeyRows.personId, person.id));
    });
    await startSession(c, deps, link.orgId, person.id);
    return c.json({ person: personView(person) });
  });
}
