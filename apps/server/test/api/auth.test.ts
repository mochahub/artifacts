import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DevicePollResult, DeviceStarted, Me, SessionRow } from "@artifacts/schema";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { sha256 } from "../../src/auth/secrets.ts";
import { deviceCodes, org, people, resetLinks, sessions, tokens } from "../../src/db/schema.ts";
import { claim, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";

const error = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
const SETUP = "s".repeat(48);
const setupBody = { setupToken: SETUP, orgName: "Mochahub", clientName: "Mac", ...OWNER };

describe("setup mode", () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer();
  });
  afterAll(() => t.stop());

  test("every API but health, meta and setup answers 503", async () => {
    for (const [path, method] of [
      ["/api/me", "GET"],
      ["/api/auth/password", "POST"],
      ["/api/recover", "POST"],
      ["/api/device/start", "POST"],
      ["/api/nothing", "GET"],
    ] as const) {
      const response = await t.api(path, { method });
      expect(response.status).toBe(503);
      expect(await error(response)).toBe("setup_mode");
    }
    expect((await t.api("/api/health")).status).toBe(200);
    expect((await t.api("/api/meta")).status).toBe(200);
  });

  test("a wrong token is refused", async () => {
    const response = await t.api("/api/setup", { method: "POST", json: { ...setupBody, setupToken: "no" } });
    expect(response.status).toBe(403);
  });

  test("a short password is refused", async () => {
    const response = await t.api("/api/setup", { method: "POST", json: { ...setupBody, password: "short" } });
    expect(response.status).toBe(400);
  });

  test("two claims at once make one organization", async () => {
    const results = await Promise.all(
      [0, 1, 2].map(() => t.api("/api/setup", { method: "POST", json: setupBody })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await t.server.db.select().from(org)).toHaveLength(1);
    const [row] = await t.server.db.select().from(org);
    expect(row?.homeDomain).toBe("viewer.test");
    expect(row?.pseudonymKey).toHaveLength(32);
    const [token] = await t.server.db.select().from(tokens);
    expect(token?.scopes).toEqual(["publish", "comment", "read", "manage", "data"]);
  });

  test("setup runs once", async () => {
    expect((await t.api("/api/setup", { method: "POST", json: setupBody })).status).toBe(409);
  });
});

describe("signing in", () => {
  let t: TestServer;
  let owner: { person: { id: string }; token: string };
  beforeAll(async () => {
    t = await startTestServer();
    owner = await claim(t);
  });
  afterAll(() => t.stop());

  test("a token works, and the owner sees themselves", async () => {
    const response = await t.api("/api/me", { bearer: owner.token });
    expect(Me.parse(await response.json())).toMatchObject({
      person: { email: OWNER.email, role: "owner" },
      org: { name: "Mochahub" },
      recentAuth: false,
    });
  });

  test("a bad token fails, and doesn't fall through to a cookie", async () => {
    const cookie = await signIn(t, OWNER.email, OWNER.password);
    expect((await t.api("/api/me", { bearer: "art_nope", cookie })).status).toBe(401);
  });

  test("an unknown API path is a JSON 404, not the viewer", async () => {
    const response = await t.api("/api/nope");
    expect(response.status).toBe(404);
    expect(await error(response)).toBe("not_found");
  });

  test("no caller gets 401", async () => {
    expect(await error(await t.api("/api/me"))).toBe("unauthenticated");
  });

  test("the session cookie has the flags in 04, on any case of email", async () => {
    const response = await t.api("/api/auth/password", {
      method: "POST",
      json: { email: OWNER.email.toUpperCase(), password: OWNER.password },
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie()[0] ?? "";
    expect(cookie).toContain("art_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=2592000");
    // viewer.test is plain http in tests, where a Secure cookie would be dropped.
    expect(cookie).not.toContain("Secure");
    expect(cookie).not.toContain("Domain");
  });

  test("an https viewer origin gets a Secure cookie", async () => {
    const response = await t.api("/api/auth/password", {
      method: "POST",
      headers: { Host: "art.example.org" },
      json: { email: OWNER.email, password: OWNER.password },
    });
    expect(response.headers.getSetCookie()[0]).toContain("Secure");
  });

  test("the stored session holds only a hash", async () => {
    const cookie = await signIn(t, OWNER.email, OWNER.password);
    const secret = cookie.split("=")[1] as string;
    const rows = await t.server.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, sha256(secret)));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  test("CSRF: a cookie needs a viewer Origin", async () => {
    const cookie = await signIn(t, OWNER.email, OWNER.password);
    const missing = await fetch(
      new Request(`http://127.0.0.1:${t.server.ports.viewer}/api/auth/logout`, {
        method: "POST",
        headers: { Host: "viewer.test", Cookie: cookie },
      }),
    );
    expect(await error(missing)).toBe("csrf");
    const evil = await t.api("/api/auth/logout", {
      method: "POST",
      cookie,
      headers: { Origin: "http://evil.test" },
    });
    expect(evil.status).toBe(403);
    expect((await t.api("/api/me", { cookie })).status).toBe(200);
  });

  test("CSRF: only a Bearer token skips the Origin check, not any Authorization header", async () => {
    const cookie = await signIn(t, OWNER.email, OWNER.password);
    const raw = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${t.server.ports.viewer}/api/auth/logout`, {
        method: "POST",
        headers: { Host: "viewer.test", Cookie: cookie, ...headers },
      });
    // The server would still read the cookie here, so the header can't be a way round the check.
    expect(await error(await raw({ Authorization: "Basic eDp4" }))).toBe("csrf");
    expect(await error(await raw({ Authorization: "bearer lowercase", Origin: "http://evil.test" }))).toBe(
      "csrf",
    );
    expect((await t.api("/api/me", { cookie })).status).toBe(200);
    // A real token needs no Origin: it carries no cookie, so it reaches the route (which wants a browser).
    const bearer = await fetch(`http://127.0.0.1:${t.server.ports.viewer}/api/auth/reauth`, {
      method: "POST",
      headers: { Host: "viewer.test", Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ password: OWNER.password }),
    });
    expect(await error(bearer)).toBe("forbidden");
  });

  test("CSRF: a browser on another site can't sign someone in", async () => {
    const response = await t.api("/api/auth/password", {
      method: "POST",
      headers: { Origin: "http://evil.test" },
      json: { email: OWNER.email, password: OWNER.password },
    });
    expect(await error(response)).toBe("csrf");
  });

  test("an old CLI is told to upgrade", async () => {
    const response = await t.api("/api/meta", { headers: { "Artifacts-CLI": "0.0.1" } });
    expect(response.status).toBe(426);
    expect(((await response.json()) as { error: { details: unknown } }).error.details).toEqual({
      minVersion: "0.1.0",
    });
  });

  test("logout ends this session, and a CLI token can end itself", async () => {
    const cookie = await signIn(t, OWNER.email, OWNER.password);
    expect((await t.api("/api/auth/logout", { method: "POST", cookie })).status).toBe(200);
    expect((await t.api("/api/me", { cookie })).status).toBe(401);

    const fresh = await signIn(t, OWNER.email, OWNER.password);
    const { token } = await freshToken(t, fresh);
    expect((await t.api("/api/auth/logout", { method: "POST", bearer: token })).status).toBe(200);
    expect((await t.api("/api/me", { bearer: token })).status).toBe(401);
  });

  test("sessions slide, then expire", async () => {
    const cookie = await signIn(t, OWNER.email, OWNER.password);
    t.clock.advance(29 * 24 * 3600_000);
    expect((await t.api("/api/me", { cookie })).status).toBe(200);
    t.clock.advance(29 * 24 * 3600_000);
    expect((await t.api("/api/me", { cookie })).status).toBe(200);
    t.clock.advance(31 * 24 * 3600_000);
    expect((await t.api("/api/me", { cookie })).status).toBe(401);
  });

  test("sessions and CLI tokens are listed and can be ended", async () => {
    const cookie = await signIn(t, OWNER.email, OWNER.password);
    const list = z.array(SessionRow).parse(await (await t.api("/api/me/sessions", { cookie })).json());
    expect(list.filter((row) => row.current)).toHaveLength(1);
    const cli = list.find((row) => row.kind === "cli");
    expect(cli).toBeDefined();
    expect((await t.api("/api/me/sessions", { bearer: owner.token })).status).toBe(403);
    expect(
      (await t.api("/api/me/sessions/00000000-0000-7000-8000-000000000000", { method: "DELETE", cookie }))
        .status,
    ).toBe(404);
    expect((await t.api(`/api/me/sessions/${cli?.id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await t.api("/api/me", { bearer: owner.token })).status).toBe(401);
    owner = await freshToken(t, cookie);
  });

  test("a stale session must re-authenticate to change a password, and the change ends other sessions", async () => {
    const other = await signIn(t, OWNER.email, OWNER.password);
    const cookie = await signIn(t, OWNER.email, OWNER.password);
    t.clock.advance(11 * 60_000);
    const stale = await t.api("/api/me/password", {
      method: "POST",
      cookie,
      json: { password: "a new long password" },
    });
    expect(await error(stale)).toBe("recent_auth_required");
    const wrong = await t.api("/api/auth/reauth", {
      method: "POST",
      cookie,
      json: { password: "wrong one" },
    });
    expect(wrong.status).toBe(401);
    expect(
      (await t.api("/api/auth/reauth", { method: "POST", cookie, json: { password: OWNER.password } }))
        .status,
    ).toBe(200);
    const ok = await t.api("/api/me/password", {
      method: "POST",
      cookie,
      json: { password: "a new long password" },
    });
    expect(ok.status).toBe(200);
    expect((await t.api("/api/me", { cookie: other })).status).toBe(401);
    expect((await t.api("/api/me", { cookie })).status).toBe(200);
    await t.api("/api/me/password", { method: "POST", cookie, json: { password: OWNER.password } });
  });

  test("a removed person's session stops at once", async () => {
    const cookie = await signIn(t, OWNER.email, OWNER.password);
    await t.server.db.update(people).set({ removedAt: t.clock.now() });
    expect((await t.api("/api/me", { cookie })).status).toBe(401);
    await t.server.db.update(people).set({ removedAt: null });
  });
});

/** Device approval, to mint a token after a test revoked the first one. */
async function freshToken(t: TestServer, cookie: string) {
  const started = DeviceStarted.parse(
    await (await t.api("/api/device/start", { method: "POST", json: { clientName: "Mac" } })).json(),
  );
  await t.api(`/api/device/${started.userCode}/approve`, { method: "POST", cookie });
  const poll = await t.api("/api/device/poll", { method: "POST", json: { deviceCode: started.deviceCode } });
  const result = DevicePollResult.parse(await poll.json());
  if (result.status !== "approved") throw new Error("not approved");
  t.clock.advance(6000);
  return { person: result.person, token: result.token };
}

describe("rate limits", () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer();
    await claim(t);
  });
  afterAll(() => t.stop());

  const attempt = (password: string) =>
    t.api("/api/auth/password", { method: "POST", json: { email: OWNER.email, password } });

  test("five failures, then one attempt a minute, doubling; success clears it", async () => {
    for (let i = 0; i < 5; i++) expect((await attempt("wrong password")).status).toBe(401);
    const blocked = await attempt(OWNER.password);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    t.clock.advance(61_000);
    expect((await attempt("wrong password")).status).toBe(401);
    t.clock.advance(61_000);
    expect((await attempt(OWNER.password)).status).toBe(429);
    t.clock.advance(61_000);
    expect((await attempt(OWNER.password)).status).toBe(200);
    expect((await attempt(OWNER.password)).status).toBe(200);
  });

  test("thirty attempts per IP per 15 minutes", async () => {
    t.clock.advance(16 * 60_000);
    const body = (i: number) => ({ email: `x${i}@example.com`, password: "wrong password" });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push((await t.api("/api/auth/password", { method: "POST", json: body(i) })).status);
    }
    expect(statuses.filter((s) => s === 401)).toHaveLength(30);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("the device flow", () => {
  let t: TestServer;
  let cookie: string;
  beforeAll(async () => {
    t = await startTestServer();
    await claim(t);
    cookie = await signIn(t, OWNER.email, OWNER.password);
  });
  afterAll(() => t.stop());

  const start = async () =>
    DeviceStarted.parse(
      await (
        await t.api("/api/device/start", {
          method: "POST",
          headers: { "User-Agent": "artifacts/0.1" },
          json: { clientName: "Sam's MacBook Pro", agent: "Claude Code" },
        })
      ).json(),
    );
  const poll = (deviceCode: string) => {
    t.clock.advance(5001);
    return t.api("/api/device/poll", { method: "POST", json: { deviceCode } });
  };

  test("start, approve, then one poll collects the token", async () => {
    const started = await start();
    expect(started.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(started.verificationUrl).toBe("http://viewer.test/device");
    expect(started.verificationUrl).not.toContain(started.userCode);
    expect(((await (await poll(started.deviceCode)).json()) as { status: string }).status).toBe("pending");

    const details = await t.api(`/api/device/${started.userCode.toLowerCase().replace("-", "")}`, { cookie });
    expect(await details.json()).toMatchObject({
      clientName: "Sam's MacBook Pro",
      agent: "Claude Code",
      userAgent: "artifacts/0.1",
    });

    expect((await t.api(`/api/device/${started.userCode}/approve`, { method: "POST", cookie })).status).toBe(
      200,
    );
    const result = DevicePollResult.parse(await (await poll(started.deviceCode)).json());
    expect(result.status).toBe("approved");
    if (result.status === "approved") {
      expect((await t.api("/api/me", { bearer: result.token })).status).toBe(200);
      const [row] = await t.server.db
        .select()
        .from(tokens)
        .where(eq(tokens.tokenHash, sha256(result.token)));
      expect(row?.scopes).toEqual(["publish", "comment", "read", "manage", "data"]);
    }
    expect((await poll(started.deviceCode)).status).toBe(410);
  });

  test("polling faster than the interval gets 429", async () => {
    const { deviceCode } = await start();
    await poll(deviceCode);
    const fast = await t.api("/api/device/poll", { method: "POST", json: { deviceCode } });
    expect(fast.status).toBe(429);
  });

  test("the details and approval need a signed-in browser", async () => {
    const { userCode } = await start();
    expect((await t.api(`/api/device/${userCode}`)).status).toBe(401);
    expect((await t.api(`/api/device/${userCode}/approve`, { method: "POST" })).status).toBe(401);
    const { token } = await (async () => {
      const s = await start();
      await t.api(`/api/device/${s.userCode}/approve`, { method: "POST", cookie });
      return DevicePollResult.parse(await (await poll(s.deviceCode)).json()) as { token: string };
    })();
    expect((await t.api(`/api/device/${userCode}/approve`, { method: "POST", bearer: token })).status).toBe(
      403,
    );
    expect((await t.api("/api/device/BBBB-BBBB", { cookie })).status).toBe(404);
  });

  test("approving needs a recent sign-in", async () => {
    const { userCode } = await start();
    t.clock.advance(11 * 60_000);
    const stale = await t.api(`/api/device/${userCode}/approve`, { method: "POST", cookie });
    expect(await error(stale)).toBe("recent_auth_required");
    await t.api("/api/auth/reauth", { method: "POST", cookie, json: { password: OWNER.password } });
  });

  test("deny ends it", async () => {
    const { userCode, deviceCode } = await start();
    expect((await t.api(`/api/device/${userCode}/deny`, { method: "POST", cookie })).status).toBe(200);
    expect(((await (await poll(deviceCode)).json()) as { status: string }).status).toBe("denied");
    expect((await t.api(`/api/device/${userCode}/approve`, { method: "POST", cookie })).status).toBe(404);
  });

  test("codes expire after 10 minutes", async () => {
    const { userCode, deviceCode } = await start();
    t.clock.advance(601_000);
    expect((await poll(deviceCode)).status).toBe(410);
    expect((await t.api(`/api/device/${userCode}`, { cookie })).status).toBe(404);
    const stored = await t.server.db.select().from(deviceCodes).where(sql`status = 'pending'`);
    expect(stored.every((row) => !row.deviceCodeHash.includes(deviceCode))).toBe(true);
  });

  test("start is limited to 10 per IP per hour", async () => {
    t.clock.advance(3601_000);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await t.api("/api/device/start", { method: "POST", json: { clientName: "x" } })).status);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("recovery and reset", () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer();
    await claim(t);
  });
  afterAll(() => t.stop());

  const recover = (json: unknown) => t.api("/api/recover", { method: "POST", json });

  test("the setup token issues a one-hour, one-use reset link for an owner", async () => {
    expect((await recover({ setupToken: "wrong", email: OWNER.email })).status).toBe(403);
    expect((await recover({ setupToken: SETUP, email: "nobody@example.com" })).status).toBe(404);
    const { resetUrl } = (await (await recover({ setupToken: SETUP, email: OWNER.email })).json()) as {
      resetUrl: string;
    };
    const token = resetUrl.split("/reset/")[1] as string;
    expect(resetUrl.startsWith("http://viewer.test/reset/")).toBe(true);

    expect(await (await t.api(`/api/reset/${token}`)).json()).toEqual({ email: OWNER.email });
    const old = await signIn(t, OWNER.email, OWNER.password);
    const reset = await t.api(`/api/reset/${token}`, {
      method: "POST",
      json: { password: "my new long password" },
    });
    expect(reset.status).toBe(200);
    const fresh = (reset.headers.getSetCookie()[0] ?? "").split(";")[0] as string;
    expect((await t.api("/api/me", { cookie: fresh })).status).toBe(200);
    expect((await t.api("/api/me", { cookie: old })).status).toBe(401);
    expect((await t.api(`/api/reset/${token}`)).status).toBe(410);
    expect(
      (await t.api(`/api/reset/${token}`, { method: "POST", json: { password: "another long password" } }))
        .status,
    ).toBe(410);
    await signIn(t, OWNER.email, "my new long password");
  });

  test("an expired link answers 410", async () => {
    const { resetUrl } = (await (await recover({ setupToken: SETUP, email: OWNER.email })).json()) as {
      resetUrl: string;
    };
    t.clock.advance(3601_000);
    expect((await t.api(`/api/reset/${resetUrl.split("/reset/")[1]}`)).status).toBe(410);
    const rows = await t.server.db.select().from(resetLinks);
    expect(rows.some((row) => row.createdBy !== null)).toBe(false);
  });

  test("recovery is limited to 5 per hour", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await recover({ setupToken: "x", email: OWNER.email })).status);
    expect(statuses.slice(0, 5).every((status) => status === 403)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
