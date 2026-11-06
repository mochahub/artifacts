import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Artifact } from "@artifacts/schema";
import { RECENT_AUTH_MS } from "../../src/auth/sessions.ts";
import {
  acceptInvite,
  claim,
  code,
  inviteSecret,
  joinAsGuest,
  json,
  OWNER,
  orgToken,
  PASSWORD,
  signIn,
  startTestServer,
  type TestServer,
} from "../helpers.ts";
import { makeAccount, published } from "../publish-helper.ts";

describe("people, invites and tokens", () => {
  let t: TestServer;
  let token: string;
  let owner: string;
  let ownerId: string;
  let orgId: string;

  const invite = async (
    email: string,
    role: string,
    auth: { cookie?: string; bearer?: string } = { bearer: token },
  ) => t.api("/api/invites", { method: "POST", json: { email, role }, ...auth });
  /** Someone invited by the owner who has joined: their id and session. */
  const invited = async (email: string, role: string) => {
    const { url } = await json<{ url: string }>(await invite(email, role, { cookie: owner }));
    const { person, cookie } = await acceptInvite(t, url, email.split("@")[0] as string);
    return { id: person.id, cookie, url };
  };
  /** A person's id, as the People page shows it. */
  const idOf = async (email: string) => {
    const list = await json<{ people: { id: string; email: string }[] }>(
      await t.api("/api/people", { cookie: owner }),
    );
    return list.people.find((row) => row.email === email)?.id as string;
  };

  beforeAll(async () => {
    t = await startTestServer();
    const made = await claim(t);
    token = made.token;
    ownerId = made.person.id;
    orgId = made.orgId;
    owner = await signIn(t, OWNER.email, OWNER.password);
  });
  afterAll(() => t.stop());

  test("an invite: preview, accept, then the link is spent", async () => {
    const response = await invite("sam@example.com", "reviewer");
    const { url } = (await response.json()) as { url: string };
    expect(url).toStartWith("http://viewer.test/join/");
    const secret = inviteSecret(url);
    expect(await (await t.api(`/api/invites/${secret}`)).json()).toMatchObject({
      orgName: "Mochahub",
      invitedBy: "Zahin",
      role: "reviewer",
      email: "sam@example.com",
    });
    const { cookie } = await acceptInvite(t, url, "Sam");
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
    const secret = inviteSecret(one.url);
    const fresh = await t.api(`/api/invites/${one.invite.id}/link`, { method: "POST", cookie: owner });
    const { url } = (await fresh.json()) as { url: string };
    expect((await t.api(`/api/invites/${secret}`)).status).toBe(410);
    expect((await t.api(`/api/invites/${inviteSecret(url)}`)).status).toBe(200);
    expect((await t.api(`/api/invites/${one.invite.id}`, { method: "DELETE", cookie: owner })).status).toBe(
      200,
    );
    expect((await t.api(`/api/invites/${inviteSecret(url)}`)).status).toBe(410);

    const two = (await (await invite("a2@example.com", "member")).json()) as { url: string };
    t.clock.advance(7 * 24 * 3600_000 + 1000);
    expect((await t.api(`/api/invites/${inviteSecret(two.url)}`)).status).toBe(410);
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
    const sam = await idOf("sam@example.com");
    expect(
      (await t.api(`/api/people/${sam}`, { method: "PATCH", bearer: token, json: { role: "member" } }))
        .status,
    ).toBe(403);
    expect((await t.api(`/api/people/${sam}`, { method: "DELETE", bearer: token })).status).toBe(403);
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
    const made = (await (
      await invite("throwaway@example.com", "admin", { cookie: admin.cookie })
    ).json()) as { url: string };
    const sam = await idOf("sam@example.com");
    const reset = (await (
      await t.api(`/api/people/${sam}/reset-link`, { method: "POST", cookie: admin.cookie })
    ).json()) as { url: string };
    expect((await t.api(`/api/people/${admin.id}`, { method: "DELETE", cookie: owner })).status).toBe(200);
    expect((await t.api(`/api/invites/${inviteSecret(made.url)}`)).status).toBe(410);
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
    const sam = await idOf("sam@example.com");
    expect(
      await code(
        await t.api(`/api/people/${sam}`, {
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
    const ok = await t.api(`/api/people/${sam}`, {
      method: "PATCH",
      cookie: admin.cookie,
      json: { role: "member" },
    });
    expect(ok.status).toBe(200);
  });

  test("removing someone ends their sessions and tokens, and frees their email", async () => {
    const joined = await invited("gone@example.com", "member");
    const withToken = await makeAccount(t, orgId, "member");
    for (const who of [joined, withToken]) {
      expect((await t.api("/api/me", { cookie: who.cookie })).status).toBe(200);
    }
    expect((await t.api("/api/me", { bearer: withToken.token })).status).toBe(200);

    for (const who of [joined, withToken]) {
      expect((await t.api(`/api/people/${who.id}`, { method: "DELETE", cookie: owner })).status).toBe(200);
      expect((await t.api("/api/me", { cookie: who.cookie })).status).toBe(401);
    }
    expect((await t.api("/api/me", { bearer: withToken.token })).status).toBe(401);
    expect((await invite("gone@example.com", "member")).status).toBe(200);
  });

  test("removing someone ends the organization tokens and share links they created", async () => {
    const artifactId = (await published(t, token, { slug: "removal-target", visibility: "org" })).id;
    const leaving = await invited("leaving@example.com", "admin");
    const makeToken = (cookie: string, name: string) => orgToken(t, cookie, { name });
    const makeLink = async (cookie: string) => {
      const made = await t.api(`/api/artifacts/${artifactId}/links`, {
        method: "POST",
        cookie,
        json: { permission: "comment" },
      });
      expect(made.status).toBe(200);
      return ((await made.json()) as { url: string }).url.split("/s/")[1] as string;
    };
    const theirToken = await makeToken(leaving.cookie, "leaving's");
    const ownersToken = await makeToken(owner, "owner's");
    const theirLink = await makeLink(leaving.cookie);
    const ownersLink = await makeLink(owner);
    const theirGuest = await joinAsGuest(t, theirLink, "Riley");
    const ownersGuest = await joinAsGuest(t, ownersLink, "Riley");
    expect((await t.api("/api/home", { bearer: theirToken.token })).status).toBe(200);
    expect((await t.api(`/api/artifacts/${artifactId}`, { cookie: theirGuest })).status).toBe(200);

    expect((await t.api(`/api/people/${leaving.id}`, { method: "DELETE", cookie: owner })).status).toBe(200);

    expect((await t.api("/api/home", { bearer: theirToken.token })).status).toBe(401);
    expect(await code(await t.api(`/api/s/${theirLink}`))).toBe("gone");
    expect(
      await code(await t.api(`/api/s/${theirLink}/guest`, { method: "POST", json: { name: "Again" } })),
    ).toBe("gone");
    expect((await t.api(`/api/artifacts/${artifactId}`, { cookie: theirGuest })).status).toBe(404);
    // Only what the removed person made: the owner's token and link carry on.
    expect((await t.api("/api/home", { bearer: ownersToken.token })).status).toBe(200);
    expect((await t.api(`/api/s/${ownersLink}`)).status).toBe(200);
    expect((await t.api(`/api/artifacts/${artifactId}`, { cookie: ownersGuest })).status).toBe(200);
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
    const { id } = await published(t, token, { slug: "by-default" });
    const artifact = Artifact.parse(await json(await t.api(`/api/artifacts/${id}`, { bearer: token })));
    expect(artifact.visibility).toBe("me");
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
    const { id } = await published(t, made.token, { project: "ci-project", slug: "built" });
    const artifact = Artifact.parse(await json(await t.api(`/api/artifacts/${id}`, { cookie: owner })));
    expect(artifact.publisherId).toBe(ownerId);
    expect((await t.api(`/api/tokens/${made.id}`, { method: "DELETE", cookie: owner })).status).toBe(200);
    expect((await t.api("/api/home", { bearer: made.token })).status).toBe(401);
    expect((await t.api("/api/tokens", { bearer: token })).status).toBe(403);
    expect((await t.api("/api/tokens/nope", { method: "DELETE", cookie: owner })).status).toBe(404);
    t.clock.advance(RECENT_AUTH_MS + 1000);
    expect(await code(await make(owner, { name: "x", scopes: [] }))).toBe("recent_auth_required");
    owner = await signIn(t, OWNER.email, OWNER.password);
  });

  test("an invite can't be accepted twice at once", async () => {
    const { url } = (await (await invite("race@example.com", "member")).json()) as { url: string };
    const accept = () =>
      t.api(`/api/invites/${inviteSecret(url)}/accept`, {
        method: "POST",
        json: { name: "R", password: PASSWORD },
      });
    const results = await Promise.all([accept(), accept(), accept()]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const list = await json<{ people: { email: string }[] }>(await t.api("/api/people", { cookie: owner }));
    expect(list.people.filter((row) => row.email === "race@example.com")).toHaveLength(1);
  });

  test("a token can't get a fresh link for an admin invite either", async () => {
    const made = (await (await invite("fresh-admin@example.com", "admin", { cookie: owner })).json()) as {
      invite: { id: string };
      url: string;
    };
    const asToken = await t.api(`/api/invites/${made.invite.id}/link`, { method: "POST", bearer: token });
    expect(await code(asToken)).toBe("forbidden");
    // The old link is untouched, and the viewer can still copy a new one.
    expect((await t.api(`/api/invites/${inviteSecret(made.url)}`)).status).toBe(200);
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
    const promoted = await t.api(`/api/people/${second.id}`, {
      method: "PATCH",
      cookie: owner,
      json: { role: "owner" },
    });
    expect(promoted.status).toBe(200);
    const asToken = await t.api(`/api/people/${second.id}/reset-link`, { method: "POST", bearer: token });
    expect(await code(asToken)).toBe("forbidden");
    // An owner in the viewer still can.
    const asPerson = await t.api(`/api/people/${second.id}/reset-link`, { method: "POST", cookie: owner });
    expect(asPerson.status).toBe(200);
    expect((await t.api("/api/me", { cookie: second.cookie })).status).toBe(200);
  });

  test("losing admin ends what they issued, like removal does", async () => {
    const admin = await invited("demoted@example.com", "admin");
    const sam = await idOf("sam@example.com");
    const made = (await (
      await invite("comes-back@example.com", "admin", { cookie: admin.cookie })
    ).json()) as { url: string };
    const reset = (await (
      await t.api(`/api/people/${sam}/reset-link`, { method: "POST", cookie: admin.cookie })
    ).json()) as { url: string };
    const inviteUrl = `/api/invites/${inviteSecret(made.url)}`;
    const resetUrl = `/api/reset/${reset.url.split("/reset/")[1]}`;
    expect((await t.api(inviteUrl)).status).toBe(200);

    // Losing admin takes the invite and the reset link back, so they can't hand the power over again.
    const demote = await t.api(`/api/people/${admin.id}`, {
      method: "PATCH",
      cookie: owner,
      json: { role: "member" },
    });
    expect(demote.status).toBe(200);
    expect((await t.api(inviteUrl)).status).toBe(410);
    expect((await t.api(resetUrl)).status).toBe(410);
  });
});
