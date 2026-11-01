import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { activity, artifacts, artifactTeamAccess, people, teamMembers, teams } from "../../src/db/schema.ts";
import { claim, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { makeAccount, publish } from "../publish-helper.ts";

type Account = Awaited<ReturnType<typeof makeAccount>>;
const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;
const PASSWORD = "a perfectly long password";

describe("teams", () => {
  let t: TestServer;
  let token: string;
  let owner: string;
  let orgId: string;
  let lead: Account;
  let member: Account;
  let reviewer: Account;
  let outside: Account;

  const makeTeam = async (name: string) => {
    const response = await t.api("/api/teams", { method: "POST", cookie: owner, json: { name } });
    expect(response.status).toBe(200);
    return (await json<{ team: { id: string; slug: string } }>(response)).team;
  };
  const addMember = (slug: string, who: { id: string }, role: "lead" | "member" = "member", cookie = owner) =>
    t.api(`/api/teams/${slug}/members/${who.id}`, { method: "PUT", cookie, json: { role } });
  const publishPrivate = async (slug: string, bearer = token) => {
    const result = await publish(t, bearer, { slug, visibility: "me" });
    expect(result.status).toBe(200);
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, slug));
    return row?.id as string;
  };
  const share = (artifact: string, team: string, permission: string, auth: object = { cookie: owner }) =>
    t.api(`/api/artifacts/${artifact}/teams/${team}`, { method: "PUT", json: { permission }, ...auth });

  beforeAll(async () => {
    t = await startTestServer();
    const made = await claim(t);
    token = made.token;
    owner = await signIn(t, OWNER.email, OWNER.password);
    const [row] = await t.server.db.select().from(people).limit(1);
    orgId = row?.orgId as string;
    lead = await makeAccount(t, orgId, "member");
    member = await makeAccount(t, orgId, "member");
    reviewer = await makeAccount(t, orgId, "reviewer");
    outside = await makeAccount(t, orgId, "outside");
  });
  afterAll(() => t.stop());

  test("admins create, rename and delete; nobody else does, and tokens never", async () => {
    const team = await makeTeam("Platform & Growth");
    expect(team.slug).toBe("platform-growth");
    expect(
      await code(
        await t.api("/api/teams", { method: "POST", cookie: owner, json: { name: "Platform Growth" } }),
      ),
    ).toBe("conflict");
    for (const auth of [{ cookie: member.cookie }, { bearer: token }]) {
      expect((await t.api("/api/teams", { method: "POST", json: { name: "Nope" }, ...auth })).status).toBe(
        403,
      );
    }
    const renamed = await t.api(`/api/teams/${team.slug}`, {
      method: "PATCH",
      cookie: owner,
      json: { name: "Growth", description: "Everything that grows" },
    });
    expect(await json(renamed)).toMatchObject({ team: { name: "Growth", slug: team.slug } });
    expect((await t.api(`/api/teams/${team.slug}`, { method: "DELETE", bearer: token })).status).toBe(403);
    expect((await t.api(`/api/teams/${team.slug}`, { method: "DELETE", cookie: member.cookie })).status).toBe(
      403,
    );
    expect((await t.api(`/api/teams/${team.slug}`, { method: "DELETE", cookie: owner })).status).toBe(200);
    expect((await t.api(`/api/teams/${team.slug}`, { cookie: owner })).status).toBe(404);
  });

  test("a slug that's taken after a rename answers conflict", async () => {
    const first = await makeTeam("Rename one");
    const second = await makeTeam("Rename two");
    const clash = await t.api(`/api/teams/${second.slug}`, {
      method: "PATCH",
      cookie: owner,
      json: { slug: first.slug },
    });
    expect(clash.status).toBe(409);
  });

  test("a name with no latin letters still gets a slug", async () => {
    const response = await t.api("/api/teams", { method: "POST", cookie: owner, json: { name: "デザイン" } });
    expect((await json<{ team: { slug: string } }>(response)).team.slug).toMatch(/^team-/);
  });

  test("members read teams; reviewers and outside people don't, and don't learn which exist", async () => {
    await makeTeam("Readers");
    expect((await t.api("/api/teams", { cookie: member.cookie })).status).toBe(200);
    expect((await t.api("/api/teams", { bearer: member.token })).status).toBe(200);
    for (const who of [reviewer, outside]) {
      expect((await t.api("/api/teams", { cookie: who.cookie })).status).toBe(403);
      expect((await t.api("/api/teams/readers", { cookie: who.cookie })).status).toBe(403);
      expect((await addMember("readers", member, "member", who.cookie)).status).toBe(404);
    }
    expect((await t.api("/api/teams")).status).toBe(401);
  });

  test("leads run their own team, in a browser, and no other", async () => {
    const team = await makeTeam("Led");
    const other = await makeTeam("Not led");
    expect((await addMember(team.slug, member, "member", member.cookie)).status).toBe(403);
    expect((await addMember(team.slug, lead, "lead")).status).toBe(200);
    expect((await addMember(team.slug, member, "member", lead.cookie)).status).toBe(200);
    expect((await addMember(other.slug, member, "member", lead.cookie)).status).toBe(403);
    expect(
      (
        await t.api(`/api/teams/${team.slug}/members/${member.id}`, {
          method: "PUT",
          bearer: lead.token,
          json: { role: "member" },
        })
      ).status,
    ).toBe(403);
    expect((await addMember(team.slug, reviewer, "lead", lead.cookie)).status).toBe(400);
    expect((await addMember(team.slug, outside, "lead", lead.cookie)).status).toBe(400);
    expect((await addMember(team.slug, outside, "member", lead.cookie)).status).toBe(200);
    expect((await addMember("led", { id: "not-a-uuid" }, "member", lead.cookie)).status).toBe(404);

    const removed = await t.api(`/api/teams/${team.slug}/members/${outside.id}`, {
      method: "DELETE",
      cookie: lead.cookie,
    });
    expect(removed.status).toBe(200);
    expect(
      (
        await t.api(`/api/teams/${team.slug}/members/${outside.id}`, {
          method: "DELETE",
          cookie: lead.cookie,
        })
      ).status,
    ).toBe(404);
    const kinds = await t.server.db.select({ kind: activity.kind }).from(activity);
    expect(kinds.map((row) => row.kind)).toEqual(
      expect.arrayContaining(["team_created", "team_member_added", "team_member_removed"]),
    );
  });

  test("a token sees a team's work but not its people", async () => {
    const team = await makeTeam("Directory");
    await addMember(team.slug, member);
    const byToken = await json<{ members: unknown[]; team: { members: number } }>(
      await t.api(`/api/teams/${team.slug}`, { bearer: token }),
    );
    expect(byToken.members).toEqual([]);
    expect(byToken.team.members).toBe(1);
    const byBrowser = await json<{ members: { email: string }[] }>(
      await t.api(`/api/teams/${team.slug}`, { cookie: lead.cookie }),
    );
    expect(byBrowser.members.map((row) => row.email)).toEqual([member.email]);
  });

  test("a team's page lists only what the caller can see", async () => {
    const team = await makeTeam("Visible");
    await addMember(team.slug, member);
    const id = await publishPrivate("for-the-team");
    expect((await share(id, team.id, "comment")).status).toBe(200);
    const shared = async (cookie: string) =>
      (
        await json<{ shared: { slug: string; level: string }[] }>(
          await t.api(`/api/teams/${team.slug}`, { cookie }),
        )
      ).shared;
    expect(await shared(member.cookie)).toEqual([
      expect.objectContaining({ slug: "for-the-team", level: "comment" }),
    ]);
    expect(await shared(lead.cookie)).toEqual([]);
  });

  test("sharing with a team reaches its members, at that level", async () => {
    const team = await makeTeam("Sharing");
    await addMember(team.slug, member);
    await addMember(team.slug, reviewer);
    await addMember(team.slug, outside);
    const id = await publishPrivate("shared-out");
    expect((await t.api(`/api/artifacts/${id}`, { bearer: member.token })).status).toBe(404);
    expect((await share(id, team.id, "view")).status).toBe(200);
    expect(await t.api(`/api/artifacts/${id}`, { bearer: member.token }).then(json)).toMatchObject({
      permissions: { comment: false },
    });
    expect((await share(id, team.id, "publish")).status).toBe(200);
    expect(await t.api(`/api/artifacts/${id}`, { cookie: member.cookie }).then(json)).toMatchObject({
      permissions: { comment: true, decide: true, manage: false },
    });
    expect((await publish(t, member.token, { slug: "shared-out", visibility: "me" })).status).toBe(200);
    // The cap holds at the route too: both can read and comment, and neither can publish.
    for (const who of [reviewer, outside]) {
      expect(await t.api(`/api/artifacts/${id}`, { bearer: who.token }).then(json)).toMatchObject({
        permissions: { comment: true, manage: false },
      });
      expect((await publish(t, who.token, { slug: "shared-out", visibility: "me" })).status).not.toBe(200);
    }
    expect(
      (await t.api(`/api/artifacts/${id}/teams/${team.id}`, { method: "DELETE", cookie: owner })).status,
    ).toBe(200);
    expect(
      (await t.api(`/api/artifacts/${id}/teams/${team.id}`, { method: "DELETE", cookie: owner })).status,
    ).toBe(404);
    expect((await t.api(`/api/artifacts/${id}`, { bearer: member.token })).status).toBe(404);
  });

  test("a direct view row beats a team's comment", async () => {
    const team = await makeTeam("Lowered");
    await addMember(team.slug, member);
    const id = await publishPrivate("lowered");
    await share(id, team.id, "comment");
    await t.api(`/api/artifacts/${id}/access`, {
      method: "POST",
      cookie: owner,
      json: { email: member.email, permission: "view" },
    });
    expect(await t.api(`/api/artifacts/${id}`, { cookie: member.cookie }).then(json)).toMatchObject({
      permissions: { comment: false },
    });
  });

  test("a token shares up to comment, marked for a person to confirm", async () => {
    const team = await makeTeam("Via token");
    await addMember(team.slug, member);
    const id = await publishPrivate("via-token");
    expect((await share(id, team.id, "publish", { bearer: token })).status).toBe(403);
    expect((await share(id, team.id, "comment", { bearer: token })).status).toBe(200);

    const row = () =>
      t.server.db.select().from(artifactTeamAccess).where(eq(artifactTeamAccess.artifactId, id));
    expect((await row())[0]?.viaToken).toBe(true);
    const before = await json(await t.api(`/api/artifacts/${id}`, { cookie: member.cookie }));
    expect(before).toMatchObject({ permissions: { comment: true, decide: false } });

    const thread = await json<{ id: string }>(
      await t.api(`/api/artifacts/${id}/threads`, {
        method: "POST",
        cookie: member.cookie,
        json: { pageKey: "plan", anchor: null, body: "Hello", version: 1 },
      }),
    );
    expect(
      (await t.api(`/api/threads/${thread.id}/resolve`, { method: "POST", cookie: member.cookie })).status,
    ).toBe(403);
    expect(
      (
        await t.api(`/api/artifacts/${id}/decisions`, {
          method: "POST",
          cookie: member.cookie,
          json: { version: 1, kind: "approved" },
        })
      ).status,
    ).toBe(403);

    // A person granting it again is the confirmation, and a token repeating it can't undo that.
    expect((await share(id, team.id, "comment")).status).toBe(200);
    expect((await row())[0]?.viaToken).toBe(false);
    expect((await share(id, team.id, "comment", { bearer: token })).status).toBe(200);
    expect((await row())[0]?.viaToken).toBe(false);
    expect(await t.api(`/api/artifacts/${id}`, { cookie: member.cookie }).then(json)).toMatchObject({
      permissions: { decide: true },
    });

    // Changing it is a new grant, and so unconfirmed again.
    expect((await share(id, team.id, "view", { bearer: token })).status).toBe(200);
    expect((await row())[0]?.viaToken).toBe(true);
  });

  test("a token-made team row tied with a person's lets a person decide", async () => {
    const byPerson = await makeTeam("Tie person");
    const byAgent = await makeTeam("Tie agent");
    await addMember(byPerson.slug, member);
    await addMember(byAgent.slug, member);
    const id = await publishPrivate("tied");
    await share(id, byAgent.id, "comment", { bearer: token });
    await share(id, byPerson.id, "comment");
    expect(await t.api(`/api/artifacts/${id}`, { cookie: member.cookie }).then(json)).toMatchObject({
      permissions: { decide: true },
    });
  });

  test("only someone who may share can share with a team", async () => {
    const team = await makeTeam("Not yours");
    await addMember(team.slug, member);
    const id = await publishPrivate("not-theirs");
    expect((await share(id, team.id, "comment", { cookie: member.cookie })).status).toBe(404);
    expect((await share(id, "00000000-0000-7000-8000-000000000000", "comment")).status).toBe(404);
    await t.api(`/api/artifacts/${id}/archive`, { method: "POST", cookie: owner });
    expect(await code(await share(id, team.id, "comment"))).toBe("read_only");
  });

  test("the access list says where each person's access came from", async () => {
    const team = await makeTeam("Sources");
    await addMember(team.slug, lead, "lead");
    await addMember(team.slug, reviewer);
    const id = await publishPrivate("sources");
    await share(id, team.id, "publish");
    await t.api(`/api/artifacts/${id}/access`, {
      method: "POST",
      cookie: owner,
      json: { email: member.email, permission: "view" },
    });
    const body = await json<{
      people: { id: string; permission: string }[];
      teams: { id: string; members: number; permission: string; viaToken: boolean }[];
      inherited: {
        id: string;
        level: string;
        via: string;
        capped: boolean;
        sources: { name: string }[];
      }[];
    }>(await t.api(`/api/artifacts/${id}/access`, { cookie: owner }));
    expect(body.teams).toEqual([
      expect.objectContaining({ id: team.id, members: 2, permission: "publish", viaToken: false }),
    ]);
    const row = (who: string) => body.inherited.find((entry) => entry.id === who);
    expect(row(lead.id)).toMatchObject({ level: "publish", capped: false, sources: [{ name: "Sources" }] });
    expect(row(reviewer.id)).toMatchObject({
      level: "comment",
      capped: true,
      sources: [{ name: "Sources" }],
    });
    expect(row(member.id)).toBeUndefined();
    const [me] = await t.server.db.select().from(people).where(eq(people.email, OWNER.email));
    expect(row(me?.id as string)).toMatchObject({ level: "manage", via: "publisher" });
  });

  test("a stored token can't invite anyone into a team, and a person can", async () => {
    const team = await makeTeam("Joining");
    const asToken = await t.api("/api/invites", {
      method: "POST",
      bearer: token,
      json: { email: "tok@example.com", role: "member", teamIds: [team.id] },
    });
    expect(asToken.status).toBe(403);
    const bad = await t.api("/api/invites", {
      method: "POST",
      cookie: owner,
      json: { email: "bad@example.com", role: "member", teamIds: ["00000000-0000-7000-8000-000000000000"] },
    });
    expect(bad.status).toBe(400);

    const gone = await makeTeam("Gone by then");
    const made = await json<{ url: string; invite: { id: string } }>(
      await t.api("/api/invites", {
        method: "POST",
        cookie: owner,
        json: { email: "joiner@example.com", role: "member", teamIds: [team.id, gone.id] },
      }),
    );
    // A token rotating the link would get the same way in.
    expect(
      (await t.api(`/api/invites/${made.invite.id}/link`, { method: "POST", bearer: token })).status,
    ).toBe(403);
    const secret = made.url.split("/join/")[1] as string;
    expect(await t.api(`/api/invites/${secret}`).then(json)).toMatchObject({
      teams: expect.arrayContaining(["Joining", "Gone by then"]),
    });
    expect((await t.api(`/api/teams/${gone.slug}`, { method: "DELETE", cookie: owner })).status).toBe(200);
    const accepted = await t.api(`/api/invites/${secret}/accept`, {
      method: "POST",
      json: { name: "Joiner", password: PASSWORD },
    });
    expect(accepted.status).toBe(200);
    const { person } = await json<{ person: { id: string } }>(accepted);
    const rows = await t.server.db.select().from(teamMembers).where(eq(teamMembers.personId, person.id));
    expect(rows.map((row) => row.teamId)).toEqual([team.id]);
  });

  test("removing a person takes them off their teams", async () => {
    const team = await makeTeam("Leaving");
    const leaver = await makeAccount(t, orgId, "member");
    await addMember(team.slug, leaver);
    expect((await t.api(`/api/people/${leaver.id}`, { method: "DELETE", cookie: owner })).status).toBe(200);
    expect(await t.server.db.select().from(teamMembers).where(eq(teamMembers.personId, leaver.id))).toEqual(
      [],
    );
  });

  test("deleting a team removes its access", async () => {
    const team = await makeTeam("Short lived");
    await addMember(team.slug, member);
    const id = await publishPrivate("short-lived");
    await share(id, team.id, "comment");
    expect((await t.api(`/api/artifacts/${id}`, { bearer: member.token })).status).toBe(200);
    expect((await t.api(`/api/teams/${team.slug}`, { method: "DELETE", cookie: owner })).status).toBe(200);
    expect((await t.api(`/api/artifacts/${id}`, { bearer: member.token })).status).toBe(404);
    expect(await t.server.db.select().from(teams).where(eq(teams.id, team.id))).toEqual([]);
  });

  test("the people list shows each person's teams", async () => {
    const team = await makeTeam("Listed");
    await addMember(team.slug, lead, "lead");
    const body = await json<{
      people: { id: string; teams: { slug: string; name: string; role: string }[] }[];
    }>(await t.api("/api/people", { cookie: owner }));
    expect(body.people.find((row) => row.id === lead.id)?.teams).toContainEqual({
      slug: team.slug,
      name: "Listed",
      role: "lead",
    });
  });

  test("purging an artifact shared with a team works", async () => {
    const team = await makeTeam("Purged");
    const id = await publishPrivate("purged");
    await share(id, team.id, "comment");
    await t.api(`/api/artifacts/${id}/delete`, { method: "POST", cookie: owner });
    expect((await t.api(`/api/artifacts/${id}`, { method: "DELETE", cookie: owner })).status).toBe(200);
    expect(
      await t.server.db.select().from(artifactTeamAccess).where(eq(artifactTeamAccess.artifactId, id)),
    ).toEqual([]);
  });
});

describe("people search", () => {
  let t: TestServer;
  let owner: string;
  let orgId: string;

  beforeAll(async () => {
    t = await startTestServer();
    await claim(t);
    owner = await signIn(t, OWNER.email, OWNER.password);
    const [row] = await t.server.db.select().from(people).limit(1);
    orgId = row?.orgId as string;
  });
  afterAll(() => t.stop());

  test("members and up, in a browser, find names and emails", async () => {
    const member = await makeAccount(t, orgId, "member");
    const reviewer = await makeAccount(t, orgId, "reviewer");
    const outside = await makeAccount(t, orgId, "outside");
    const search = (q: string, auth: object) => t.api(`/api/people/search?q=${encodeURIComponent(q)}`, auth);

    const found = await json<{ people: { email: string }[] }>(
      await search("zahin", { cookie: member.cookie }),
    );
    expect(found.people.map((row) => row.email)).toEqual([OWNER.email]);
    const byEmail = await json<{ people: { name: string; role: string }[] }>(
      await search(outside.email.split("@")[0] as string, { cookie: owner }),
    );
    // Outside people are in the directory: a lead has to be able to add one to a team.
    expect(byEmail.people.map((row) => row.role)).toContain("outside");
    expect(Object.keys(byEmail.people[0] as object).sort()).toEqual(["email", "id", "name", "role"]);

    expect((await search("zahin", { cookie: reviewer.cookie })).status).toBe(403);
    expect((await search("zahin", { cookie: outside.cookie })).status).toBe(403);
    expect((await search("zahin", { bearer: member.token })).status).toBe(403);
    expect((await search("zahin", {})).status).toBe(401);
  });

  test("short queries find nothing, and wildcards are plain text", async () => {
    const member = await makeAccount(t, orgId, "member");
    const body = (q: string) =>
      t.api(`/api/people/search?q=${encodeURIComponent(q)}`, { cookie: member.cookie }).then(json);
    expect(await body("z")).toEqual({ people: [] });
    expect(await body("%%")).toEqual({ people: [] });
    expect(await body("__")).toEqual({ people: [] });
  });

  test("someone removed doesn't turn up", async () => {
    const leaver = await makeAccount(t, orgId, "member");
    await t.api(`/api/people/${leaver.id}`, { method: "DELETE", cookie: owner });
    const body = await json<{ people: unknown[] }>(
      await t.api(`/api/people/search?q=${leaver.email}`, { cookie: owner }),
    );
    expect(body.people).toEqual([]);
  });

  test("it has a rate limit", async () => {
    const member = await makeAccount(t, orgId, "member");
    const hit = () => t.api("/api/people/search?q=zahin", { cookie: member.cookie });
    for (let i = 0; i < 60; i++) await hit();
    expect((await hit()).status).toBe(429);
  });
});
