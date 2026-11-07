import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ActivityPage,
  GoogleSettings,
  IdentityList,
  type OrgSettings,
  PasskeyList,
  PeopleList,
  ResetLinkCreated,
  TeamCreated,
  TeamDetail,
} from "@artifacts/schema";
import { eq } from "drizzle-orm";
import type { GoogleExchange } from "../../src/auth/google.ts";
import { sha256 } from "../../src/auth/secrets.ts";
import { RECENT_AUTH_MS } from "../../src/auth/sessions.ts";
import { findOrg } from "../../src/db/index.ts";
import { googleStates, invites, org } from "../../src/db/schema.ts";
import { softAuthenticator } from "../authenticator.ts";
import {
  addPasskey,
  claim,
  cookieOf,
  inviteSecret,
  invite as inviteTo,
  json,
  OWNER,
  PASSWORD,
  SETUP_TOKEN,
  signIn,
  startTestServer,
  type TestServer,
} from "../helpers.ts";
import { makeAccount } from "../publish-helper.ts";

const CLIENT = "client.apps.googleusercontent.com";
const SITE = { "Sec-Fetch-Site": "same-origin" };
/** PKCE's S256, which Google checks the verifier against. */
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

type Claims = Record<string, unknown>;

/** Google, as far as the server can tell. Each test says who signs in, and how the token is wrong. */
class FakeGoogle {
  authorizeUrl = "https://accounts.example.test/auth";
  claims: Claims = {};
  raw: string | null = null;
  fail = false;
  during: (() => Promise<void>) | null = null;
  calls: GoogleExchange[] = [];
  /** By code challenge, as Google keeps them: two round trips can be under way at once. */
  nonces = new Map<string, string>();

  /** What Google sees when the browser arrives: the authorize URL's challenge and nonce. */
  authorize(url: URL) {
    this.nonces.set(url.searchParams.get("code_challenge") ?? "", url.searchParams.get("nonce") ?? "");
  }

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
    // Google refuses a code whose verifier doesn't match the challenge it was asked with.
    const nonce = this.nonces.get(s256(input.verifier));
    if (nonce === undefined) throw new Error("invalid_grant");
    if (this.raw !== null) return this.raw;
    const body = {
      iss: "https://accounts.google.com",
      aud: CLIENT,
      exp: Math.floor(this.now() / 1000) + 3600,
      nonce,
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

  // Turning it on through the API takes an admin's test round trip; "settings" below does that.
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
    if (url) google.authorize(url);
    const browser = cookieOf(response, "art_google");
    return { response, url, state: url?.searchParams.get("state") ?? "", browser };
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
  /** Links a Google account the way a person does: a link round trip from their recent session. */
  const linkOf = async (person: { cookie: string }, subject: string) => {
    const response = await roundTrip(
      "intent=link",
      { sub: subject, email: "linked@example.com" },
      person.cookie,
    );
    expect(landed(response)).toBe("/settings/sign-in?google=linked");
    google.calls = [];
  };
  const identitiesOf = async (cookie: string) =>
    IdentityList.parse(await (await t.api("/api/me/identities", { cookie })).json());
  const peopleList = async () =>
    PeopleList.parse(await (await t.api("/api/people", { cookie: owner })).json()).people;
  const hasGoogle = async (personId: string) =>
    (await peopleList()).find((row) => row.id === personId)?.google;
  const setPassword = async (cookie: string) =>
    expect(
      (await t.api("/api/me/password", { method: "POST", cookie, json: { password: PASSWORD } })).status,
    ).toBe(200);
  /** Ages every sign-in past the recent window; the owner's is refreshed before the next test. */
  const ageSignIns = () => t.clock.advance(RECENT_AUTH_MS + 1000);
  const membersOf = async (slug: string) =>
    TeamDetail.parse(await (await t.api(`/api/teams/${slug}`, { cookie: owner })).json()).members.map(
      (member) => member.id,
    );
  const newTeam = async (name: string) =>
    TeamCreated.parse(
      await (await t.api("/api/teams", { method: "POST", cookie: owner, json: { name } })).json(),
    ).team;

  beforeAll(async () => {
    t = await startTestServer({}, { google });
    // Tokens expire by the server's clock, which tests move.
    google.now = () => t.clock.now().getTime();
    const claimed = await claim(t);
    ownerToken = claimed.token;
    orgId = claimed.orgId;
    owner = await signIn(t, OWNER.email, OWNER.password);
  });
  afterAll(() => t.stop());
  beforeEach(async () => {
    google.reset();
    await turnOn();
    // Tests move the clock; the owner confirms again rather than act with a stale sign-in.
    const me = await json<{ recentAuth: boolean }>(await t.api("/api/me", { cookie: owner }));
    if (!me.recentAuth) {
      const reauth = await t.api("/api/auth/reauth", {
        method: "POST",
        cookie: owner,
        json: { password: OWNER.password },
      });
      expect(reauth.status).toBe(200);
    }
  });

  describe("turned off", () => {
    test("nothing answers, and the sign-in page has nothing to show", async () => {
      expect((await t.api("/api/org/google", { method: "DELETE", cookie: owner })).status).toBe(200);
      expect((await t.api("/api/auth/google/start", { redirect: "manual" })).status).toBe(404);
      expect(await t.api("/api/meta").then(json)).toMatchObject({ google: false });
      expect(landed(await finish("anything", "art_google=x"))).toBe("/sign-in?google=expired");
    });

    test("a round trip started while it was on stops at the callback", async () => {
      const { state, browser } = await begin("intent=signin");
      const off = await t.api("/api/org/google", {
        method: "PATCH",
        cookie: owner,
        json: { enabled: false },
      });
      expect(off.status).toBe(200);
      expect(landed(await finish(state, browser))).toBe("/sign-in?google=off");
    });
  });

  describe("starting", () => {
    test("asks for a code with PKCE, state and nonce, and sends the browser a host-only cookie", async () => {
      const { url, state, browser, response } = await begin("intent=signin&next=/camerabuddy");
      expect(url?.origin + (url?.pathname ?? "")).toBe(google.authorizeUrl);
      const params = url?.searchParams as URLSearchParams;
      expect(params.get("client_id")).toBe(CLIENT);
      expect(params.get("response_type")).toBe("code");
      expect(params.get("scope")).toBe("openid email profile");
      expect(params.get("code_challenge_method")).toBe("S256");
      expect(params.get("code_challenge")).toMatch(/^[\w-]{43}$/);
      expect(params.get("nonce")).toBeTruthy();
      expect(params.has("hd")).toBe(false);
      expect(params.get("redirect_uri")).toBe("http://viewer.test/api/auth/google/callback");
      // Only hashes of the state and the browser's cookie are stored.
      const rows = await t.server.db
        .select()
        .from(googleStates)
        .where(eq(googleStates.stateHash, sha256(state)));
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(state);
      expect(JSON.stringify(rows)).not.toContain(browser.split("=")[1] as string);
      const set = response.headers.getSetCookie().find((cookie) => cookie.startsWith("art_google="));
      expect(set).toContain("HttpOnly");
      expect(set).toContain("SameSite=Lax");
      expect(set).toContain("Path=/api/auth/google");
      expect(set).not.toContain("Domain=");
      expect(browser).toStartWith("art_google=");
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
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person, subject);
      google.claims = { sub: subject, email: person.email };
      for (const next of [
        "https://evil.test",
        "//evil.test",
        "/\\evil.test",
        "/%09/evil.test".replace("%09", "\t"),
      ]) {
        const { state, browser } = await begin(`intent=signin&next=${encodeURIComponent(next)}`);
        expect(landed(await finish(state, browser))).toBe("/");
      }
    });

    test("an unknown intent is refused, and starting is rate limited", async () => {
      expect((await t.api("/api/auth/google/start?intent=nonsense")).status).toBe(400);
      const start = () => t.api("/api/auth/google/start", { redirect: "manual" });
      const statuses: number[] = [];
      for (let i = 0; i < 61 && statuses.at(-1) !== 429; i++) statuses.push((await start()).status);
      expect(statuses.at(-1)).toBe(429);
      expect(statuses.slice(0, -1).every((status) => status === 302)).toBe(true);
      t.clock.advance(15 * 60_000 + 1000);
      expect((await start()).status).toBe(302);
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
      await linkOf(person, subject);
      const response = await roundTrip("intent=signin&next=/camerabuddy", {
        sub: subject,
        email: "new-address@elsewhere.test",
      });
      expect(landed(response)).toBe("/camerabuddy");
      const cookie = cookieOf(response, "art_session");
      expect(await t.api("/api/me", { cookie }).then(json)).toMatchObject({
        person: { id: person.id },
        recentAuth: true,
      });
      const [identity] = (await identitiesOf(cookie)).identities;
      expect(identity).toMatchObject({ email: "new-address@elsewhere.test" });
      expect(identity?.lastUsedAt).not.toBeNull();
    });

    test("an email that matches someone never links: they're told to sign in the usual way", async () => {
      const person = await makeAccount(t, orgId, "member");
      const response = await roundTrip("intent=signin", account(person.email));
      expect(landed(response)).toBe("/sign-in?google=link-first&next=%2Fsettings%2Fsign-in");
      expect(cookieOf(response, "art_session")).toBe("");
      expect((await identitiesOf(person.cookie)).identities).toEqual([]);
    });

    test("the same goes for an account with a different capital letter", async () => {
      const person = await makeAccount(t, orgId, "member");
      const response = await roundTrip("intent=signin", account(person.email.toUpperCase()));
      expect(landed(response)).toContain("link-first");
    });

    test("nobody here: refused", async () => {
      const response = await roundTrip("intent=signin", account("stranger@elsewhere.test"));
      expect(landed(response)).toBe("/sign-in?google=no-account");
      expect(cookieOf(response, "art_session")).toBe("");
    });

    const invite = async (email: string) => inviteSecret(await inviteTo(t, { cookie: owner }, email));

    test("on an invite, with the same email: the account is made and linked", async () => {
      const secret = await invite("Invited@Example.com");
      const details = account("invited@example.com", { name: "Invited Person" });
      const response = await roundTrip(`intent=invite&invite=${secret}`, details);
      expect(landed(response)).toBe("/");
      const cookie = cookieOf(response, "art_session");
      const me = await json<{ person: { id: string; name: string; role: string } }>(
        await t.api("/api/me", { cookie }),
      );
      expect(me.person).toMatchObject({ name: "Invited Person", role: "member" });
      expect(await identitiesOf(cookie)).toMatchObject({
        identities: [{ provider: "google", email: "invited@example.com" }],
        password: false,
      });
      expect((await t.api(`/api/invites/${secret}`)).status).toBe(410);
      // Linked to this Google account: the next sign-in with it comes back to this person.
      const again = await roundTrip("intent=signin", { sub: details.sub, email: "invited@example.com" });
      expect(await t.api("/api/me", { cookie: cookieOf(again, "art_session") }).then(json)).toMatchObject({
        person: { id: me.person.id },
      });
    });

    test("on an invite, with a different email: refused, and the invite still works", async () => {
      const secret = await invite("expected@example.com");
      const response = await roundTrip(`intent=invite&invite=${secret}`, account("someone-else@example.com"));
      expect(landed(response)).toBe("/sign-in?google=invite-mismatch");
      expect(cookieOf(response, "art_session")).toBe("");
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
      await linkOf(person, subject);
      const secret = await invite("second@example.com");
      const response = await roundTrip(`intent=invite&invite=${secret}`, {
        sub: subject,
        email: "second@example.com",
      });
      expect(landed(response)).toBe("/sign-in?google=in-use");
    });

    test("an invite's grants come with Google too", async () => {
      const team = await newTeam(`With invite ${sub()}`);
      const made = await json<{ url: string }>(
        await t.api("/api/invites", {
          method: "POST",
          cookie: owner,
          json: { email: "team@example.com", role: "reviewer", teamIds: [team.id] },
        }),
      );
      const response = await roundTrip(
        `intent=invite&invite=${inviteSecret(made.url)}`,
        account("team@example.com"),
      );
      const { person } = await json<{ person: { id: string } }>(
        await t.api("/api/me", { cookie: cookieOf(response, "art_session") }),
      );
      expect(await membersOf(team.slug)).toEqual([person.id]);
    });
  });

  describe("the negative cases", () => {
    const signedInWith = async (claims: Claims) => {
      const subject = sub();
      const person = await makeAccount(t, orgId, "member");
      await linkOf(person, subject);
      google.claims = { sub: subject, email: person.email, ...claims };
      const { state, browser } = await begin("intent=signin");
      return finish(state, browser);
    };

    test("a wrong state", async () => {
      const { browser } = await begin("intent=signin");
      const response = await finish("not-the-state", browser);
      expect(landed(response)).toBe("/sign-in?google=expired");
      expect(google.calls).toEqual([]);
    });

    test("a state used twice", async () => {
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person, subject);
      google.claims = { sub: subject, email: person.email };
      const { state, browser } = await begin("intent=signin");
      expect(landed(await finish(state, browser))).toBe("/");
      expect(landed(await finish(state, browser))).toBe("/sign-in?google=expired");
      expect(google.calls).toHaveLength(1);
    });

    test("a state from another browser: a sent callback link signs nobody in", async () => {
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person, subject);
      google.claims = { sub: subject, email: person.email };
      const attacker = await begin("intent=signin");
      const victim = await begin("intent=signin");
      const response = await finish(attacker.state, victim.browser);
      expect(landed(response)).toBe("/sign-in?google=expired");
      expect(cookieOf(response, "art_session")).toBe("");
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
      await begin(`intent=invite&invite=${inviteSecret(made.url)}`);
      // Invites are only ever deleted by a cleanup job; this checks the state row goes with them.
      await t.server.db.delete(invites).where(eq(invites.id, made.invite.id));
      expect(
        await t.server.db.select().from(googleStates).where(eq(googleStates.inviteId, made.invite.id)),
      ).toEqual([]);
    });

    test("a state past 10 minutes", async () => {
      const { state, browser } = await begin("intent=signin");
      t.clock.advance(10 * 60_000 + 1);
      expect(landed(await finish(state, browser))).toBe("/sign-in?google=expired");
    });

    test("Google sending the person back with no code", async () => {
      const { state, browser } = await begin("intent=signin");
      const response = await finish(state, browser, "error=access_denied");
      expect(landed(response)).toBe("/sign-in?google=cancelled");
    });

    test("a wrong nonce", async () => {
      const response = await signedInWith({ nonce: "not-the-nonce" });
      expect(landed(response)).toBe("/sign-in?google=failed");
      expect(cookieOf(response, "art_session")).toBe("");
    });

    test("email_verified false", async () => {
      expect(landed(await signedInWith({ email_verified: false }))).toBe("/sign-in?google=unverified");
    });

    test("email_verified missing", async () => {
      expect(landed(await signedInWith({ email_verified: undefined }))).toBe("/sign-in?google=unverified");
    });

    test("email_verified as the string Google's token info uses", async () => {
      expect(landed(await signedInWith({ email_verified: "false" }))).toBe("/sign-in?google=unverified");
      expect(
        landed(
          await signedInWith({
            email_verified: "true",
            email: "new-person@example.com",
            sub: "string-verified",
          }),
        ),
      ).toBe("/sign-in?google=no-account");
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
      expect(landed(await finish(state, browser))).toBe("/sign-in?google=failed");
      google.raw = null;
      google.fail = true;
      const again = await begin("intent=signin");
      expect(landed(await finish(again.state, again.browser))).toBe("/sign-in?google=failed");
    });

    test("the code goes back with its verifier and redirect, and the secret stays server-side", async () => {
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person, subject);
      google.claims = { sub: subject, email: person.email };
      const { state, browser, url } = await begin("intent=signin");
      // The fake refuses a verifier that doesn't match the challenge in the URL, as Google does.
      expect(landed(await finish(state, browser))).toBe("/");
      expect(google.calls[0]).toEqual({
        code: "abc",
        verifier: expect.any(String),
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
      expect((await identitiesOf(person.cookie)).identities).toMatchObject([{ email: details.email }]);
      const signedIn = await roundTrip("intent=signin", { sub: details.sub, email: details.email });
      expect(await t.api("/api/me", { cookie: cookieOf(signedIn, "art_session") }).then(json)).toMatchObject({
        person: { id: person.id },
      });
      const activity = ActivityPage.parse(await (await t.api("/api/activity", { cookie: owner })).json());
      expect(activity.items).toContainEqual(
        expect.objectContaining({ kind: "identity_linked", actor: person.name }),
      );
    });

    test("not without a recent sign-in", async () => {
      const person = await makeAccount(t, orgId, "member");
      ageSignIns();
      const { response } = await begin("intent=link&next=/settings/sign-in", person.cookie, SITE);
      expect(landed(response)).toBe("/settings/sign-in?google=recent");
    });

    test("a recent sign-in that ran out on the way back stops there", async () => {
      const person = await makeAccount(t, orgId, "member");
      google.claims = account("late@example.com");
      // Starts with half a minute of the recent window left, and comes back a minute later: the state
      // is still good, the sign-in no longer recent.
      t.clock.advance(RECENT_AUTH_MS - 30_000);
      const { state, browser } = await begin("intent=link", person.cookie, SITE);
      t.clock.advance(60_000);
      expect(landed(await finish(state, `${browser}; ${person.cookie}`))).toBe(
        "/settings/sign-in?google=recent",
      );
      expect((await identitiesOf(person.cookie)).identities).toEqual([]);
    });

    test("it stays with the session that started it", async () => {
      const person = await makeAccount(t, orgId, "member");
      const other = await makeAccount(t, orgId, "member");
      google.claims = account("hijack@example.com");
      const { state, browser } = await begin("intent=link", person.cookie, SITE);
      const response = await finish(state, `${browser}; ${other.cookie}`);
      expect(landed(response)).toBe("/settings/sign-in?google=recent");
      expect((await identitiesOf(other.cookie)).identities).toEqual([]);
      expect((await identitiesOf(person.cookie)).identities).toEqual([]);
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
      expect((await t.api("/api/auth/logout", { method: "POST", cookie: person.cookie })).status).toBe(200);
      expect(landed(await finish(state, `${browser}; ${person.cookie}`))).toBe("/sign-in?google=expired");
      expect(await hasGoogle(person.id)).toBe(false);
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
    const stale = async (cookie: string) => {
      ageSignIns();
      expect(await t.api("/api/me", { cookie }).then(json)).toMatchObject({ recentAuth: false });
    };

    test("a round trip with the same sub counts as a recent sign-in, and goes back where it started", async () => {
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person, subject);
      await stale(person.cookie);
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
      await linkOf(person, sub());
      await stale(person.cookie);
      const response = await roundTrip("intent=reauth&next=/x", account(person.email), person.cookie);
      expect(landed(response)).toBe("/x?google=mismatch");
      expect(await t.api("/api/me", { cookie: person.cookie }).then(json)).toMatchObject({
        recentAuth: false,
      });
    });

    test("another session of the same person doesn't", async () => {
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person, subject);
      await setPassword(person.cookie);
      await stale(person.cookie);
      google.claims = { sub: subject, email: person.email };
      const { state, browser } = await begin("intent=reauth&next=/x", person.cookie, SITE);
      const elsewhere = await signIn(t, person.email, PASSWORD);
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
      await stale(person.cookie);
      expect((await check()).status).toBe(401);
    });
  });

  describe("what ends an identity", () => {
    test("a password reset deletes it: it's the way back from a takeover", async () => {
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person, subject);
      const link = ResetLinkCreated.parse(
        await (await t.api(`/api/people/${person.id}/reset-link`, { method: "POST", cookie: owner })).json(),
      );
      const response = await t.api(`/api/reset/${link.url.split("/reset/")[1]}`, {
        method: "POST",
        json: { password: PASSWORD },
      });
      expect(response.status).toBe(200);
      expect((await identitiesOf(cookieOf(response))).identities).toEqual([]);
      const back = await roundTrip("intent=signin", { sub: subject, email: person.email });
      expect(landed(back)).toContain("link-first");
    });

    test("removing someone deletes it: that Google account can't sign in, but can take a new invite", async () => {
      const person = await makeAccount(t, orgId, "member");
      const subject = sub();
      await linkOf(person, subject);
      expect((await t.api(`/api/people/${person.id}`, { method: "DELETE", cookie: owner })).status).toBe(200);
      expect(landed(await roundTrip("intent=signin", { sub: subject, email: person.email }))).toBe(
        "/sign-in?google=no-account",
      );
      // A Google account still linked to anyone is "in use" for an invite.
      const secret = inviteSecret(await inviteTo(t, { cookie: owner }, person.email));
      const joined = await roundTrip(`intent=invite&invite=${secret}`, { sub: subject, email: person.email });
      expect(landed(joined)).toBe("/");
    });

    test("a person can remove theirs, unless it's the last way in", async () => {
      const person = await makeAccount(t, orgId, "member");
      await linkOf(person, sub());
      const list = await json<{ identities: { id: string }[]; password: boolean; google: boolean }>(
        await t.api("/api/me/identities", { cookie: person.cookie }),
      );
      expect(list).toMatchObject({ password: false, google: true, passkeys: 0 });
      const id = list.identities[0]?.id as string;
      const remove = () => t.api(`/api/me/identities/${id}`, { method: "DELETE", cookie: person.cookie });
      expect((await remove()).status).toBe(409);
      await setPassword(person.cookie);
      expect((await remove()).status).toBe(200);
      expect((await remove()).status).toBe(404);
    });

    test("nobody else can remove it", async () => {
      const person = await makeAccount(t, orgId, "member");
      const other = await makeAccount(t, orgId, "member");
      await linkOf(person, sub());
      const [identity] = (await identitiesOf(person.cookie)).identities;
      const response = await t.api(`/api/me/identities/${identity?.id}`, {
        method: "DELETE",
        cookie: other.cookie,
      });
      expect(response.status).toBe(404);
      expect((await identitiesOf(person.cookie)).identities).toHaveLength(1);
    });
  });

  describe("workspace auto-join", () => {
    const setJoin = async (autoJoin: unknown) => {
      const response = await t.api("/api/org/google", { method: "PATCH", cookie: owner, json: { autoJoin } });
      expect(response.status).toBe(200);
    };
    const autoJoin = async () =>
      GoogleSettings.parse(await (await t.api("/api/org/google", { cookie: owner })).json()).autoJoin;
    const WORKSPACE = { domain: "acme.test", role: "reviewer", teamIds: [] };

    test("off by default, whatever the claim says", async () => {
      await setJoin(null);
      const response = await roundTrip("intent=signin", account("new@acme.test", { hd: "acme.test" }));
      expect(landed(response)).toBe("/sign-in?google=no-account");
    });

    test("on: the hd claim gets the chosen role and teams", async () => {
      const team = await newTeam(`Auto ${sub()}`);
      await setJoin({ ...WORKSPACE, teamIds: [team.id] });
      const response = await roundTrip(
        "intent=signin&next=/x",
        account("joiner@acme.test", { hd: "ACME.test" }),
      );
      expect(landed(response)).toBe("/x");
      const { person } = await json<{ person: { id: string; role: string } }>(
        await t.api("/api/me", { cookie: cookieOf(response, "art_session") }),
      );
      expect(person.role).toBe("reviewer");
      expect(await membersOf(team.slug)).toEqual([person.id]);
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
      // Stored before the rule, say: no route can save one now.
      const current = (await findOrg(t.server.db))?.settings;
      const googleAutoJoin = { ...WORKSPACE, domain: "gmail.com" } as OrgSettings["googleAutoJoin"];
      await t.server.db
        .update(org)
        .set({ settings: { ...current, googleAutoJoin } as OrgSettings })
        .where(eq(org.id, orgId));
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
      expect(await autoJoin()).toEqual(WORKSPACE as never);
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
      ageSignIns();
      const stale = await save({ cookie: admin.cookie });
      expect((await json<{ error: { code: string } }>(stale)).error.code).toBe("recent_auth_required");
    });

    test("new credentials turn it off, and it only comes on after that admin's own round trip", async () => {
      const admin = await makeAccount(t, orgId, "admin");
      await setPassword(admin.cookie);
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
      expect((await identitiesOf(owner)).identities).toEqual([]);
      expect(landed(await roundTrip("intent=signin", google.claims))).toBe("/sign-in?google=no-account");

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
      await linkOf(admin, sub());
      const calls = [
        () => t.api("/api/org/google", { method: "PUT", cookie: admin.cookie, json: { clientId: "new" } }),
        () => t.api("/api/org/google", { method: "PATCH", cookie: admin.cookie, json: { enabled: false } }),
        () => t.api("/api/org/google", { method: "DELETE", cookie: admin.cookie }),
      ];
      for (const call of calls) expect((await call()).status).toBe(409);
      await setPassword(admin.cookie);
      expect((await calls[1]?.())?.status).toBe(200);
    });

    test("a test can't vouch for credentials saved while it ran", async () => {
      google.claims = account("racing@example.com");
      const { state, browser } = await begin("intent=test&next=/settings/google", owner, SITE);
      google.during = async () => {
        const saved = await t.api("/api/org/google", {
          method: "PUT",
          cookie: owner,
          json: { clientId: "changed-meanwhile" },
        });
        expect(saved.status).toBe(200);
      };
      expect(landed(await finish(state, `${browser}; ${owner}`))).toBe("/settings/google?google=failed");
      expect(
        GoogleSettings.parse(await (await t.api("/api/org/google", { cookie: owner })).json()),
      ).toMatchObject({
        clientId: "changed-meanwhile",
        tested: false,
      });
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
    expect(await hasGoogle(person.id)).toBe(false);
    await linkOf(person, sub());
    expect(await hasGoogle(person.id)).toBe(true);
    // No password, so without Google this passkey would be the last way in.
    expect((await addPasskey(t, person.cookie, softAuthenticator())).status).toBe(200);
    const passkeys = async () =>
      PasskeyList.parse(await (await t.api("/api/me/passkeys", { cookie: person.cookie })).json()).passkeys;
    const [passkey] = await passkeys();
    const removed = await t.api(`/api/me/passkeys/${passkey?.id}`, {
      method: "DELETE",
      cookie: person.cookie,
    });
    expect(removed.status).toBe(200);
    expect(await passkeys()).toEqual([]);
  });

  test("setup stores a client, off, and says nothing about it", async () => {
    const fresh = await startTestServer({}, { google });
    try {
      const response = await fresh.api("/api/setup", {
        method: "POST",
        json: {
          setupToken: SETUP_TOKEN,
          orgName: "Mochahub",
          clientName: "Test",
          ...OWNER,
          google: { clientId: CLIENT, clientSecret: "shh" },
        },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("shh");
      const cookie = await signIn(fresh, OWNER.email, OWNER.password);
      expect(await fresh.api("/api/org/google", { cookie }).then(json)).toMatchObject({
        clientId: CLIENT,
        hasSecret: true,
        enabled: false,
      });
      expect(await fresh.api("/api/meta").then(json)).toMatchObject({ google: false });
    } finally {
      await fresh.stop();
    }
  });
});
