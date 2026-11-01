import { createHash } from "node:crypto";
import { CONSUMER_DOMAINS, type GoogleSettings, PatchGoogle, SaveGoogle } from "@artifacts/schema";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { can } from "../auth/can.ts";
import { type GoogleClaims, googleProvider, readIdToken } from "../auth/google.ts";
import { randomSecret, sha256 } from "../auth/secrets.ts";
import { isSecureRequest, startSession } from "../auth/sessions.ts";
import type { OrgRow } from "../db/index.ts";
import {
  activity,
  googleStates,
  identities,
  org as orgTable,
  passkeys,
  passwords,
  people,
  removedIdentities,
  sessions,
} from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { requestOrigin } from "../oauth/origin.ts";
import { isUuid } from "./artifacts-db.ts";
import type { Deps } from "./deps.ts";
import { acceptInvite, findLiveInvite, joinTeams } from "./join.ts";
import { type ApiContext, parseBody, type Routes } from "./routes.ts";

export const CALLBACK_PATH = "/api/auth/google/callback";
const COOKIE = "art_google";
const COOKIE_PATH = "/api/auth/google";
const STATE_MS = 10 * 60_000;
const WINDOW_MS = 15 * 60_000;
const PROVIDER = "google";
const SIGNED_IN = ["link", "reauth", "test"];
const INTENTS = ["signin", "invite", ...SIGNED_IN];

/** Same checks as the viewer's safeNext: only a path on this site, so a crafted link can't send someone away. */
const safePath = (value: string | undefined) =>
  value?.startsWith("/") && !value.startsWith("//") && !/[\\\s]/.test(value) ? value : "/";

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

type StateRow = typeof googleStates.$inferSelect;

export function googleRoutes(routes: Routes, deps: Deps) {
  const { db, clock, limits } = deps;
  const provider = deps.google ?? googleProvider;

  const back = (c: Context, path: string, code: string) =>
    c.redirect(`${path}${path.includes("?") ? "&" : "?"}google=${code}`, 302);

  const hasClient = (row: OrgRow) => Boolean(row.googleClientId && row.googleClientSecret);

  /** A link starts this, and a link can be followed from anywhere, so these need one from this site. */
  function fromThisSite(c: Context) {
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin") throw new ApiError("forbidden", "Start this from the viewer.");
  }

  routes.get("/api/auth/google/start", { public: true }, async (c) => {
    limits.hit(`google-start:${deps.clientIp(c)}`, 60, WINDOW_MS);
    const org = c.get("org");
    const intent = c.req.query("intent") ?? "signin";
    if (!INTENTS.includes(intent)) throw new ApiError("invalid", "That isn't something to do with Google.");
    const origin = await requestOrigin(c, deps);
    // Off means these routes do nothing. Test is how it comes on.
    if (!origin || !hasClient(org) || (intent !== "test" && !org.googleEnabled)) {
      throw new ApiError("not_found", "Not found.");
    }
    const next = safePath(c.req.query("next"));
    const caller = c.get("caller");
    let inviteId: string | null = null;
    let loginHint: string | null = null;

    if (SIGNED_IN.includes(intent)) {
      fromThisSite(c);
      if (caller.kind !== "person") return c.redirect(`/sign-in?next=${encodeURIComponent(next)}`, 302);
      if (intent === "test" && !can(caller, "org.manage", { type: "org" })) {
        throw new ApiError("forbidden", "You can't do that.");
      }
      if (intent !== "reauth" && !caller.recentAuth) return back(c, next, "recent");
      if (intent === "reauth") {
        const [identity] = await db
          .select()
          .from(identities)
          .where(and(eq(identities.personId, caller.person.id), eq(identities.provider, PROVIDER)))
          .limit(1);
        if (!identity) return back(c, next, "not-linked");
        loginHint = identity.subject;
      }
    }
    if (intent === "invite") {
      const tokenHash = sha256(c.req.query("invite") ?? "");
      const invite = await findLiveInvite(deps, org.id, { tokenHash }).catch(() => null);
      if (!invite) return back(c, "/sign-in", "invite-gone");
      inviteId = invite.id;
    }

    const state = randomSecret();
    const browser = randomSecret();
    const nonce = randomSecret();
    const verifier = randomSecret();
    const redirectUri = `${origin}${CALLBACK_PATH}`;
    const now = clock.now();
    await db.delete(googleStates).where(lt(googleStates.expiresAt, now));
    await db.insert(googleStates).values({
      id: Bun.randomUUIDv7(),
      orgId: org.id,
      stateHash: sha256(state),
      browserHash: sha256(browser),
      nonce,
      codeVerifier: verifier,
      intent,
      sessionId: caller.kind === "person" && SIGNED_IN.includes(intent) ? caller.sessionId : null,
      personId: caller.kind === "person" && SIGNED_IN.includes(intent) ? caller.person.id : null,
      inviteId,
      next,
      redirectUri,
      expiresAt: new Date(now.getTime() + STATE_MS),
    });
    // Lax, because Google's redirect back is a navigation from another site, which Strict wouldn't send.
    setCookie(c, COOKIE, browser, {
      httpOnly: true,
      secure: isSecureRequest(c, await deps.origins()),
      sameSite: "Lax",
      path: COOKIE_PATH,
      maxAge: STATE_MS / 1000,
    });
    const url = new URL(provider.authorizeUrl);
    url.search = new URLSearchParams({
      client_id: org.googleClientId as string,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: s256(verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
      ...(loginHint ? { login_hint: loginHint } : {}),
    }).toString();
    return c.redirect(url.toString(), 302);
  });

  /** Where a failed round trip lands, so the person sees it where they started. */
  const homeOf = (row: StateRow) => {
    if (row.intent === "link") return "/settings/sign-in";
    if (row.intent === "test") return "/settings/google";
    if (row.intent === "reauth") return row.next;
    return "/sign-in";
  };

  const remember = (claims: GoogleClaims) => ({
    email: claims.email,
    hostedDomain: claims.hostedDomain,
    lastUsedAt: clock.now(),
  });

  const linkedActivity = (orgId: string, personId: string, name: string) =>
    db.insert(activity).values({
      id: Bun.randomUUIDv7(),
      orgId,
      actorPersonId: personId,
      kind: "identity_linked",
      payload: { person: name, provider: PROVIDER },
      createdAt: clock.now(),
    });

  /** The table in 04. Email alone never links an existing account: nothing proves anyone owns theirs. */
  async function signIn(c: Context, org: OrgRow, row: StateRow, claims: GoogleClaims) {
    const [known] = await db
      .select({ identity: identities, person: people })
      .from(identities)
      .innerJoin(people, eq(people.id, identities.personId))
      .where(
        and(
          eq(identities.orgId, org.id),
          eq(identities.provider, PROVIDER),
          eq(identities.subject, claims.sub),
          sql`${people.removedAt} is null`,
        ),
      )
      .limit(1);
    if (known) {
      await db.update(identities).set(remember(claims)).where(eq(identities.id, known.identity.id));
      await startSession(c, deps, org.id, known.person.id);
      return c.redirect(row.next, 302);
    }
    const sameEmail = await db
      .select()
      .from(people)
      .where(and(eq(people.orgId, org.id), sql`lower(${people.email}) = lower(${claims.email})`));
    if (sameEmail.some((person) => person.removedAt === null)) {
      return c.redirect("/sign-in?google=link-first&next=%2Fsettings%2Fsign-in", 302);
    }
    // Someone removed stays out: an open door on the domain would undo offboarding.
    const join = org.settings.googleAutoJoin;
    const [removed] = await db
      .select({ hash: removedIdentities.subjectHash })
      .from(removedIdentities)
      .where(
        and(
          eq(removedIdentities.orgId, org.id),
          eq(removedIdentities.provider, PROVIDER),
          eq(removedIdentities.subjectHash, sha256(claims.sub)),
        ),
      )
      .limit(1);
    if (
      join &&
      !removed &&
      sameEmail.length === 0 &&
      claims.hostedDomain === join.domain &&
      !CONSUMER_DOMAINS.includes(claims.hostedDomain)
    ) {
      const person = await db.transaction(async (tx) => {
        const [made] = await tx
          .insert(people)
          .values({
            id: Bun.randomUUIDv7(),
            orgId: org.id,
            email: claims.email,
            name: claims.name ?? (claims.email.split("@")[0] as string),
            role: join.role,
          })
          .returning();
        if (!made) throw new Error("no person row");
        await tx.insert(identities).values({
          id: Bun.randomUUIDv7(),
          orgId: org.id,
          personId: made.id,
          provider: PROVIDER,
          subject: claims.sub,
          ...remember(claims),
        });
        await joinTeams(tx, org.id, made.id, join.teamIds, made.id);
        await tx.insert(activity).values({
          id: Bun.randomUUIDv7(),
          orgId: org.id,
          actorPersonId: made.id,
          kind: "joined",
          payload: { role: join.role, via: PROVIDER },
          createdAt: clock.now(),
        });
        return made;
      });
      await startSession(c, deps, org.id, person.id);
      return c.redirect(row.next, 302);
    }
    return back(c, "/sign-in", "no-account");
  }

  async function join(c: Context, org: OrgRow, row: StateRow, claims: GoogleClaims) {
    const invite = await findLiveInvite(deps, org.id, { id: row.inviteId as string });
    if (invite.email.toLowerCase() !== claims.email.toLowerCase()) {
      return back(c, "/sign-in", "invite-mismatch");
    }
    const [used] = await db
      .select({ id: identities.id })
      .from(identities)
      .where(
        and(
          eq(identities.orgId, org.id),
          eq(identities.provider, PROVIDER),
          eq(identities.subject, claims.sub),
        ),
      )
      .limit(1);
    if (used) return back(c, "/sign-in", "in-use");
    const person = await db.transaction(async (tx) => {
      const made = await acceptInvite(tx, invite, {
        name: claims.name ?? (claims.email.split("@")[0] as string),
        passwordHash: null,
        now: clock.now(),
      });
      await tx.insert(identities).values({
        id: Bun.randomUUIDv7(),
        orgId: org.id,
        personId: made.id,
        provider: PROVIDER,
        subject: claims.sub,
        ...remember(claims),
      });
      return made;
    });
    await startSession(c, deps, org.id, person.id);
    return c.redirect("/", 302);
  }

  /** The session that started this, in the browser that started it, still there and still its person. */
  function sameSession(c: Context, row: StateRow) {
    const caller = c.get("caller");
    return caller.kind === "person" && caller.sessionId === row.sessionId && caller.person.id === row.personId
      ? caller
      : null;
  }

  async function link(c: Context, org: OrgRow, row: StateRow, claims: GoogleClaims) {
    const caller = sameSession(c, row);
    if (!caller?.recentAuth) return back(c, "/settings/sign-in", "recent");
    // Holds the session row, so a reset committing now can't miss what's added here.
    const added = await db.transaction(async (tx) => {
      const [live] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, caller.sessionId))
        .for("update");
      if (!live) return null;
      return tx
        .insert(identities)
        .values({
          id: Bun.randomUUIDv7(),
          orgId: org.id,
          personId: caller.person.id,
          provider: PROVIDER,
          subject: claims.sub,
          ...remember(claims),
        })
        .onConflictDoNothing()
        .returning({ id: identities.id });
    });
    if (!added) return back(c, "/settings/sign-in", "expired");
    if (added.length === 0) return back(c, "/settings/sign-in", "in-use");
    await linkedActivity(org.id, caller.person.id, caller.person.name);
    return back(c, "/settings/sign-in", "linked");
  }

  async function reauth(c: Context, row: StateRow, claims: GoogleClaims) {
    const caller = sameSession(c, row);
    if (!caller) return back(c, row.next, "expired");
    const [identity] = await db
      .select()
      .from(identities)
      .where(
        and(
          eq(identities.personId, caller.person.id),
          eq(identities.provider, PROVIDER),
          eq(identities.subject, claims.sub),
        ),
      )
      .limit(1);
    if (!identity) return back(c, row.next, "mismatch");
    await db.update(identities).set(remember(claims)).where(eq(identities.id, identity.id));
    await db.update(sessions).set({ authAt: clock.now() }).where(eq(sessions.id, caller.sessionId));
    return back(c, row.next, "confirmed");
  }

  routes.get("/api/auth/google/callback", { public: true }, async (c) => {
    limits.hit(`google-callback:${deps.clientIp(c)}`, 60, WINDOW_MS);
    const org = c.get("org");
    const state = c.req.query("state") ?? "";
    const browser = getCookie(c, COOKIE);
    deleteCookie(c, COOKIE, { path: COOKIE_PATH });
    // Whoever deletes the row owns it, so a state works once, even if it then turns out to be wrong.
    const [row] = await db
      .delete(googleStates)
      .where(
        and(
          eq(googleStates.orgId, org.id),
          eq(googleStates.stateHash, sha256(state)),
          gt(googleStates.expiresAt, clock.now()),
        ),
      )
      .returning();
    // Without the cookie, someone could send a callback link and sign a person into their own account.
    if (!row || !browser || sha256(browser) !== row.browserHash) return back(c, "/sign-in", "expired");
    const home = homeOf(row);
    if (!hasClient(org) || (row.intent !== "test" && !org.googleEnabled)) return back(c, home, "off");
    const code = c.req.query("code");
    if (!code) return back(c, home, "cancelled");
    const clientId = org.googleClientId as string;
    let claims: GoogleClaims | null;
    try {
      const idToken = await provider.exchange({
        code,
        verifier: row.codeVerifier,
        redirectUri: row.redirectUri,
        clientId,
        clientSecret: org.googleClientSecret as string,
      });
      claims = readIdToken(idToken, { clientId, nonce: row.nonce, now: clock.now() });
    } catch (error) {
      deps.log.warn("Google refused a sign-in", { error: String(error) });
      return back(c, home, "failed");
    }
    if (!claims) return back(c, home, "failed");
    if (!claims.emailVerified) return back(c, home, "unverified");
    try {
      switch (row.intent) {
        case "signin":
          return await signIn(c, org, row, claims);
        case "invite":
          return await join(c, org, row, claims);
        case "link":
          return await link(c, org, row, claims);
        case "reauth":
          return await reauth(c, row, claims);
        default: {
          const caller = sameSession(c, row);
          if (!caller || !can(caller, "org.manage", { type: "org" })) return back(c, home, "expired");
          // Only for the credentials that just worked: they may have been replaced on the way.
          const proved = await db
            .update(orgTable)
            .set({ googleTestedBy: caller.person.id })
            .where(
              and(
                eq(orgTable.id, org.id),
                eq(orgTable.googleClientId, clientId),
                eq(orgTable.googleClientSecret, org.googleClientSecret as string),
              ),
            )
            .returning({ id: orgTable.id });
          return back(c, home, proved.length > 0 ? "tested" : "failed");
        }
      }
    } catch (error) {
      if (error instanceof ApiError) return back(c, home, error.code === "gone" ? "invite-gone" : "in-use");
      // Two people racing for one email or Google account: the unique index settled it.
      if ((error as { cause?: { code?: string } }).cause?.code === "23505") return back(c, home, "in-use");
      throw error;
    }
  });

  routes.get("/api/me/identities", { action: "account.manage" }, async (c) => {
    const caller = c.get("caller");
    if (caller.kind !== "person") throw new ApiError("forbidden", "This needs a signed-in browser.");
    const { id } = caller.person;
    const [rows, keys, password] = await Promise.all([
      db.select().from(identities).where(eq(identities.personId, id)),
      db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.personId, id)),
      db.select({ id: passwords.personId }).from(passwords).where(eq(passwords.personId, id)).limit(1),
    ]);
    return c.json({
      identities: rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        email: row.email,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      })),
      passkeys: keys.length,
      password: password.length > 0,
      google: c.get("org").googleEnabled,
    });
  });

  routes.delete("/api/me/identities/:id", { action: "account.manage", recentAuth: true }, async (c) => {
    const caller = c.get("caller");
    if (caller.kind !== "person") throw new ApiError("forbidden", "This needs a signed-in browser.");
    const id = c.req.param("id");
    const { id: personId } = caller.person;
    const [row] = isUuid(id)
      ? await db
          .select()
          .from(identities)
          .where(and(eq(identities.id, id), eq(identities.personId, personId)))
          .limit(1)
      : [];
    if (!row) throw new ApiError("not_found", "Not found.");
    const [keys, password] = await Promise.all([
      db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.personId, personId)).limit(1),
      db.select({ id: passwords.personId }).from(passwords).where(eq(passwords.personId, personId)).limit(1),
    ]);
    if (keys.length === 0 && password.length === 0) {
      throw new ApiError("conflict", "This is your only way to sign in. Add another first.");
    }
    await db.delete(identities).where(eq(identities.id, row.id));
    return c.json({ ok: true });
  });

  /** Turning Google off with no other way in would leave nobody able to confirm it's them, or to undo it. */
  async function guardLockout(c: ApiContext) {
    const caller = c.get("caller");
    if (caller.kind !== "person") return;
    const { id } = caller.person;
    const [keys, password] = await Promise.all([
      db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.personId, id)).limit(1),
      db.select({ id: passwords.personId }).from(passwords).where(eq(passwords.personId, id)).limit(1),
    ]);
    if (keys.length === 0 && password.length === 0) {
      throw new ApiError("conflict", "Add a password or a passkey first, or you'd lose your way in.");
    }
  }

  async function settingsOf(c: ApiContext): Promise<GoogleSettings> {
    const [row] = await db
      .select()
      .from(orgTable)
      .where(eq(orgTable.id, c.get("org").id))
      .limit(1);
    const caller = c.get("caller");
    return {
      clientId: row?.googleClientId ?? null,
      hasSecret: Boolean(row?.googleClientSecret),
      enabled: row?.googleEnabled ?? false,
      tested: caller.kind === "person" && row?.googleTestedBy === caller.person.id,
      redirectUris: (await deps.origins()).map((origin) => `${origin}${CALLBACK_PATH}`),
      autoJoin: (row?.settings as OrgRow["settings"] | undefined)?.googleAutoJoin ?? null,
    };
  }

  routes.get("/api/org/google", { action: "org.manage" }, async (c) =>
    c.json(await settingsOf(c as ApiContext)),
  );

  // New credentials haven't been proved, so Google goes off until someone tests them.
  routes.put("/api/org/google", { action: "org.manage", recentAuth: true }, async (c) => {
    const { clientId, clientSecret } = await parseBody(c, SaveGoogle);
    const current = c.get("org");
    await guardLockout(c as ApiContext);
    if (!clientSecret && !current.googleClientSecret) {
      throw new ApiError("invalid", "Paste the client secret too.");
    }
    await db
      .update(orgTable)
      .set({
        googleClientId: clientId,
        googleClientSecret: clientSecret ?? current.googleClientSecret,
        googleEnabled: false,
        googleTestedBy: null,
      })
      .where(eq(orgTable.id, current.id));
    return c.json(await settingsOf(c as ApiContext));
  });

  routes.patch("/api/org/google", { action: "org.manage", recentAuth: true }, async (c) => {
    const { enabled, autoJoin } = await parseBody(c, PatchGoogle);
    const current = c.get("org");
    const caller = c.get("caller");
    if (enabled === false) await guardLockout(c as ApiContext);
    if (enabled && (caller.kind !== "person" || current.googleTestedBy !== caller.person.id)) {
      throw new ApiError("conflict", "Run a test with your own account first.");
    }
    await db
      .update(orgTable)
      .set({
        googleEnabled: enabled ?? current.googleEnabled,
        settings: {
          ...current.settings,
          googleAutoJoin: autoJoin === undefined ? current.settings.googleAutoJoin : autoJoin,
        },
      })
      .where(eq(orgTable.id, current.id));
    return c.json(await settingsOf(c as ApiContext));
  });

  routes.delete("/api/org/google", { action: "org.manage", recentAuth: true }, async (c) => {
    const current = c.get("org");
    await guardLockout(c as ApiContext);
    await db
      .update(orgTable)
      .set({
        googleClientId: null,
        googleClientSecret: null,
        googleEnabled: false,
        googleTestedBy: null,
        settings: { ...current.settings, googleAutoJoin: null },
      })
      .where(eq(orgTable.id, current.id));
    return c.json({ ok: true });
  });
}
