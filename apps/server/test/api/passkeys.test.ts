import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PasskeyList } from "@artifacts/schema";
import { RECENT_AUTH_MS } from "../../src/auth/sessions.ts";
import { softAuthenticator } from "../authenticator.ts";
import {
  addPasskey,
  claim,
  code,
  cookieOf,
  ORIGIN,
  OWNER,
  orgToken,
  PASSWORD,
  signIn,
  startTestServer,
  type TestServer,
} from "../helpers.ts";
import { makeAccount } from "../publish-helper.ts";

type Registration = {
  rp: { id: string };
  challenge: string;
  challengeId: string;
  authenticatorSelection: Record<string, string>;
};
type Authentication = {
  rpId: string;
  challenge: string;
  challengeId: string;
  userVerification: string;
  allowCredentials?: unknown[];
};

describe("passkeys", () => {
  let t: TestServer;
  let cookie: string;
  let orgId: string;
  const key = softAuthenticator();
  const list = async (as: string) =>
    PasskeyList.parse(await (await t.api("/api/me/passkeys", { cookie: as })).json()).passkeys;

  const signInOptions = async (json: unknown = {}) =>
    (await (await t.api("/api/auth/passkey/options", { method: "POST", json })).json()) as Authentication;
  const registerOptions = async () =>
    (await (
      await t.api("/api/me/passkeys/options", { method: "POST", cookie, json: {} })
    ).json()) as Registration;
  const verifyLogin = (challengeId: string, response: unknown) =>
    t.api("/api/auth/passkey/verify", { method: "POST", json: { challengeId, response } });

  beforeAll(async () => {
    t = await startTestServer();
    orgId = (await claim(t)).orgId;
    cookie = await signIn(t, OWNER.email, OWNER.password);
  });
  afterAll(() => t.stop());

  test("registering asks for a discoverable, user-verified passkey on the home domain", async () => {
    const options = await registerOptions();
    expect(options.rp.id).toBe("viewer.test");
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });
    const verified = await t.api("/api/me/passkeys/verify", {
      method: "POST",
      cookie,
      json: {
        challengeId: options.challengeId,
        response: key.register(options, ORIGIN),
        name: "iCloud Keychain",
      },
    });
    expect(verified.status).toBe(200);
    const list = (await (await t.api("/api/me/passkeys", { cookie })).json()) as {
      passkeys: { id: string; name: string; rpId: string }[];
      passwordSetAt: string | null;
    };
    expect(list.passkeys).toHaveLength(1);
    expect(list.passkeys[0]).toMatchObject({ name: "iCloud Keychain", rpId: "viewer.test" });
    expect(list.passwordSetAt).toBeString();
  });

  test("registering without user verification is refused", async () => {
    const other = softAuthenticator();
    const options = await registerOptions();
    const refused = await t.api("/api/me/passkeys/verify", {
      method: "POST",
      cookie,
      json: { challengeId: options.challengeId, response: other.register(options, ORIGIN, false) },
    });
    expect(refused.status).toBe(400);
  });

  test("adding one needs a recent sign-in", async () => {
    const stale = await signIn(t, OWNER.email, OWNER.password);
    t.clock.advance(RECENT_AUTH_MS + 60_000);
    const response = await t.api("/api/me/passkeys/options", { method: "POST", cookie: stale, json: {} });
    expect(await code(response)).toBe("recent_auth_required");
    cookie = await signIn(t, OWNER.email, OWNER.password);
  });

  test("signs in with no email, and the options name no credentials", async () => {
    const options = await signInOptions();
    expect(options).toMatchObject({ rpId: "viewer.test", userVerification: "required" });
    expect(options.allowCredentials ?? []).toEqual([]);
    const response = await verifyLogin(options.challengeId, key.assert(options, ORIGIN));
    expect(response.status).toBe(200);
    const session = cookieOf(response);
    expect((await t.api("/api/me", { cookie: session })).status).toBe(200);
    const [used] = await list(session);
    expect(used?.lastUsedAt).not.toBeNull();
  });

  test("a second viewer domain works, with the home domain's RP ID (Related Origin Requests)", async () => {
    const options = await signInOptions();
    const response = await key.assert(options, "https://art.example.org");
    expect((await verifyLogin(options.challengeId, response)).status).toBe(200);
  });

  test("a challenge works once", async () => {
    const options = await signInOptions();
    expect((await verifyLogin(options.challengeId, key.assert(options, ORIGIN))).status).toBe(200);
    expect((await verifyLogin(options.challengeId, key.assert(options, ORIGIN))).status).toBe(401);
  });

  test("an expired challenge is refused", async () => {
    const options = await signInOptions();
    t.clock.advance(5 * 60_000 + 1000);
    expect((await verifyLogin(options.challengeId, key.assert(options, ORIGIN))).status).toBe(401);
    cookie = await signIn(t, OWNER.email, OWNER.password);
  });

  test("no user verification, a foreign origin, the content host, or an unknown key all fail", async () => {
    const uv = await signInOptions();
    expect((await verifyLogin(uv.challengeId, key.assert(uv, ORIGIN, false))).status).toBe(401);
    const evil = await signInOptions();
    expect((await verifyLogin(evil.challengeId, key.assert(evil, "https://evil.test"))).status).toBe(401);
    const content = await signInOptions();
    expect((await verifyLogin(content.challengeId, key.assert(content, "http://content.test"))).status).toBe(
      401,
    );
    const stranger = await signInOptions();
    expect(
      (await verifyLogin(stranger.challengeId, softAuthenticator().assert(stranger, ORIGIN))).status,
    ).toBe(401);
    const bad = await signInOptions();
    expect((await verifyLogin(bad.challengeId, { id: 5 })).status).toBe(400);
  });

  test("a local passkey uses this domain, for browsers without Related Origin Requests", async () => {
    const options = (await (
      await t.api("/api/auth/passkey/options", {
        method: "POST",
        json: { local: true },
        headers: { Host: "art.example.org" },
      })
    ).json()) as Authentication;
    expect(options.rpId).toBe("art.example.org");
  });

  test("re-authenticating with a passkey refreshes a stale session", async () => {
    const stale = await signIn(t, OWNER.email, OWNER.password);
    t.clock.advance(RECENT_AUTH_MS + 60_000);
    const options = await signInOptions();
    const response = await t.api("/api/auth/reauth", {
      method: "POST",
      cookie: stale,
      json: { challengeId: options.challengeId, response: key.assert(options, ORIGIN) },
    });
    expect(response.status).toBe(200);
    expect(
      ((await (await t.api("/api/me", { cookie: stale })).json()) as { recentAuth: boolean }).recentAuth,
    ).toBe(true);
    cookie = stale;
  });

  test("rename, and the only credential can't be removed", async () => {
    const [mine] = await list(cookie);
    const rename = (id: string) =>
      t.api(`/api/me/passkeys/${id}`, { method: "PATCH", cookie, json: { name: "Phone" } });
    expect((await rename(mine?.id as string)).status).toBe(200);
    expect((await list(cookie))[0]?.name).toBe("Phone");
    expect((await rename("nope")).status).toBe(404);

    // Someone with no password: their passkey is all they can sign in with.
    const solo = await makeAccount(t, orgId, "member");
    expect((await addPasskey(t, solo.cookie, softAuthenticator())).status).toBe(200);
    const [only] = await list(solo.cookie);
    const remove = () => t.api(`/api/me/passkeys/${only?.id}`, { method: "DELETE", cookie: solo.cookie });
    expect((await remove()).status).toBe(409);
    const set = await t.api("/api/me/password", {
      method: "POST",
      cookie: solo.cookie,
      json: { password: PASSWORD },
    });
    expect(set.status).toBe(200);
    expect((await remove()).status).toBe(200);
    expect(await list(solo.cookie)).toEqual([]);
  });

  test("a passkey-only account has no password, not even the dummy one", async () => {
    const solo = await makeAccount(t, orgId, "member");
    expect((await addPasskey(t, solo.cookie, softAuthenticator())).status).toBe(200);
    const attempt = await t.api("/api/auth/password", {
      method: "POST",
      json: { email: solo.email, password: "not a real password" },
    });
    expect(attempt.status).toBe(401);
    const reauth = await t.api("/api/auth/reauth", {
      method: "POST",
      cookie: solo.cookie,
      json: { password: "not a real password" },
    });
    expect(reauth.status).toBe(401);
  });

  test("tokens can't touch passkeys", async () => {
    const { token } = await orgToken(t, cookie);
    expect((await t.api("/api/me/passkeys", { bearer: token })).status).toBe(403);
  });
});

describe("passkey sign-in options", () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer();
    await claim(t);
  });
  afterAll(() => t.stop());

  test("each call stores a challenge, so a client gets 60 per 15 minutes", async () => {
    const options = () => t.api("/api/auth/passkey/options", { method: "POST", json: {} });
    for (let i = 0; i < 60; i++) expect((await options()).status).toBe(200);
    expect((await options()).status).toBe(429);
    t.clock.advance(15 * 60_000 + 1000);
    expect((await options()).status).toBe(200);
  });
});
