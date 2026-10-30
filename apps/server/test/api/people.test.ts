import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { artifacts, invites, people } from "../../src/db/schema.ts";
import { claim, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { publish } from "../publish-helper.ts";

const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
const PASSWORD = "a perfectly long password";

describe("people, invites and tokens", () => {
  let t: TestServer;
  let token: string;
  let owner: string;
  let ownerId: string;

  const invite = async (
    email: string,
    role: string,
    auth: { cookie?: string; bearer?: string } = { bearer: token },
  ) => t.api("/api/invites", { method: "POST", json: { email, role }, ...auth });
  const join = async (url: string, name: string) => {
    const secret = url.split("/join/")[1] as string;
    const response = await t.api(`/api/invites/${secret}/accept`, {
      method: "POST",
      json: { name, password: PASSWORD },
    });
    expect(response.status).toBe(200);
    return (response.headers.getSetCookie()[0] ?? "").split(";")[0] as string;
  };
  const invited = async (email: string, role: string) => {
    const body = (await (await invite(email, role, { cookie: owner })).json()) as { url: string };
    return { cookie: await join(body.url, email.split("@")[0] as string), url: body.url };
  };

  beforeAll(async () => {
    t = await startTestServer();
    const made = await claim(t);
    token = made.token;
    ownerId = made.person.id;
    owner = await signIn(t, OWNER.email, OWNER.password);
  });
  afterAll(() => t.stop());

  test("an invite: preview, accept, then the link is spent", async () => {
    const response = await invite("sam@example.com", "reviewer");
    const { url } = (await response.json()) as { url: string };
    expect(url).toStartWith("http://viewer.test/join/");
    const secret = url.split("/join/")[1] as string;
    expect(await (await t.api(`/api/invites/${secret}`)).json()).toMatchObject({
      orgName: "Mochahub",
      invitedBy: "Zahin",
      role: "reviewer",
      email: "sam@example.com",
    });
    const cookie = await join(url, "Sam");
    const me = (await (await t.api("/api/me", { cookie })).json()) as { person: { role: string } };
    expect(me.person.role).toBe("reviewer");
    expect((await t.api(`/api/invites/${secret}`)).status).toBe(410);
    expect(
      (await t.api(`/api/invites/${secret}/accept`, { method: "POST", json: { name: "x" } })).status,
    ).toBe(410);
  });

  test("invites expire in 7 days, can be revoked, and a new link retires the old one", async () => {
    const one = (await (await invite("a1@example.com", "member")).json()) as {
      url: string;
      invite: { id: string };
    };
    const secret = one.url.split("/join/")[1];
    const fresh = await t.api(`/api/invites/${one.invite.id}/link`, { method: "POST", cookie: owner });
    const { url } = (await fresh.json()) as { url: string };
    expect((await t.api(`/api/invites/${secret}`)).status).toBe(410);
    expect((await t.api(`/api/invites/${url.split("/join/")[1]}`)).status).toBe(200);
    expect((await t.api(`/api/invites/${one.invite.id}`, { method: "DELETE", cookie: owner })).status).toBe(
      200,
    );
    expect((await t.api(`/api/invites/${url.split("/join/")[1]}`)).status).toBe(410);

    const two = (await (await invite("a2@example.com", "member")).json()) as { url: string };
    t.clock.advance(7 * 24 * 3600_000 + 1000);
    expect((await t.api(`/api/invites/${two.url.split("/join/")[1]}`)).status).toBe(410);
    owner = await signIn(t, OWNER.email, OWNER.password);
  });

  test("no duplicates, no owner invites, and only admins invite", async () => {
    expect((await invite(OWNER.email, "member")).status).toBe(409);
    expect((await invite("x@example.com", "owner")).status).toBe(400);
    const { cookie } = await invited("m1@example.com", "member");
    expect(await code(await invite("y@example.com", "member", { cookie }))).toBe("forbidden");
    expect(
      (await t.api("/api/invites", { method: "POST", json: { email: "z@example.com", role: "member" } }))
        .status,
    ).toBe(401);
  });

  test("an admin's CLI token can invite, but a token can't change or remove anyone", async () => {
    const [sam] = await t.server.db.select().from(people).where(eq(people.email, "sam@example.com"));
    expect(
      (await t.api(`/api/people/${sam?.id}`, { method: "PATCH", bearer: token, json: { role: "member" } }))
        .status,
    ).toBe(403);
    expect((await t.api(`/api/people/${sam?.id}`, { method: "DELETE", bearer: token })).status).toBe(403);
    expect((await t.api("/api/people", { bearer: token })).status).toBe(200);
  });

  test("a token can't mint itself a browser session", async () => {
    expect(await code(await invite("adm@example.com", "admin"))).toBe("forbidden");
    expect((await invite("mem@example.com", "member")).status).toBe(200);
    const self = await t.api(`/api/people/${ownerId}/reset-link`, { method: "POST", bearer: token });
    expect(await code(self)).toBe("forbidden");
  });

  test("removing an admin ends what they issued", async () => {
    const admin = await invited("issuer@example.com", "admin");
    const [row] = await t.server.db.select().from(people).where(eq(people.email, "issuer@example.com"));
    const made = (await (
      await invite("throwaway@example.com", "admin", { cookie: admin.cookie })
    ).json()) as { url: string };
    const [sam] = await t.server.db.select().from(people).where(eq(people.email, "sam@example.com"));
    const reset = (await (
      await t.api(`/api/people/${sam?.id}/reset-link`, { method: "POST", cookie: admin.cookie })
    ).json()) as { url: string };
    expect((await t.api(`/api/people/${row?.id}`, { method: "DELETE", cookie: owner })).status).toBe(200);
    expect((await t.api(`/api/invites/${made.url.split("/join/")[1]}`)).status).toBe(410);
    expect((await t.api(`/api/reset/${reset.url.split("/reset/")[1]}`)).status).toBe(410);
  });

  test("roles: an admin can't touch an owner, and there's always an owner", async () => {
    const admin = await invited("ad@example.com", "admin");
    expect(
      await code(
        await t.api(`/api/people/${ownerId}`, {
          method: "PATCH",
          cookie: admin.cookie,
          json: { role: "member" },
        }),
      ),
    ).toBe("forbidden");
    expect(
      await code(await t.api(`/api/people/${ownerId}`, { method: "DELETE", cookie: admin.cookie })),
    ).toBe("forbidden");
    expect(
      await code(await t.api(`/api/people/${ownerId}/reset-link`, { method: "POST", cookie: admin.cookie })),
    ).toBe("forbidden");
    const [sam] = await t.server.db.select().from(people).where(eq(people.email, "sam@example.com"));
    expect(
      await code(
        await t.api(`/api/people/${sam?.id}`, {
          method: "PATCH",
          cookie: admin.cookie,
          json: { role: "owner" },
        }),
      ),
    ).toBe("forbidden");
    expect(
      await code(
        await t.api(`/api/people/${ownerId}`, { method: "PATCH", cookie: owner, json: { role: "member" } }),
      ),
    ).toBe("conflict");
    expect(await code(await t.api(`/api/people/${ownerId}`, { method: "DELETE", cookie: owner }))).toBe(
      "conflict",
    );
    const ok = await t.api(`/api/people/${sam?.id}`, {
      method: "PATCH",
      cookie: admin.cookie,
      json: { role: "member" },
    });
    expect(ok.status).toBe(200);
  });

  test("removing someone ends their sessions and tokens, and frees their email", async () => {
    const { cookie } = await invited("gone@example.com", "member");
    const [row] = await t.server.db.select().from(people).where(eq(people.email, "gone@example.com"));
    expect((await t.api(`/api/people/${row?.id}`, { method: "DELETE", cookie: owner })).status).toBe(200);
    expect((await t.api("/api/me", { cookie })).status).toBe(401);
    expect((await invite("gone@example.com", "member")).status).toBe(200);
  });

  test("a reset link works once and is only for this person", async () => {
    const { cookie } = await invited("reset@example.com", "member");
    const [row] = await t.server.db.select().from(people).where(eq(people.email, "reset@example.com"));
    const { url } = (await (
      await t.api(`/api/people/${row?.id}/reset-link`, { method: "POST", bearer: token })
    ).json()) as { url: string };
    const secret = url.split("/reset/")[1];
    expect(
      (await t.api(`/api/reset/${secret}`, { method: "POST", json: { password: "a brand new password" } }))
        .status,
    ).toBe(200);
    expect((await t.api("/api/me", { cookie })).status).toBe(401);
  });

  test("people lists members and pending invites, for admins only", async () => {
    const list = (await (await t.api("/api/people", { cookie: owner })).json()) as {
      people: { email: string; password: boolean; passkeys: number }[];
      invites: { email: string }[];
    };
    expect(list.people.find((p) => p.email === OWNER.email)).toMatchObject({ password: true, passkeys: 0 });
    expect(list.invites.map((i) => i.email)).toContain("gone@example.com");
    const { cookie } = await invited("m2@example.com", "member");
    expect((await t.api("/api/people", { cookie })).status).toBe(403);
    expect((await t.api("/api/org", { cookie })).status).toBe(403);
  });

  test("org settings: name, defaults and domains", async () => {
    const before = (await (await t.api("/api/org", { cookie: owner })).json()) as { domains: unknown };
    expect(before.domains).toEqual({
      home: "viewer.test",
      publicUrl: "http://viewer.test",
      moreUrls: ["https://art.example.org"],
      contentUrl: "http://content.test",
    });
    const patched = await t.api("/api/org", {
      method: "PATCH",
      cookie: owner,
      json: { name: "Mocha", settings: { defaultVisibility: "me" } },
    });
    expect(patched.status).toBe(200);
    expect((await t.api("/api/org", { method: "PATCH", bearer: token, json: { name: "x" } })).status).toBe(
      403,
    );
    const meta = (await (await t.api("/api/meta")).json()) as { orgName: string };
    expect(meta.orgName).toBe("Mocha");
    await publish(t, token, { slug: "by-default" });
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "by-default"));
    expect(row?.visibility).toBe("me");
    await t.api("/api/org", {
      method: "PATCH",
      cookie: owner,
      json: { settings: { defaultVisibility: "org" } },
    });
  });

  test("org tokens: made with a recent sign-in, shown once, scoped to projects, revocable", async () => {
    const make = (cookie: string, json: unknown) => t.api("/api/tokens", { method: "POST", cookie, json });
    const made = (await (await make(owner, { name: "CI", scopes: ["publish", "read", "org"] })).json()) as {
      id: string;
      token: string;
    };
    expect(made.token).toStartWith("art_");
    const rows = (await (await t.api("/api/tokens", { cookie: owner })).json()) as { name: string }[];
    expect(JSON.stringify(rows)).not.toContain(made.token);
    expect((await publish(t, made.token, { project: "ci-project", slug: "built" })).status).toBe(200);
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "built"));
    expect(row?.publisherId).toBe(ownerId);
    expect((await t.api(`/api/tokens/${made.id}`, { method: "DELETE", cookie: owner })).status).toBe(200);
    expect((await t.api("/api/home", { bearer: made.token })).status).toBe(401);
    expect((await t.api("/api/tokens", { bearer: token })).status).toBe(403);
    expect((await t.api("/api/tokens/nope", { method: "DELETE", cookie: owner })).status).toBe(404);
    t.clock.advance(11 * 60_000);
    expect(await code(await make(owner, { name: "x", scopes: [] }))).toBe("recent_auth_required");
    owner = await signIn(t, OWNER.email, OWNER.password);
  });

  test("an invite can't be accepted twice at once", async () => {
    const { url } = (await (await invite("race@example.com", "member")).json()) as { url: string };
    const secret = url.split("/join/")[1];
    const accept = () =>
      t.api(`/api/invites/${secret}/accept`, { method: "POST", json: { name: "R", password: PASSWORD } });
    const results = await Promise.all([accept(), accept(), accept()]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const rows = await t.server.db.select().from(invites).where(eq(invites.email, "race@example.com"));
    expect(rows).toHaveLength(1);
  });

  test("a token can't get a fresh link for an admin invite either", async () => {
    const made = (await (await invite("fresh-admin@example.com", "admin", { cookie: owner })).json()) as {
      invite: { id: string };
      url: string;
    };
    const asToken = await t.api(`/api/invites/${made.invite.id}/link`, { method: "POST", bearer: token });
    expect(await code(asToken)).toBe("forbidden");
    // The old link is untouched, and the viewer can still copy a new one.
    expect((await t.api(`/api/invites/${made.url.split("/join/")[1]}`)).status).toBe(200);
    expect(
      (await t.api(`/api/invites/${made.invite.id}/link`, { method: "POST", cookie: owner })).status,
    ).toBe(200);
    // A token still gets a link for what it may invite.
    const member = (await (await invite("fresh-member@example.com", "member")).json()) as {
      invite: { id: string };
    };
    expect(
      (await t.api(`/api/invites/${member.invite.id}/link`, { method: "POST", bearer: token })).status,
    ).toBe(200);
  });

  test("a token can't issue a reset link for another owner", async () => {
    const second = await invited("second-owner@example.com", "admin");
    const [row] = await t.server.db.select().from(people).where(eq(people.email, "second-owner@example.com"));
    const promoted = await t.api(`/api/people/${row?.id}`, {
      method: "PATCH",
      cookie: owner,
      json: { role: "owner" },
    });
    expect(promoted.status).toBe(200);
    const asToken = await t.api(`/api/people/${row?.id}/reset-link`, { method: "POST", bearer: token });
    expect(await code(asToken)).toBe("forbidden");
    // An owner in the viewer still can.
    const asPerson = await t.api(`/api/people/${row?.id}/reset-link`, { method: "POST", cookie: owner });
    expect(asPerson.status).toBe(200);
    expect((await t.api("/api/me", { cookie: second.cookie })).status).toBe(200);
  });

  test("losing admin ends what they issued, like removal does", async () => {
    const admin = await invited("demoted@example.com", "admin");
    const [row] = await t.server.db.select().from(people).where(eq(people.email, "demoted@example.com"));
    const [sam] = await t.server.db.select().from(people).where(eq(people.email, "sam@example.com"));
    const made = (await (
      await invite("comes-back@example.com", "admin", { cookie: admin.cookie })
    ).json()) as { url: string };
    const reset = (await (
      await t.api(`/api/people/${sam?.id}/reset-link`, { method: "POST", cookie: admin.cookie })
    ).json()) as { url: string };
    const inviteUrl = `/api/invites/${made.url.split("/join/")[1]}`;
    const resetUrl = `/api/reset/${reset.url.split("/reset/")[1]}`;
    expect((await t.api(inviteUrl)).status).toBe(200);

    // Losing admin takes the invite and the reset link back, so they can't hand the power over again.
    const demote = await t.api(`/api/people/${row?.id}`, {
      method: "PATCH",
      cookie: owner,
      json: { role: "member" },
    });
    expect(demote.status).toBe(200);
    expect((await t.api(inviteUrl)).status).toBe(410);
    expect((await t.api(resetUrl)).status).toBe(410);
  });
});
