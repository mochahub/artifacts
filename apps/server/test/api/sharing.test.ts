import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { artifacts, people } from "../../src/db/schema.ts";
import { claim, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { makePerson, publish } from "../publish-helper.ts";

const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
const cookieOf = (response: Response) => (response.headers.getSetCookie()[0] ?? "").split(";")[0] as string;

describe("sharing", () => {
  let t: TestServer;
  let token: string;
  let owner: string;
  let id: string;
  let orgId: string;

  const access = (json: unknown, bearer = token) =>
    t.api(`/api/artifacts/${id}/access`, { method: "POST", bearer, json });
  const link = async (permission: "view" | "comment", expiresIn?: "1d" | "7d" | "30d") => {
    const response = await t.api(`/api/artifacts/${id}/links`, {
      method: "POST",
      bearer: token,
      json: { permission, expiresIn },
    });
    return (await response.json()) as { url: string; link: { id: string } };
  };
  const secretOf = (url: string) => url.split("/s/")[1] as string;
  const guestOn = async (url: string, name = "Riley", cookie?: string) => {
    const response = await t.api(`/api/s/${secretOf(url)}/guest`, { method: "POST", json: { name }, cookie });
    expect(response.status).toBe(200);
    return cookieOf(response);
  };

  beforeAll(async () => {
    t = await startTestServer();
    const made = await claim(t);
    token = made.token;
    owner = await signIn(t, OWNER.email, OWNER.password);
    await publish(t, token, { visibility: "me" });
    const [row] = await t.server.db.select().from(artifacts);
    id = row?.id as string;
    orgId = row?.orgId as string;
  });
  afterAll(() => t.stop());

  test("visibility: a member can't see a private artifact until it's org-wide", async () => {
    const member = await makePerson(t, orgId, "member");
    expect((await t.api(`/api/artifacts/${id}`, { bearer: member })).status).toBe(404);
    expect(
      (await t.api(`/api/artifacts/${id}`, { method: "PATCH", bearer: member, json: { visibility: "org" } }))
        .status,
    ).toBe(404);
    expect(
      (await t.api(`/api/artifacts/${id}`, { method: "PATCH", bearer: token, json: { visibility: "org" } }))
        .status,
    ).toBe(200);
    expect((await t.api(`/api/artifacts/${id}`, { bearer: member })).status).toBe(200);
    expect(
      (await t.api(`/api/artifacts/${id}`, { method: "PATCH", bearer: member, json: { visibility: "me" } }))
        .status,
    ).toBe(403);
    await t.api(`/api/artifacts/${id}`, { method: "PATCH", bearer: token, json: { visibility: "me" } });
    expect((await t.api(`/api/artifacts/${id}`, { bearer: member })).status).toBe(404);
  });

  test("adding a member gives access at once, and removing takes it away", async () => {
    await makePerson(t, orgId, "member");
    const person = (await t.server.db.select().from(people)).at(-1);
    const added = await access({ email: person?.email, permission: "comment" });
    expect(added.status).toBe(200);
    const list = (await (await t.api(`/api/artifacts/${id}/access`, { bearer: token })).json()) as {
      people: { id: string }[];
    };
    expect(list.people.map((p) => p.id)).toContain(person?.id as string);
    expect(
      (await t.api(`/api/artifacts/${id}/access/${person?.id}`, { method: "DELETE", bearer: token })).status,
    ).toBe(200);
    expect(
      (await t.api(`/api/artifacts/${id}/access/${person?.id}`, { method: "DELETE", bearer: token })).status,
    ).toBe(404);
  });

  test("publish goes only to members, and lets them publish", async () => {
    const member = await makePerson(t, orgId, "member");
    const person = (await t.server.db.select().from(people)).at(-1);
    expect(await code(await access({ email: "stranger@example.com", permission: "publish" }))).toBe(
      "invalid",
    );
    expect((await publish(t, member)).status).toBe(409);
    expect((await access({ email: person?.email, permission: "publish" })).status).toBe(200);
    expect((await publish(t, member)).status).toBe(200);
    const reviewer = await makePerson(t, orgId, "reviewer");
    expect(reviewer).toBeTruthy();
    const them = (await t.server.db.select().from(people)).at(-1);
    expect(await code(await access({ email: them?.email, permission: "publish" }))).toBe("invalid");
  });

  test("only the publisher or an admin shares", async () => {
    const member = await makePerson(t, orgId, "member");
    const person = (await t.server.db.select().from(people)).at(-1);
    await access({ email: person?.email, permission: "comment" });
    expect((await access({ email: "x@example.com", permission: "view" }, member)).status).toBe(403);
    expect(
      (
        await t.api(`/api/artifacts/${id}/links`, {
          method: "POST",
          bearer: member,
          json: { permission: "view" },
        })
      ).status,
    ).toBe(403);
    expect((await t.api(`/api/artifacts/${id}/access`, { bearer: member })).status).toBe(403);
  });

  test("an outside person joins by invite and sees only what's shared", async () => {
    const { url } = (await (await access({ email: "out@example.com", permission: "comment" })).json()) as {
      url: string;
    };
    const secret = url.split("/join/")[1];
    expect(await (await t.api(`/api/invites/${secret}`)).json()).toMatchObject({
      role: "outside",
      artifact: { title: "Roadmap" },
    });
    const accepted = await t.api(`/api/invites/${secret}/accept`, {
      method: "POST",
      json: { name: "Out", password: "a perfectly long password" },
    });
    const cookie = cookieOf(accepted);
    expect((await t.api(`/api/artifacts/${id}`, { cookie })).status).toBe(200);
    await publish(t, token, { slug: "other" });
    const [other] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "other"));
    expect((await t.api(`/api/artifacts/${other?.id}`, { cookie })).status).toBe(404);
    const made = await t.api(`/api/artifacts/${id}/threads`, {
      method: "POST",
      cookie,
      json: { pageKey: "plan", anchor: null, body: "Hi", version: 1 },
    });
    expect(made.status).toBe(200);
    expect((await t.api("/api/people?kind=outside", { bearer: token })).status).toBe(200);
    const list = (await (await t.api("/api/people?kind=outside", { bearer: token })).json()) as {
      people: { shares: unknown[] }[];
    };
    expect(list.people[0]?.shares).toHaveLength(1);
    const shares = (await (await t.api("/api/shares", { cookie: owner })).json()) as {
      people: { email: string }[];
    };
    expect(shares.people.map((p) => p.email)).toContain("out@example.com");
  });

  test("a guest on a comment link: preview, name, read, comment", async () => {
    const { url } = await link("comment");
    const preview = (await (await t.api(`/api/s/${secretOf(url)}`)).json()) as Record<string, unknown>;
    expect(preview).toMatchObject({
      permission: "comment",
      needsName: true,
      sharedBy: "Zahin",
      artifact: { title: "Roadmap" },
    });
    expect((await t.api(`/api/s/${secretOf(url)}/cover`, { redirect: "manual" })).status).toBe(302);
    const cookie = await guestOn(url);
    expect(cookie).toContain("art_guest=");
    expect(
      ((await (await t.api(`/api/s/${secretOf(url)}`, { cookie })).json()) as { needsName: boolean })
        .needsName,
    ).toBe(false);
    expect((await t.api(`/api/artifacts/${id}`, { cookie })).status).toBe(200);
    expect((await t.api("/api/home", { cookie })).status).toBe(403);
    expect((await t.api("/api/me", { cookie })).status).toBe(403);

    const made = await t.api(`/api/artifacts/${id}/threads`, {
      method: "POST",
      cookie,
      json: { pageKey: "plan", anchor: null, body: "From a guest", version: 1 },
    });
    expect(made.status).toBe(200);
    const thread = (await made.json()) as { id: string; author: unknown };
    expect(thread.author).toEqual({ name: "Riley", kind: "guest" });
    expect((await t.api(`/api/threads/${thread.id}/resolve`, { method: "POST", cookie })).status).toBe(403);
    const decide = await t.api(`/api/artifacts/${id}/decisions`, {
      method: "POST",
      cookie,
      json: { version: 1, kind: "approved" },
    });
    expect(decide.status).toBe(403);
  });

  test("a view-only guest can read but not comment", async () => {
    const { url } = await link("view");
    const cookie = await guestOn(url, "Viewer");
    expect((await t.api(`/api/artifacts/${id}/threads`, { cookie })).status).toBe(200);
    const made = await t.api(`/api/artifacts/${id}/threads`, {
      method: "POST",
      cookie,
      json: { pageKey: "plan", anchor: null, body: "x", version: 1 },
    });
    expect(made.status).toBe(403);
  });

  test("revoking a link cuts guests off at once", async () => {
    const { url, link: created } = await link("comment");
    const cookie = await guestOn(url);
    expect((await t.api(`/api/artifacts/${id}`, { cookie })).status).toBe(200);
    expect(
      (await t.api(`/api/artifacts/${id}/links/${created.id}`, { method: "DELETE", bearer: token })).status,
    ).toBe(200);
    expect((await t.api(`/api/artifacts/${id}`, { cookie })).status).toBe(404);
    expect((await t.api(`/api/s/${secretOf(url)}`)).status).toBe(410);
  });

  test("an expiring link stops on time, and a guest is never past it", async () => {
    const { url } = await link("view", "1d");
    const cookie = await guestOn(url);
    t.clock.advance(23 * 3600_000);
    expect((await t.api(`/api/artifacts/${id}`, { cookie })).status).toBe(200);
    t.clock.advance(2 * 3600_000);
    expect((await t.api(`/api/artifacts/${id}`, { cookie })).status).toBe(404);
    expect(
      (await t.api(`/api/s/${secretOf(url)}/guest`, { method: "POST", json: { name: "x" } })).status,
    ).toBe(410);
    owner = await signIn(t, OWNER.email, OWNER.password);
  });

  test("a guest's rights stop at their artifact", async () => {
    const { url } = await link("comment");
    const cookie = await guestOn(url);
    const [other] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "other"));
    expect((await t.api(`/api/artifacts/${other?.id}`, { cookie })).status).toBe(404);
  });

  test("an admin can turn link sharing off", async () => {
    await t.api("/api/org", { method: "PATCH", cookie: owner, json: { settings: { linkSharing: false } } });
    const refused = await t.api(`/api/artifacts/${id}/links`, {
      method: "POST",
      bearer: token,
      json: { permission: "view" },
    });
    expect(refused.status).toBe(403);
    await t.api("/api/org", { method: "PATCH", cookie: owner, json: { settings: { linkSharing: true } } });
    const { url } = await link("view");
    const cookie = await guestOn(url);
    await t.api("/api/org", { method: "PATCH", cookie: owner, json: { settings: { linkSharing: false } } });
    expect((await t.api(`/api/artifacts/${id}`, { cookie })).status).toBe(404);
    expect((await t.api(`/api/s/${secretOf(url)}`)).status).toBe(410);
    await t.api("/api/org", { method: "PATCH", cookie: owner, json: { settings: { linkSharing: true } } });
    expect((await t.api(`/api/artifacts/${id}`, { cookie })).status).toBe(200);
  });

  test("archived: sharing is read-only", async () => {
    await t.server.db.update(artifacts).set({ archivedAt: t.clock.now() }).where(eq(artifacts.id, id));
    expect(await code(await access({ email: "x@example.com", permission: "view" }))).toBe("read_only");
    expect(
      await code(
        await t.api(`/api/artifacts/${id}/links`, {
          method: "POST",
          bearer: token,
          json: { permission: "view" },
        }),
      ),
    ).toBe("read_only");
    await t.server.db.update(artifacts).set({ archivedAt: null }).where(eq(artifacts.id, id));
  });

  test("the guest name limit, and 20 guests per IP per hour", async () => {
    const { url } = await link("view");
    expect(
      (await t.api(`/api/s/${secretOf(url)}/guest`, { method: "POST", json: { name: "x".repeat(61) } }))
        .status,
    ).toBe(400);
    t.clock.advance(3601_000);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push(
        (await t.api(`/api/s/${secretOf(url)}/guest`, { method: "POST", json: { name: "x" } })).status,
      );
    }
    expect(statuses.at(-1)).toBe(429);
  });

  test("the content host cuts a guest off when the link is revoked", async () => {
    t.clock.advance(3601_000);
    const { url, link: created } = await link("comment");
    const cookie = await guestOn(url);
    const base = (
      (await (
        await t.api(`/api/artifacts/${id}/content-token`, { method: "POST", cookie, json: { version: 1 } })
      ).json()) as { base: string }
    ).base;
    const get = () =>
      fetch(`http://127.0.0.1:${t.server.ports.content}${new URL(base).pathname}index.html`, {
        headers: { Host: "content.test", "Sec-Fetch-Dest": "iframe" },
      });
    expect((await get()).status).toBe(200);
    await t.api(`/api/artifacts/${id}/links/${created.id}`, { method: "DELETE", bearer: token });
    t.clock.advance(5001);
    expect((await get()).status).toBe(404);
  });
});

describe("well-known webauthn", () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer();
    await claim(t);
  });
  afterAll(() => t.stop());

  test("the home domain lists other viewer origins, never the content host", async () => {
    const response = await t.api("/.well-known/webauthn");
    expect(await response.json()).toEqual({ origins: ["https://art.example.org"] });
    const other = await t.api("/.well-known/webauthn", { headers: { Host: "art.example.org" } });
    expect(other.status).toBe(404);
  });
});
