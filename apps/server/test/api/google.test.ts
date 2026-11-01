import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { GoogleExchange } from "../../src/auth/google.ts";
import { sha256 } from "../../src/auth/secrets.ts";
import { findOrg } from "../../src/db/index.ts";
import {
  activity,
  googleStates,
  identities,
  invites,
  org,
  passwords,
  people,
  resetLinks,
  sessions,
  teamMembers,
} from "../../src/db/schema.ts";
import { claim, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { makeAccount } from "../publish-helper.ts";

const CLIENT = "client.apps.googleusercontent.com";
const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;
const cookieNamed = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.split(";")[0];
const SITE = { "Sec-Fetch-Site": "same-origin" };

type Claims = Record<string, unknown>;

/** Google, as far as the server can tell. Each test says who signs in, and how the token is wrong. */
class FakeGoogle {
  authorizeUrl = "https://accounts.example.test/auth";
  claims: Claims = {};
  raw: string | null = null;
  fail = false;
  during: (() => Promise<void>) | null = null;
  calls: GoogleExchange[] = [];
  /** By verifier, because two round trips can be under way at once. */
  nonces = new Map<string, string>();

  reset() {
    this.claims = {};
    this.raw = null;
    this.fail = false;
    this.during = null;
    this.calls = [];
  }

  async exchange(input: GoogleExchange) {
    this.calls.push(input);
    await this.during?.();
    if (this.fail) throw new Error("no");
    if (this.raw !== null) return this.raw;
    const body = {
      iss: "https://accounts.google.com",
      aud: CLIENT,
      exp: Math.floor(this.now() / 1000) + 3600,
      nonce: this.nonces.get(input.verifier),
      email_verified: true,
      ...this.claims,
    };
    return `e30.${Buffer.from(JSON.stringify(body)).toString("base64url")}.sig`;
  }

  now = () => Date.now();
}

describe("Google sign-in", () => {
  const google = new FakeGoogle();
  let t: TestServer;
  let owner: string;
  let orgId: string;
  let ownerToken: string;

  const turnOn = () =>
    t.server.db
      .update(org)
      .set({ googleClientId: CLIENT, googleClientSecret: "shh", googleEnabled: true })
      .where(eq(org.id, orgId));

  /** The browser's half: goes to start, then comes back from Google with the same cookie. */
  async function begin(query: string, cookie?: string, headers: Record<string, string> = {}) {
    const response = await t.api(`/api/auth/google/start?${query}`, {
      redirect: "manual",
      cookie,
      headers,
    });
    const location = response.headers.get("location") ?? "";
    const url = location.startsWith("http") ? new URL(location) : null;
    const browser = cookieNamed(response, "art_google");
    const [row] = browser
      ? await t.server.db
          .select()
          .from(googleStates)
          .where(eq(googleStates.browserHash, sha256(browser.split("=")[1] as string)))
      : [];
    if (row) google.nonces.set(row.codeVerifier, row.nonce);
    return { response, url, state: url?.searchParams.get("state") ?? "", browser, row };
  }
  const finish = (state: string, cookie: string, extra = "code=abc") =>
    t.api(`/api/auth/google/callback?state=${encodeURIComponent(state)}&${extra}`, {
      redirect: "manual",
      cookie,
    });
  async function roundTrip(query: string, claims: Claims, session?: string) {
    google.claims = claims;
    const { state, browser } = await begin(query, session, SITE);
    return finish(state, [browser, session].filter(Boolean).join("; "));
  }
  const landed = (response: Response) => response.headers.get("location");
  let n = 0;
  const sub = () => {
    n += 1;
    return `g-${n}`;
  };
  const account = (email: string, more: Claims = {}) => ({ sub: sub(), email, name: "Someone", ...more });
  const linkOf = async (personId: string, subject: string) =>
    t.server.db.insert(identities).values({
      id: Bun.randomUUIDv7(),
      orgId,
      personId,
      provider: "google",
      subject,
      email: "linked@example.com",
    });

  beforeAll(async () => {
    t = await startTestServer({}, { google });
    ownerToken = (await claim(t)).token;
    owner = await signIn(t, OWNER.email, OWNER.password);
    orgId = ((await findOrg(t.server.db)) as { id: string }).id;
  });
  afterAll(() => t.stop());
  beforeEach(async () => {
    google.reset();
    await turnOn();
    // Tests move the clock, and the owner's own sign-in shouldn't age with it.
    await t.server.db.update(sessions).set({ authAt: t.clock.now() });
  });

  describe("turned off", () => {
    test("nothing answers, and the sign-in page has nothing to show", async () => {
      await t.server.db
        .update(org)
        .set({ googleEnabled: false, googleClientId: null, googleClientSecret: null })
        .where(eq(org.id, orgId));
      expect((await t.api("/api/auth/google/start", { redirect: "manual" })).status).toBe(404);
      expect(await t.api("/api/meta").then(json)).toMatchObject({ google: false });
      expect(landed(await finish("anything", "art_google=x"))).toBe("/sign-in?google=expired");
    });

    test("a round trip started while it was on stops at the callback", async () => {
      const { state, browser } = await begin("intent=signin");
      await t.server.db.update(org).set({ googleEnabled: false }).where(eq(org.id, orgId));
      expect(landed(await finish(state, browser as string))).toBe("/sign-in?google=off");
    });
  });

  describe("starting", () => {
    test("asks for a code with PKCE, state and nonce, and sends the browser a host-only cookie", async () => {
      const { url, state, browser, row, response } = await begin("intent=signin&next=/camerabuddy");
      expect(url?.origin + (url?.pathname ?? "")).toBe(google.authorizeUrl);
      const params = url?.searchParams as URLSearchParams;
      expect(params.get("client_id")).toBe(CLIENT);
      expect(params.get("response_type")).toBe("code");
      expect(params.get("scope")).toBe("openid email profile");
      expect(params.get("code_challenge_method")).toBe("S256");
      expect(params.get("nonce")).toBe(row?.nonce as string);
      expect(params.has("hd")).toBe(false);
      expect(params.get("code_challenge")).toBe(
        createHash("sha256")
          .update(row?.codeVerifier as string)
          .digest("base64url"),
      );
      expect(params.get("redirect_uri")).toBe("http://viewer.test/api/auth/google/callback");
      expect(row?.stateHash).toBe(sha256(state));
      const set = response.headers.getSetCookie().find((cookie) => cookie.startsWith("art_google="));
      expect(set).toContain("HttpOnly");
      expect(set).toContain("SameSite=Lax");
      expect(set).toContain("Path=/api/auth/google");
      expect(set).not.toContain("Domain=");
      expect(browser).toBeString();
    });

    test("each viewer origin gets its own redirect", async () => {
      const response = await t.api("/api/auth/google/start", {
        redirect: "manual",
        headers: { Host: "art.example.org" },
      });
      const url = new URL(response.headers.get("location") as string);
      expect(url.searchParams.get("redirect_uri")).toBe("https://art.example.org/api/auth/google/callback");
    });

    test("never on the Live-preview host", async () => {
      const response = await fetch(`http://127.0.0.1:${t.server.ports.content}/api/auth/google/start`, {
        headers: { Host: "content.test" },
        redirect: "manual",
      });
      expect(response.status).toBe(404);
    });

    test("next stays on this site", async () => {
      for (const next of [
        "https://evil.test",
        "//evil.test",
        "/\\evil.test",
        "/%09/evil.test".replace("%09", "\t"),
      ]) {
        const { row } = await begin(`next=${encodeURIComponent(next)}`);
        expect(row?.next).toBe("/");
      }
    });

    test("an unknown intent is refused, and starting is rate limited", async () => {
      expect((await t.api("/api/auth/google/start?intent=nonsense")).status).toBe(400);
    });

    test("anything tied to a session can't be started from another site", async () => {
      const response = await t.api("/api/auth/google/start?intent=reauth", {
        cookie: owner,
        redirect: "manual",
        headers: { "Sec-Fetch-Site": "cross-site" },
      });
      expect(response.status).toBe(403);
    });
  });

  describe("the flow table", () => {
    test("a known sub signs in, even if the email has changed", async () => {
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person.id, subject);
      const response = await roundTrip("intent=signin&next=/camerabuddy", {
        sub: subject,
        email: "new-address@elsewhere.test",
      });
      expect(landed(response)).toBe("/camerabuddy");
      const cookie = cookieNamed(response, "art_session") as string;
      expect(await t.api("/api/me", { cookie }).then(json)).toMatchObject({
        person: { id: person.id },
        recentAuth: true,
      });
      const [row] = await t.server.db.select().from(identities).where(eq(identities.subject, subject));
      expect(row).toMatchObject({ email: "new-address@elsewhere.test" });
      expect(row?.lastUsedAt).not.toBeNull();
    });

    test("an email that matches someone never links: they're told to sign in the usual way", async () => {
      const person = await makeAccount(t, orgId, "member");
      const response = await roundTrip("intent=signin", account(person.email));
      expect(landed(response)).toBe("/sign-in?google=link-first&next=%2Fsettings%2Fsign-in");
      expect(cookieNamed(response, "art_session")).toBeUndefined();
      expect(await t.server.db.select().from(identities).where(eq(identities.personId, person.id))).toEqual(
        [],
      );
    });

    test("the same goes for an account with a different capital letter", async () => {
      const person = await makeAccount(t, orgId, "member");
      const response = await roundTrip("intent=signin", account(person.email.toUpperCase()));
      expect(landed(response)).toContain("link-first");
    });

    test("nobody here: refused", async () => {
      const response = await roundTrip("intent=signin", account("stranger@elsewhere.test"));
      expect(landed(response)).toBe("/sign-in?google=no-account");
      expect(cookieNamed(response, "art_session")).toBeUndefined();
    });

    const invite = async (email: string, role = "member") => {
      const made = await json<{ url: string }>(
        await t.api("/api/invites", { method: "POST", cookie: owner, json: { email, role } }),
      );
      return made.url.split("/join/")[1] as string;
    };

    test("on an invite, with the same email: the account is made and linked", async () => {
      const secret = await invite("Invited@Example.com");
      const details = account("invited@example.com", { name: "Invited Person" });
      const response = await roundTrip(`intent=invite&invite=${secret}`, details);
      expect(landed(response)).toBe("/");
      const cookie = cookieNamed(response, "art_session") as string;
      const me = await json<{ person: { id: string; name: string; role: string } }>(
        await t.api("/api/me", { cookie }),
      );
      expect(me.person).toMatchObject({ name: "Invited Person", role: "member" });
      const [row] = await t.server.db.select().from(identities).where(eq(identities.personId, me.person.id));
      expect(row?.subject).toBe(details.sub as string);
      expect(await t.server.db.select().from(passwords).where(eq(passwords.personId, me.person.id))).toEqual(
        [],
      );
      expect((await t.api(`/api/invites/${secret}`)).status).toBe(410);
    });

    test("on an invite, with a different email: refused, and the invite still works", async () => {
      const secret = await invite("expected@example.com");
      const response = await roundTrip(`intent=invite&invite=${secret}`, account("someone-else@example.com"));
      expect(landed(response)).toBe("/sign-in?google=invite-mismatch");
      expect(cookieNamed(response, "art_session")).toBeUndefined();
      expect((await t.api(`/api/invites/${secret}`)).status).toBe(200);
    });

    test("a dead invite goes nowhere", async () => {
      const response = await t.api("/api/auth/google/start?intent=invite&invite=nope", {
        redirect: "manual",
      });
      expect(landed(response)).toBe("/sign-in?google=invite-gone");
    });

    test("a Google account already linked can't take an invite too", async () => {
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person.id, subject);
      const secret = await invite("second@example.com");
      const response = await roundTrip(`intent=invite&invite=${secret}`, {
        sub: subject,
        email: "second@example.com",
      });
      expect(landed(response)).toBe("/sign-in?google=in-use");
    });

    test("an invite's grants come with Google too", async () => {
      const team = await json<{ team: { id: string } }>(
        await t.api("/api/teams", { method: "POST", cookie: owner, json: { name: `With invite ${sub()}` } }),
      );
      const made = await json<{ url: string }>(
        await t.api("/api/invites", {
          method: "POST",
          cookie: owner,
          json: { email: "team@example.com", role: "reviewer", teamIds: [team.team.id] },
        }),
      );
      const response = await roundTrip(
        `intent=invite&invite=${made.url.split("/join/")[1]}`,
        account("team@example.com"),
      );
      const { person } = await json<{ person: { id: string } }>(
        await t.api("/api/me", { cookie: cookieNamed(response, "art_session") as string }),
      );
      const rows = await t.server.db.select().from(teamMembers).where(eq(teamMembers.personId, person.id));
      expect(rows.map((row) => row.teamId)).toEqual([team.team.id]);
    });
  });

  describe("the negative cases", () => {
    const signedInWith = async (claims: Claims) => {
      const subject = sub();
      const person = await makeAccount(t, orgId, "member");
      await linkOf(person.id, subject);
      google.claims = { sub: subject, email: person.email, ...claims };
      const { state, browser } = await begin("intent=signin");
      return finish(state, browser as string);
    };

    test("a wrong state", async () => {
      const { browser } = await begin("intent=signin");
      const response = await finish("not-the-state", browser as string);
      expect(landed(response)).toBe("/sign-in?google=expired");
      expect(google.calls).toEqual([]);
    });

    test("a state used twice", async () => {
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person.id, subject);
      google.claims = { sub: subject, email: person.email };
      const { state, browser } = await begin("intent=signin");
      expect(landed(await finish(state, browser as string))).toBe("/");
      expect(landed(await finish(state, browser as string))).toBe("/sign-in?google=expired");
      expect(google.calls).toHaveLength(1);
    });

    test("a state from another browser: a sent callback link signs nobody in", async () => {
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person.id, subject);
      google.claims = { sub: subject, email: person.email };
      const attacker = await begin("intent=signin");
      const victim = await begin("intent=signin");
      const response = await finish(attacker.state, victim.browser as string);
      expect(landed(response)).toBe("/sign-in?google=expired");
      expect(cookieNamed(response, "art_session")).toBeUndefined();
      expect(google.calls).toEqual([]);
    });

    test("no cookie at all", async () => {
      const { state } = await begin("intent=signin");
      expect(landed(await finish(state, "other=1"))).toBe("/sign-in?google=expired");
    });

    test("an abandoned round trip doesn't stop an invite being cleaned up", async () => {
      const made = await json<{ url: string; invite: { id: string } }>(
        await t.api("/api/invites", {
          method: "POST",
          cookie: owner,
          json: { email: `abandoned-${sub()}@example.com`, role: "member" },
        }),
      );
      await begin(`intent=invite&invite=${made.url.split("/join/")[1]}`);
      await t.server.db.delete(invites).where(eq(invites.id, made.invite.id));
      expect(
        await t.server.db.select().from(googleStates).where(eq(googleStates.inviteId, made.invite.id)),
      ).toEqual([]);
    });

    test("a state past 10 minutes", async () => {
      const { state, browser } = await begin("intent=signin");
      t.clock.advance(10 * 60_000 + 1);
      expect(landed(await finish(state, browser as string))).toBe("/sign-in?google=expired");
    });

    test("Google sending the person back with no code", async () => {
      const { state, browser } = await begin("intent=signin");
      const response = await finish(state, browser as string, "error=access_denied");
      expect(landed(response)).toBe("/sign-in?google=cancelled");
    });

    test("a wrong nonce", async () => {
      const response = await signedInWith({ nonce: "not-the-nonce" });
      expect(landed(response)).toBe("/sign-in?google=failed");
      expect(cookieNamed(response, "art_session")).toBeUndefined();
    });

    test("email_verified false", async () => {
      expect(landed(await signedInWith({ email_verified: false }))).toBe("/sign-in?google=unverified");
    });

    test("email_verified missing", async () => {
      expect(landed(await signedInWith({ email_verified: undefined }))).toBe("/sign-in?google=unverified");
    });

    test("a wrong aud", async () => {
      expect(landed(await signedInWith({ aud: "someone-elses-client" }))).toBe("/sign-in?google=failed");
    });

    test("a wrong azp", async () => {
      expect(landed(await signedInWith({ azp: "someone-elses-client" }))).toBe("/sign-in?google=failed");
    });

    test("a wrong iss", async () => {
      expect(landed(await signedInWith({ iss: "https://accounts.evil.test" }))).toBe(
        "/sign-in?google=failed",
      );
    });

    test("an expired token", async () => {
      expect(landed(await signedInWith({ exp: 100 }))).toBe("/sign-in?google=failed");
    });

    test("nonsense from the token endpoint, or a failure", async () => {
      google.raw = "not a token";
      const { state, browser } = await begin("intent=signin");
      expect(landed(await finish(state, browser as string))).toBe("/sign-in?google=failed");
      google.raw = null;
      google.fail = true;
      const again = await begin("intent=signin");
      expect(landed(await finish(again.state, again.browser as string))).toBe("/sign-in?google=failed");
    });

    test("the code goes back with its verifier and redirect, and the secret stays server-side", async () => {
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person.id, subject);
      google.claims = { sub: subject, email: person.email };
      const { state, browser, row, url } = await begin("intent=signin");
      await finish(state, browser as string);
      expect(google.calls[0]).toEqual({
        code: "abc",
        verifier: row?.codeVerifier as string,
        redirectUri: "http://viewer.test/api/auth/google/callback",
        clientId: CLIENT,
        clientSecret: "shh",
      });
      expect(url?.toString()).not.toContain("shh");
    });
  });

  describe("linking", () => {
    test("after a recent sign-in, by that person, and only then", async () => {
      const person = await makeAccount(t, orgId, "member");
      const details = account("any-google-address@example.com");
      const response = await roundTrip("intent=link", details, person.cookie);
      expect(landed(response)).toBe("/settings/sign-in?google=linked");
      const [row] = await t.server.db.select().from(identities).where(eq(identities.personId, person.id));
      expect(row?.subject).toBe(details.sub as string);
      const kinds = await t.server.db.select({ kind: activity.kind }).from(activity);
      expect(kinds.map((entry) => entry.kind)).toContain("identity_linked");
    });

    test("not without a recent sign-in", async () => {
      const person = await makeAccount(t, orgId, "member");
      await t.server.db
        .update(sessions)
        .set({ authAt: new Date(t.clock.now().getTime() - 3600_000) })
        .where(eq(sessions.personId, person.id));
      const { response } = await begin("intent=link&next=/settings/sign-in", person.cookie, SITE);
      expect(landed(response)).toBe("/settings/sign-in?google=recent");
    });

    test("a recent sign-in that ran out on the way back stops there", async () => {
      const person = await makeAccount(t, orgId, "member");
      google.claims = account("late@example.com");
      const { state, browser } = await begin("intent=link", person.cookie, SITE);
      t.clock.advance(11 * 60_000);
      await t.server.db.delete(googleStates);
      expect(landed(await finish(state, `${browser}; ${person.cookie}`))).toBe("/sign-in?google=expired");
    });

    test("it stays with the session that started it", async () => {
      const person = await makeAccount(t, orgId, "member");
      const other = await makeAccount(t, orgId, "member");
      google.claims = account("hijack@example.com");
      const { state, browser } = await begin("intent=link", person.cookie, SITE);
      const response = await finish(state, `${browser}; ${other.cookie}`);
      expect(landed(response)).toBe("/settings/sign-in?google=recent");
      expect(await t.server.db.select().from(identities).where(eq(identities.personId, other.id))).toEqual(
        [],
      );
    });

    test("two people racing for one Google account get an answer, not a 500", async () => {
      const first = await makeAccount(t, orgId, "member");
      const second = await makeAccount(t, orgId, "member");
      const details = account("raced@example.com");
      google.claims = details;
      const a = await begin("intent=link", first.cookie, SITE);
      const b = await begin("intent=link", second.cookie, SITE);
      const answers = await Promise.all([
        finish(a.state, `${a.browser}; ${first.cookie}`),
        finish(b.state, `${b.browser}; ${second.cookie}`),
      ]);
      expect(answers.map((response) => response.status)).toEqual([302, 302]);
      expect(answers.map(landed).sort()).toEqual([
        "/settings/sign-in?google=in-use",
        "/settings/sign-in?google=linked",
      ]);
    });

    test("a link can't land after the session it started from has gone", async () => {
      const person = await makeAccount(t, orgId, "member");
      google.claims = account("after-reset@example.com");
      const { state, browser } = await begin("intent=link", person.cookie, SITE);
      await t.server.db.delete(sessions).where(eq(sessions.personId, person.id));
      expect(landed(await finish(state, `${browser}; ${person.cookie}`))).toBe("/sign-in?google=expired");
      expect(await t.server.db.select().from(identities).where(eq(identities.personId, person.id))).toEqual(
        [],
      );
    });

    test("not without a session: it goes to sign in", async () => {
      const { response } = await begin("intent=link&next=/settings/sign-in", undefined, SITE);
      expect(landed(response)).toBe("/sign-in?next=%2Fsettings%2Fsign-in");
    });

    test("a Google account can't belong to two people, and a person has one", async () => {
      const first = await makeAccount(t, orgId, "member");
      const second = await makeAccount(t, orgId, "member");
      const details = account("shared@example.com");
      await roundTrip("intent=link", details, first.cookie);
      expect(landed(await roundTrip("intent=link", details, second.cookie))).toBe(
        "/settings/sign-in?google=in-use",
      );
      expect(landed(await roundTrip("intent=link", account("again@example.com"), first.cookie))).toBe(
        "/settings/sign-in?google=in-use",
      );
    });
  });

  describe("re-authentication", () => {
    const stale = async (cookie: string, personId: string) => {
      await t.server.db
        .update(sessions)
        .set({ authAt: new Date(t.clock.now().getTime() - 3600_000) })
        .where(eq(sessions.personId, personId));
      expect(await t.api("/api/me", { cookie }).then(json)).toMatchObject({ recentAuth: false });
    };

    test("a round trip with the same sub counts as a recent sign-in, and goes back where it started", async () => {
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person.id, subject);
      await stale(person.cookie, person.id);
      google.claims = { sub: subject, email: person.email };
      const { state, browser, url } = await begin("intent=reauth&next=/device?x=1", person.cookie, SITE);
      expect(url?.searchParams.get("login_hint")).toBe(subject);
      expect(url?.searchParams.get("prompt")).toBe("select_account");
      const response = await finish(state, `${browser}; ${person.cookie}`);
      expect(landed(response)).toBe("/device?x=1&google=confirmed");
      expect(await t.api("/api/me", { cookie: person.cookie }).then(json)).toMatchObject({
        recentAuth: true,
      });
    });

    test("a different sub doesn't", async () => {
      const person = await makeAccount(t, orgId, "member");
      await linkOf(person.id, sub());
      await stale(person.cookie, person.id);
      const response = await roundTrip("intent=reauth&next=/x", account(person.email), person.cookie);
      expect(landed(response)).toBe("/x?google=mismatch");
      expect(await t.api("/api/me", { cookie: person.cookie }).then(json)).toMatchObject({
        recentAuth: false,
      });
    });

    test("another session of the same person doesn't", async () => {
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person.id, subject);
      await stale(person.cookie, person.id);
      google.claims = { sub: subject, email: person.email };
      const { state, browser } = await begin("intent=reauth&next=/x", person.cookie, SITE);
      const elsewhere = `art_session=${Bun.randomUUIDv7()}`;
      await t.server.db.insert(sessions).values({
        id: Bun.randomUUIDv7(),
        orgId,
        tokenHash: sha256(elsewhere.split("=")[1] as string),
        personId: person.id,
        domain: "viewer.test",
        authAt: t.clock.now(),
        lastSeenAt: t.clock.now(),
        expiresAt: new Date(t.clock.now().getTime() + 3600_000),
      });
      const response = await finish(state, `${browser}; ${elsewhere}`);
      expect(landed(response)).toBe("/x?google=expired");
      expect(await t.api("/api/me", { cookie: person.cookie }).then(json)).toMatchObject({
        recentAuth: false,
      });
    });

    test("someone with nothing linked is sent back", async () => {
      const person = await makeAccount(t, orgId, "member");
      const { response } = await begin("intent=reauth&next=/x", person.cookie, SITE);
      expect(landed(response)).toBe("/x?google=not-linked");
    });

    test("the check says whether a sign-in is needed, so a redirect isn't wasted", async () => {
      const person = await makeAccount(t, orgId, "member");
      const check = () =>
        t.api("/api/auth/reauth/check", { method: "POST", cookie: person.cookie, json: {} });
      expect((await check()).status).toBe(200);
      await stale(person.cookie, person.id);
      expect((await check()).status).toBe(401);
    });
  });

  describe("what ends an identity", () => {
    test("a password reset deletes it: it's the way back from a takeover", async () => {
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person.id, subject);
      const secret = "reset-secret";
      await t.server.db.insert(resetLinks).values({
        id: Bun.randomUUIDv7(),
        orgId,
        personId: person.id,
        tokenHash: sha256(secret),
        createdAt: t.clock.now(),
        expiresAt: new Date(t.clock.now().getTime() + 3600_000),
      });
      const response = await t.api(`/api/reset/${secret}`, {
        method: "POST",
        json: { password: "a perfectly long password" },
      });
      expect(response.status).toBe(200);
      expect(await t.server.db.select().from(identities).where(eq(identities.personId, person.id))).toEqual(
        [],
      );
      const back = await roundTrip("intent=signin", { sub: subject, email: person.email });
      expect(landed(back)).toContain("link-first");
    });

    test("removing someone deletes it, and that Google account can't sign in again", async () => {
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person.id, subject);
      await t.api(`/api/people/${person.id}`, { method: "DELETE", cookie: owner });
      expect(await t.server.db.select().from(identities).where(eq(identities.personId, person.id))).toEqual(
        [],
      );
      expect(landed(await roundTrip("intent=signin", { sub: subject, email: person.email }))).toBe(
        "/sign-in?google=no-account",
      );
    });

    test("a person can remove theirs, unless it's the last way in", async () => {
      const person = await makeAccount(t, orgId, "member");
      await linkOf(person.id, sub());
      const list = await json<{ identities: { id: string }[]; password: boolean; google: boolean }>(
        await t.api("/api/me/identities", { cookie: person.cookie }),
      );
      expect(list).toMatchObject({ password: false, google: true, passkeys: 0 });
      const id = list.identities[0]?.id as string;
      const remove = () => t.api(`/api/me/identities/${id}`, { method: "DELETE", cookie: person.cookie });
      expect((await remove()).status).toBe(409);
      await t.server.db.insert(passwords).values({ personId: person.id, orgId, hash: "x" });
      expect((await remove()).status).toBe(200);
      expect((await remove()).status).toBe(404);
    });

    test("nobody else can remove it", async () => {
      const person = await makeAccount(t, orgId, "member");
      const other = await makeAccount(t, orgId, "member");
      await linkOf(person.id, sub());
      const [row] = await t.server.db.select().from(identities).where(eq(identities.personId, person.id));
      const response = await t.api(`/api/me/identities/${row?.id}`, {
        method: "DELETE",
        cookie: other.cookie,
      });
      expect(response.status).toBe(404);
    });
  });

  describe("workspace auto-join", () => {
    const setJoin = async (autoJoin: unknown) => {
      const current = (await findOrg(t.server.db))?.settings;
      await t.server.db
        .update(org)
        .set({ settings: { ...current, googleAutoJoin: autoJoin } })
        .where(eq(org.id, orgId));
    };
    const WORKSPACE = { domain: "acme.test", role: "reviewer", teamIds: [] };

    test("off by default, whatever the claim says", async () => {
      await setJoin(null);
      const response = await roundTrip("intent=signin", account("new@acme.test", { hd: "acme.test" }));
      expect(landed(response)).toBe("/sign-in?google=no-account");
    });

    test("on: the hd claim gets the chosen role and teams", async () => {
      const team = await json<{ team: { id: string } }>(
        await t.api("/api/teams", { method: "POST", cookie: owner, json: { name: `Auto ${sub()}` } }),
      );
      await setJoin({ ...WORKSPACE, teamIds: [team.team.id] });
      const response = await roundTrip(
        "intent=signin&next=/x",
        account("joiner@acme.test", { hd: "ACME.test" }),
      );
      expect(landed(response)).toBe("/x");
      const { person } = await json<{ person: { id: string; role: string } }>(
        await t.api("/api/me", { cookie: cookieNamed(response, "art_session") as string }),
      );
      expect(person.role).toBe("reviewer");
      const rows = await t.server.db.select().from(teamMembers).where(eq(teamMembers.personId, person.id));
      expect(rows.map((row) => row.teamId)).toEqual([team.team.id]);
      await setJoin(null);
    });

    test("an address on the domain with no claim isn't enough", async () => {
      await setJoin(WORKSPACE);
      expect(landed(await roundTrip("intent=signin", account("claimless@acme.test")))).toBe(
        "/sign-in?google=no-account",
      );
      await setJoin(null);
    });

    test("another domain's claim isn't enough", async () => {
      await setJoin(WORKSPACE);
      expect(landed(await roundTrip("intent=signin", account("other@acme.test", { hd: "evil.test" })))).toBe(
        "/sign-in?google=no-account",
      );
      await setJoin(null);
    });

    test("an email that matches someone still doesn't link", async () => {
      const person = await makeAccount(t, orgId, "member");
      await setJoin({ ...WORKSPACE, domain: "example.com" });
      const response = await roundTrip("intent=signin", account(person.email, { hd: "example.com" }));
      expect(landed(response)).toContain("link-first");
      await setJoin(null);
    });

    test("someone removed can't come back through the open door", async () => {
      const person = await makeAccount(t, orgId, "member");
      await t.api(`/api/people/${person.id}`, { method: "DELETE", cookie: owner });
      await setJoin({ ...WORKSPACE, domain: "example.com" });
      const response = await roundTrip("intent=signin", account(person.email, { hd: "example.com" }));
      expect(landed(response)).toBe("/sign-in?google=no-account");
      await setJoin(null);
    });

    test("someone removed can't return with the other Google address they linked", async () => {
      const person = await makeAccount(t, orgId, "member");
      const details = account("personal-alias@example.com", { hd: "example.com" });
      await roundTrip("intent=link", details, person.cookie);
      await t.api(`/api/people/${person.id}`, { method: "DELETE", cookie: owner });
      await setJoin({ ...WORKSPACE, domain: "example.com" });
      expect(landed(await roundTrip("intent=signin", details))).toBe("/sign-in?google=no-account");
      await setJoin(null);
    });

    test("gmail.com can never be set, and a stored one does nothing", async () => {
      for (const domain of ["gmail.com", "GMail.com", "googlemail.com"]) {
        const response = await t.api("/api/org/google", {
          method: "PATCH",
          cookie: owner,
          json: { autoJoin: { domain, role: "member" } },
        });
        expect(response.status).toBe(400);
      }
      await setJoin({ ...WORKSPACE, domain: "gmail.com" });
      expect(landed(await roundTrip("intent=signin", account("person@gmail.com", { hd: "gmail.com" })))).toBe(
        "/sign-in?google=no-account",
      );
      await setJoin(null);
    });

    test("an admin can't be made this way", async () => {
      const response = await t.api("/api/org/google", {
        method: "PATCH",
        cookie: owner,
        json: { autoJoin: { domain: "acme.test", role: "admin" } },
      });
      expect(response.status).toBe(400);
    });

    test("PATCH /api/org can't set it, and saving another setting keeps it", async () => {
      await setJoin(WORKSPACE);
      await t.api("/api/org", {
        method: "PATCH",
        cookie: owner,
        json: { settings: { linkSharing: true, googleAutoJoin: null } },
      });
      expect((await findOrg(t.server.db))?.settings.googleAutoJoin).toEqual(WORKSPACE as never);
      await setJoin(null);
    });
  });

  describe("settings", () => {
    const settings = () => t.api("/api/org/google", { cookie: owner }).then(json);

    test("the secret never comes back, from any route", async () => {
      const seen = JSON.stringify([
        await settings(),
        await t.api("/api/org", { cookie: owner }).then(json),
        await t.api("/api/meta").then(json),
        await t.api("/api/me", { cookie: owner }).then(json),
      ]);
      expect(seen).not.toContain("shh");
      expect(await settings()).toMatchObject({
        clientId: CLIENT,
        hasSecret: true,
        redirectUris: expect.arrayContaining([
          "http://viewer.test/api/auth/google/callback",
          "https://art.example.org/api/auth/google/callback",
        ]),
      });
    });

    test("only an admin in a browser, with a recent sign-in for changes", async () => {
      const member = await makeAccount(t, orgId, "member");
      const save = (auth: object) =>
        t.api("/api/org/google", { method: "PUT", json: { clientId: "x", clientSecret: "y" }, ...auth });
      expect((await save({ cookie: member.cookie })).status).toBe(403);
      expect((await save({ bearer: ownerToken })).status).toBe(403);
      expect((await t.api("/api/org/google", { bearer: ownerToken })).status).toBe(403);
      const admin = await makeAccount(t, orgId, "admin");
      await t.server.db
        .update(sessions)
        .set({ authAt: new Date(t.clock.now().getTime() - 3600_000) })
        .where(eq(sessions.personId, admin.id));
      const stale = await save({ cookie: admin.cookie });
      expect((await json<{ error: { code: string } }>(stale)).error.code).toBe("recent_auth_required");
    });

    test("new credentials turn it off, and it only comes on after that admin's own round trip", async () => {
      const admin = await makeAccount(t, orgId, "admin");
      await t.server.db.insert(passwords).values({ personId: admin.id, orgId, hash: "x" });
      const put = (json_: object, cookie = admin.cookie) =>
        t.api("/api/org/google", { method: "PUT", cookie, json: json_ });
      const enable = (cookie = admin.cookie) =>
        t.api("/api/org/google", { method: "PATCH", cookie, json: { enabled: true } });
      await put({ clientId: CLIENT, clientSecret: "shh" });
      expect(await t.api("/api/meta").then(json)).toMatchObject({ google: false });
      expect((await enable()).status).toBe(409);

      // Another admin's test doesn't count for this one.
      google.claims = account("tester@example.com");
      const first = await begin("intent=test&next=/settings/google", owner, SITE);
      expect(landed(await finish(first.state, `${first.browser}; ${owner}`))).toBe(
        "/settings/google?google=tested",
      );
      expect((await enable()).status).toBe(409);
      expect((await enable(owner)).status).toBe(200);
      expect(await t.api("/api/meta").then(json)).toMatchObject({ google: true });

      // A test links nobody and signs nobody in.
      expect(
        await t.server.db
          .select()
          .from(identities)
          .where(eq(identities.subject, google.claims.sub as string)),
      ).toEqual([]);

      await put({ clientId: "another-client" });
      expect(await t.api("/api/org/google", { cookie: admin.cookie }).then(json)).toMatchObject({
        enabled: false,
        tested: false,
        hasSecret: true,
      });
    });

    test("a test needs an admin, and can't be started from another site", async () => {
      const member = await makeAccount(t, orgId, "member");
      const asMember = await begin("intent=test", member.cookie, SITE);
      expect(asMember.response.status).toBe(403);
      const sent = await begin("intent=test", owner, { "Sec-Fetch-Site": "cross-site" });
      expect(sent.response.status).toBe(403);
    });

    test("an admin with only Google can't turn off the way they get back in", async () => {
      const admin = await makeAccount(t, orgId, "admin");
      await linkOf(admin.id, sub());
      const calls = [
        () => t.api("/api/org/google", { method: "PUT", cookie: admin.cookie, json: { clientId: "new" } }),
        () => t.api("/api/org/google", { method: "PATCH", cookie: admin.cookie, json: { enabled: false } }),
        () => t.api("/api/org/google", { method: "DELETE", cookie: admin.cookie }),
      ];
      for (const call of calls) expect((await call()).status).toBe(409);
      await t.server.db.insert(passwords).values({ personId: admin.id, orgId, hash: "x" });
      expect((await calls[1]?.())?.status).toBe(200);
    });

    test("a test can't vouch for credentials saved while it ran", async () => {
      google.claims = account("racing@example.com");
      const { state, browser } = await begin("intent=test&next=/settings/google", owner, SITE);
      google.during = async () => {
        await t.server.db
          .update(org)
          .set({ googleClientId: "changed-meanwhile", googleTestedBy: null })
          .where(eq(org.id, orgId));
      };
      expect(landed(await finish(state, `${browser}; ${owner}`))).toBe("/settings/google?google=failed");
      expect((await findOrg(t.server.db))?.googleTestedBy).toBeNull();
    });

    test("a client can be removed", async () => {
      expect((await t.api("/api/org/google", { method: "DELETE", cookie: owner })).status).toBe(200);
      expect(await t.api("/api/org/google", { cookie: owner }).then(json)).toMatchObject({
        clientId: null,
        hasSecret: false,
        enabled: false,
      });
    });
  });

  test("the people list says who has Google, and passkey removal knows it counts", async () => {
    const person = await makeAccount(t, orgId, "member");
    await linkOf(person.id, sub());
    const list = await json<{ people: { id: string; google: boolean }[] }>(
      await t.api("/api/people", { cookie: owner }),
    );
    expect(list.people.find((row) => row.id === person.id)?.google).toBe(true);
    const [row] = await t.server.db.select().from(people).where(eq(people.id, person.id));
    expect(row?.role).toBe("member");
  });

  test("setup stores a client, off, and says nothing about it", async () => {
    const fresh = await startTestServer({}, { google });
    try {
      const response = await fresh.api("/api/setup", {
        method: "POST",
        json: {
          setupToken: "s".repeat(48),
          orgName: "Mochahub",
          clientName: "Test",
          ...OWNER,
          google: { clientId: CLIENT, clientSecret: "shh" },
        },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("shh");
      expect(await findOrg(fresh.server.db)).toMatchObject({
        googleClientId: CLIENT,
        googleClientSecret: "shh",
        googleEnabled: false,
      });
      expect(await fresh.api("/api/meta").then(json)).toMatchObject({ google: false });
    } finally {
      await fresh.stop();
    }
  });
});
