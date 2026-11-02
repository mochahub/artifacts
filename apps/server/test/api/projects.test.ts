import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import { LibraryPage } from "@artifacts/schema";
import { eq } from "drizzle-orm";
import { sha256 } from "../../src/auth/secrets.ts";
import { findOrg } from "../../src/db/index.ts";
import {
  activity,
  artifacts,
  org,
  projectAccess,
  projects,
  pushSubscriptions,
  sessions,
  tokens,
} from "../../src/db/schema.ts";
import { sendDigest } from "../../src/push/notify.ts";
import { claim, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { makeAccount, publish } from "../publish-helper.ts";

type Account = Awaited<ReturnType<typeof makeAccount>>;
const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;
const error = async (response: Response) =>
  (await json<{ error: { code: string; message: string } }>(response)).error;
const PASSWORD = "a perfectly long password";

describe("project access", () => {
  let t: TestServer;
  let token: string;
  let ownerId: string;
  let owner: string;
  let orgId: string;
  let member: Account;
  let other: Account;
  let reviewer: Account;
  let outside: Account;
  let n = 0;

  const unique = (base: string) => {
    n += 1;
    return `${base}-${n}`;
  };
  const put = async (bearer: string, project: string, slug: string, options: object = {}) => {
    const response = await publish(t, bearer, { project, slug, ...options });
    expect(response.status).toBe(200);
    const found = await t.api(`/api/artifacts/by-slug/${project}/${slug}`, { bearer });
    return (await json<{ id: string }>(found)).id;
  };
  const grant = (project: string, subject: string, permission: string, cookie = owner) =>
    t.api(`/api/projects/${project}/access/${subject}`, { method: "PUT", cookie, json: { permission } });
  const restrict = (project: string, cookie = owner, more: object = {}) =>
    t.api(`/api/projects/${project}/access`, {
      method: "PATCH",
      cookie,
      json: { restricted: true, ...more },
    });
  const makeTeam = async (name: string) =>
    (
      await json<{ team: { id: string; slug: string } }>(
        await t.api("/api/teams", { method: "POST", cookie: owner, json: { name } }),
      )
    ).team;
  const addTo = (slug: string, who: { id: string }) =>
    t.api(`/api/teams/${slug}/members/${who.id}`, { method: "PUT", cookie: owner, json: {} });
  const orgToken = async (values: { scopes?: string[]; projectIds?: string[] | null } = {}) => {
    const secret = `art_org${Bun.randomUUIDv7()}`;
    const id = Bun.randomUUIDv7();
    await t.server.db.insert(tokens).values({
      id,
      orgId,
      kind: "org",
      name: "ci",
      tokenHash: sha256(secret),
      scopes: values.scopes ?? ["read", "publish", "org"],
      projectIds: values.projectIds ?? null,
      createdBy: ownerId,
    });
    return { secret, id };
  };

  beforeAll(async () => {
    t = await startTestServer();
    const made = await claim(t);
    token = made.token;
    ownerId = made.person.id;
    owner = await signIn(t, OWNER.email, OWNER.password);
    orgId = ((await findOrg(t.server.db)) as { id: string }).id;
    member = await makeAccount(t, orgId, "member");
    other = await makeAccount(t, orgId, "member");
    reviewer = await makeAccount(t, orgId, "reviewer");
    outside = await makeAccount(t, orgId, "outside");
  });
  afterAll(() => t.stop());

  test("whoever makes a project manages it; a token's has no person, and is the token's to reach", async () => {
    const slug = unique("made");
    await put(member.token, slug, "first");
    const rows = await t.server.db.select().from(projects).where(eq(projects.slug, slug));
    expect(rows[0]).toMatchObject({ restricted: false, createdBy: member.id, createdByToken: null });
    const held = await t.server.db
      .select()
      .from(projectAccess)
      .where(eq(projectAccess.projectId, rows[0]?.id as string));
    expect(held).toEqual([expect.objectContaining({ personId: member.id, permission: "manage" })]);

    const ci = await orgToken();
    const byToken = unique("ci-made");
    await put(ci.secret, byToken, "first");
    const [row] = await t.server.db.select().from(projects).where(eq(projects.slug, byToken));
    expect(row).toMatchObject({ createdBy: null, createdByToken: ci.id });
    expect(
      await t.server.db
        .select()
        .from(projectAccess)
        .where(eq(projectAccess.projectId, row?.id as string)),
    ).toEqual([]);
  });

  test("an old project keeps working: no creator, no rows, and admins manage it", async () => {
    const slug = unique("old");
    await put(token, slug, "first");
    await t.server.db.delete(projectAccess);
    await t.server.db.update(projects).set({ createdBy: null }).where(eq(projects.slug, slug));
    expect((await publish(t, member.token, { project: slug, slug: "second" })).status).toBe(200);
    expect((await t.api(`/api/projects/${slug}/access`, { cookie: owner })).status).toBe(200);
    expect((await t.api(`/api/projects/${slug}/access`, { cookie: member.cookie })).status).toBe(403);
  });

  test("defaultProjectAccess: stored settings without it parse, and saving another setting keeps it", async () => {
    const [row] = await t.server.db.select().from(org);
    const { defaultProjectAccess: _, ...stored } = (row as { settings: Record<string, unknown> }).settings;
    await t.server.db.update(org).set({ settings: stored });
    expect((await findOrg(t.server.db))?.settings.defaultProjectAccess).toBe("org");
    const set = (settings: object) =>
      t.api("/api/org", { method: "PATCH", cookie: owner, json: { settings } });
    expect((await set({ defaultVisibility: "org" })).status).toBe(200);

    expect((await set({ defaultProjectAccess: "restricted" })).status).toBe(200);
    const saved = await json<{ settings: { defaultProjectAccess: string } }>(
      await t.api("/api/org", { method: "PATCH", cookie: owner, json: { name: "Mochahub" } }),
    );
    expect(saved.settings.defaultProjectAccess).toBe("restricted");
    expect((await set({ linkSharing: true })).status).toBe(200);
    expect((await findOrg(t.server.db))?.settings.defaultProjectAccess).toBe("restricted");

    const slug = unique("starts-restricted");
    await put(member.token, slug, "first");
    const [made] = await t.server.db.select().from(projects).where(eq(projects.slug, slug));
    expect(made?.restricted).toBe(true);
    expect((await publish(t, other.token, { project: slug, slug: "mine" })).status).toBe(409);

    // A token that made one can come back, or CI would fail on its second run.
    const ci = await orgToken();
    const byToken = unique("ci-restricted");
    expect((await publish(t, ci.secret, { project: byToken, slug: "one" })).status).toBe(200);
    expect((await publish(t, ci.secret, { project: byToken, slug: "one", title: "Again" })).status).toBe(200);
    expect((await publish(t, ci.secret, { project: byToken, slug: "two" })).status).toBe(200);
    await set({ defaultProjectAccess: "org" });
  });

  describe("a restricted project keeps its secret", () => {
    const WORD = "zanzibarquokka";
    let project: string;
    let id: string;
    let holder: Account;
    let viewer: Account;
    const look = async (auth: { bearer?: string; cookie?: string }) => {
      const search = await json<{
        artifacts: unknown[];
        pages: unknown[];
        comments: unknown[];
        content: unknown[];
      }>(await t.api(`/api/search?q=${WORD}`, auth));
      const library = LibraryPage.parse(await json(await t.api(`/api/library/search?q=${WORD}`, auth)));
      const lists = await json<{ slug: string }[]>(await t.api("/api/projects", auth));
      const libraryLists = await json<{ projects: { slug: string }[] }>(
        await t.api("/api/library/projects", auth),
      );
      const feed = await json<{ items: { artifact: { slug: string } | null }[] }>(
        await t.api("/api/activity", auth),
      );
      const home = await json<{ waiting: { id: string }[] }>(await t.api("/api/home", auth));
      return {
        search:
          search.artifacts.length + search.pages.length + search.comments.length + search.content.length,
        library: library.cards.length,
        projects: lists.some((row) => row.slug === project),
        libraryProjects: libraryLists.projects.some((row) => row.slug === project),
        activity: feed.items.some((item) => item.artifact?.slug === "secret-plan"),
        home: home.waiting.some((card) => card.id === id),
        page: (await t.api(`/api/artifacts/${id}`, auth)).status,
        bySlug: (await t.api(`/api/artifacts/by-slug/${project}/secret-plan`, auth)).status,
        projectPage: (await t.api(`/api/projects/${project}/artifacts`, auth)).status,
        read: (await t.api(`/api/library/projects/${project}/secret-plan/read`, auth)).status,
        bundle: (await t.api(`/api/library/projects/${project}/secret-plan/bundle`, auth)).status,
      };
    };
    const hidden = {
      search: 0,
      library: 0,
      projects: false,
      libraryProjects: false,
      activity: false,
      home: false,
      page: 404,
      bySlug: 404,
      projectPage: 404,
      read: 404,
      bundle: 404,
    };
    const seen = {
      projects: true,
      libraryProjects: true,
      page: 200,
      bySlug: 200,
      projectPage: 200,
      read: 200,
      bundle: 200,
    };

    beforeAll(async () => {
      project = unique("secret");
      id = await put(token, project, "secret-plan", {
        title: `Plan for ${WORD}`,
        summary: `All about ${WORD}.`,
        blocks: [{ key: "intro/p1", text: `The ${WORD} moves in spring.` }],
        visibility: "org",
      });
      await t.api(`/api/artifacts/${id}/threads`, {
        method: "POST",
        cookie: owner,
        json: { pageKey: "plan", anchor: null, body: `Is ${WORD} right?`, version: 1 },
      });
      holder = await makeAccount(t, orgId, "member");
      viewer = await makeAccount(t, orgId, "reviewer");
      expect((await restrict(project)).status).toBe(200);
      expect((await grant(project, `person:${holder.id}`, "view")).status).toBe(200);
      const team = await makeTeam(unique("Secret keepers"));
      await addTo(team.slug, viewer);
      expect((await grant(project, `team:${team.id}`, "comment")).status).toBe(200);
    });

    test("nothing reaches anyone outside it, by session or token", async () => {
      for (const who of [member, reviewer, outside]) {
        expect(await look({ cookie: who.cookie })).toEqual(hidden);
        expect(await look({ bearer: who.token })).toEqual(hidden);
      }
    });

    test("an organization token over all projects loses it", async () => {
      const broad = await orgToken();
      expect(await look({ bearer: broad.secret })).toEqual(hidden);
    });

    test("someone holding a grant, directly or through a team, sees it", async () => {
      for (const who of [holder, viewer]) {
        expect(await look({ cookie: who.cookie })).toMatchObject(seen);
      }
      const search = await json<{ content: unknown[] }>(
        await t.api(`/api/search?q=${WORD}`, { cookie: viewer.cookie }),
      );
      expect(search.content.length).toBeGreaterThan(0);
      expect(await t.api(`/api/artifacts/${id}`, { cookie: viewer.cookie }).then(json)).toMatchObject({
        permissions: { comment: true, decide: true, manage: false },
      });
      expect(await t.api(`/api/artifacts/${id}`, { cookie: holder.cookie }).then(json)).toMatchObject({
        permissions: { comment: false },
      });
    });

    test("an organization token that names it can reach it", async () => {
      const [row] = await t.server.db.select().from(projects).where(eq(projects.slug, project));
      const named = await orgToken({ projectIds: [row?.id as string] });
      expect(await look({ bearer: named.secret })).toMatchObject(seen);
    });

    test("MCP: no card, no tool, no list", async () => {
      const call = async (bearer: string, name: string, args: object) => {
        const response = await t.api("/api/mcp", {
          method: "POST",
          bearer,
          json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        });
        return JSON.stringify(await response.json());
      };
      expect(await call(member.token, "artifacts_search", { query: WORD })).not.toContain("secret-plan");
      expect(await call(member.token, "artifacts_list", {})).not.toContain(project);
      expect(await call(member.token, "artifacts_read", { artifact: `${project}/secret-plan` })).toContain(
        "Not found",
      );
      expect(await call(member.token, "artifacts_status", { artifact: `${project}/secret-plan` })).toContain(
        "Not found",
      );
      expect(await call(viewer.token, "artifacts_search", { query: WORD })).toContain("secret-plan");
    });

    test("publishing gives the same answer whether or not an artifact is in there", async () => {
      const taken = await error(await publish(t, member.token, { project, slug: "secret-plan" }));
      const free = await error(await publish(t, member.token, { project, slug: "nothing-here" }));
      expect(taken).toEqual({
        code: "conflict",
        message: "That project name is taken.",
        details: {},
      } as never);
      expect(free).toEqual(taken);
      // Publishing to an open project still names the problem as it always did.
      const open = unique("open-one");
      await put(token, open, "theirs", { visibility: "me" });
      expect((await error(await publish(t, member.token, { project: open, slug: "theirs" }))).message).toBe(
        "That slug is taken.",
      );
    });

    test("someone who can see it but not add to it is told so plainly", async () => {
      expect((await publish(t, holder.token, { project, slug: "from-holder" })).status).toBe(403);
    });

    test("a brand proposal doesn't name a sample in it", async () => {
      await t.api("/api/brand/proposals", {
        method: "POST",
        bearer: token,
        json: {
          project,
          slug: "secret-plan",
          brand: { name: "Hidden", theme: { accent: "#123456" }, fonts: [] },
        },
      });
      const list = await json<{ name: string; sample: unknown }[]>(
        await t.api("/api/brand/proposals", { bearer: member.token }),
      );
      expect(list.find((row) => row.name === "Hidden")).toMatchObject({ sample: null });
      const seenBy = await json<{ name: string; sample: unknown }[]>(
        await t.api("/api/brand/proposals", { bearer: viewer.token }),
      );
      expect(seenBy.find((row) => row.name === "Hidden")?.sample).toEqual({ project, slug: "secret-plan" });
    });

    test("a daily push doesn't count it for anyone outside", async () => {
      const received: Uint8Array[] = [];
      const service = Bun.serve({
        port: 0,
        async fetch(request) {
          received.push(new Uint8Array(await request.arrayBuffer()));
          return new Response(null, { status: 201 });
        },
      });
      const local = await startTestServer({}, { pushAllow: () => true });
      try {
        const claimed = await claim(local);
        const here = ((await findOrg(local.server.db)) as { id: string }).id;
        const device = async (personId: string) => {
          const [session] = await local.server.db
            .select()
            .from(sessions)
            .where(eq(sessions.personId, personId));
          const point = createECDH("prime256v1");
          await local.server.db.insert(pushSubscriptions).values({
            id: Bun.randomUUIDv7(),
            orgId: here,
            personId,
            sessionId: session?.id as string,
            endpoint: `http://127.0.0.1:${service.port}/${personId}`,
            keys: {
              p256dh: point.generateKeys().toString("base64url"),
              auth: randomBytes(16).toString("base64url"),
            },
          });
        };
        const outsider = await makeAccount(local, here, "member");
        const insider = await makeAccount(local, here, "member");
        await publish(local, claimed.token, { project: "hush", slug: "one" });
        const cookie = await signIn(local, OWNER.email, OWNER.password);
        await restrict2(local, cookie, insider.id);
        await device(outsider.id);
        await device(insider.id);
        await sendDigest(local.server.deps);
        expect(received).toHaveLength(1);
      } finally {
        await local.stop();
        await service.stop(true);
      }
    });
  });

  const restrict2 = async (server: TestServer, cookie: string, grantee: string) => {
    await server.api("/api/projects/hush/access", { method: "PATCH", cookie, json: { restricted: true } });
    await server.api(`/api/projects/hush/access/person:${grantee}`, {
      method: "PUT",
      cookie,
      json: { permission: "view" },
    });
  };

  test("project publish adds new artifacts, and can't touch anyone else's", async () => {
    const project = unique("publish-grant");
    const theirs = await put(token, project, "theirs");
    expect((await restrict(project)).status).toBe(200);
    expect((await grant(project, `person:${member.id}`, "publish")).status).toBe(200);
    expect((await publish(t, member.token, { project, slug: "mine" })).status).toBe(200);
    expect((await publish(t, member.token, { project, slug: "theirs" })).status).toBe(403);
    expect(await t.api(`/api/artifacts/${theirs}`, { cookie: member.cookie }).then(json)).toMatchObject({
      permissions: { comment: true, manage: false },
    });
  });

  test("project manage covers its org artifacts, in a browser, and never a private one", async () => {
    const project = unique("managed");
    const shared = await put(token, project, "shared", { visibility: "org" });
    const hidden = await put(token, project, "hidden", { visibility: "me" });
    expect((await grant(project, `person:${member.id}`, "manage")).status).toBe(200);
    const archive = (id: string, auth: object) =>
      t.api(`/api/artifacts/${id}/archive`, { method: "POST", ...auth });
    expect((await t.api(`/api/artifacts/${hidden}`, { cookie: member.cookie })).status).toBe(404);
    expect((await archive(shared, { bearer: member.token })).status).toBe(403);
    expect((await publish(t, member.token, { project, slug: "shared" })).status).toBe(403);
    expect((await archive(shared, { cookie: member.cookie })).status).toBe(200);
    await t.api(`/api/artifacts/${shared}/unarchive`, { method: "POST", cookie: member.cookie });
    // Publishing a new version needs a sign-in as a person, which a session doesn't use here.
    const body = await json(await t.api(`/api/artifacts/${shared}`, { cookie: member.cookie }));
    expect(body).toMatchObject({ permissions: { manage: true, share: true } });
  });

  test("a reviewer given manage can comment and no more", async () => {
    const project = unique("capped");
    const id = await put(token, project, "work");
    await restrict(project);
    expect((await grant(project, `person:${reviewer.id}`, "manage")).status).toBe(200);
    expect(await t.api(`/api/artifacts/${id}`, { cookie: reviewer.cookie }).then(json)).toMatchObject({
      permissions: { comment: true, manage: false, share: false, delete: false },
    });
    expect(
      (await t.api(`/api/artifacts/${id}/archive`, { method: "POST", cookie: reviewer.cookie })).status,
    ).toBe(403);
    expect((await t.api(`/api/projects/${project}/access`, { cookie: reviewer.cookie })).status).toBe(403);
    const access = await json<{ people: { id: string; capped: boolean }[] }>(
      await t.api(`/api/projects/${project}/access`, { cookie: owner }),
    );
    expect(access.people.find((row) => row.id === reviewer.id)?.capped).toBe(true);
  });

  test("an outside person can hold a project at comment, not above", async () => {
    const project = unique("outside");
    const id = await put(token, project, "work");
    expect((await grant(project, `person:${outside.id}`, "manage")).status).toBe(400);
    expect((await grant(project, `person:${outside.id}`, "comment")).status).toBe(200);
    expect(await t.api(`/api/artifacts/${id}`, { cookie: outside.cookie }).then(json)).toMatchObject({
      permissions: { comment: true },
    });
    const shares = await json<{ projects: { project: string }[] }>(
      await t.api("/api/shares", { cookie: owner }),
    );
    expect(shares.projects.map((row) => row.project)).toContain(project);
  });

  test("tokens can't touch project access, and people need manage", async () => {
    const project = unique("guarded");
    await put(member.token, project, "work");
    const path = `/api/projects/${project}/access`;
    // A token can read it if its person may, as `artifacts project access` does.
    expect((await t.api(path, { bearer: member.token })).status).toBe(200);
    for (const bearer of [member.token, token]) {
      expect((await t.api(path, { method: "PATCH", bearer, json: { restricted: true } })).status).toBe(403);
      expect(
        (await t.api(path, { method: "POST", bearer, json: { email: "x@example.com", permission: "view" } }))
          .status,
      ).toBe(403);
      expect(
        (await t.api(`${path}/person:${other.id}`, { method: "PUT", bearer, json: { permission: "view" } }))
          .status,
      ).toBe(403);
    }
    expect((await grant(project, `person:${other.id}`, "manage", other.cookie)).status).toBe(403);
    expect((await grant(project, `person:${other.id}`, "manage", member.cookie)).status).toBe(200);
    expect((await grant(project, "person:nope", "view", member.cookie)).status).toBe(404);
    expect((await grant(project, "robot:nope", "view", member.cookie)).status).toBe(404);
    expect(
      (await t.api(`${path}/person:${other.id}`, { method: "DELETE", cookie: member.cookie })).status,
    ).toBe(200);
    expect(
      (await t.api(`${path}/person:${other.id}`, { method: "DELETE", cookie: member.cookie })).status,
    ).toBe(404);
  });

  test("a hidden project answers 404 to a route that asks about it", async () => {
    const project = unique("hidden-access");
    await put(token, project, "work");
    await restrict(project);
    expect((await t.api(`/api/projects/${project}/access`, { cookie: member.cookie })).status).toBe(404);
    expect((await grant(project, `person:${member.id}`, "view", member.cookie)).status).toBe(404);
  });

  test("a grant shows a project before anything in it is visible", async () => {
    const project = unique("empty-for-now");
    await put(token, project, "private", { visibility: "me" });
    await restrict(project);
    expect((await t.api(`/api/projects/${project}/artifacts`, { cookie: member.cookie })).status).toBe(404);
    await grant(project, `person:${member.id}`, "publish");
    const page = await json<{ project: { restricted: boolean; canShare: boolean }; artifacts: unknown[] }>(
      await t.api(`/api/projects/${project}/artifacts`, { cookie: member.cookie }),
    );
    expect(page).toMatchObject({ artifacts: [], project: { restricted: true, canShare: false } });
    const list = await json<{ slug: string; artifactCount: number }[]>(
      await t.api("/api/projects", { cookie: member.cookie }),
    );
    expect(list.find((row) => row.slug === project)).toMatchObject({ artifactCount: 0 });
    const library = await json<{ projects: { slug: string }[] }>(
      await t.api("/api/library/projects", { bearer: member.token }),
    );
    expect(library.projects.map((row) => row.slug)).toContain(project);
  });

  test("the team filter narrows what's listed, and only for those who can read teams", async () => {
    const onProject = unique("team-project");
    const onArtifact = unique("team-artifact");
    const neither = unique("team-neither");
    await put(token, onProject, "a");
    const shared = await put(token, onArtifact, "b");
    await put(token, neither, "c");
    const team = await makeTeam(unique("Filter"));
    await grant(onProject, `team:${team.id}`, "view");
    await t.api(`/api/artifacts/${shared}/teams/${team.id}`, {
      method: "PUT",
      cookie: owner,
      json: { permission: "view" },
    });
    const slugs = async (cookie: string, query: string) =>
      (await json<{ slug: string }[]>(await t.api(`/api/projects?${query}`, { cookie }))).map(
        (row) => row.slug,
      );
    expect((await slugs(member.cookie, `team=${team.slug}`)).sort()).toEqual([onArtifact, onProject].sort());
    expect(await slugs(member.cookie, "team=no-such-team")).toEqual([]);
    expect(await slugs(reviewer.cookie, `team=${team.slug}`)).toEqual([]);
  });

  test("an organization token: only what it names, all open ones, or what it made", async () => {
    const open = unique("for-tokens");
    const shut = unique("shut-to-tokens");
    await put(token, open, "a");
    await put(token, shut, "b");
    await restrict(shut);
    const broad = await orgToken();
    expect((await publish(t, broad.secret, { project: open, slug: "new" })).status).toBe(200);
    expect(await error(await publish(t, broad.secret, { project: shut, slug: "new" }))).toMatchObject({
      code: "conflict",
    });
    const [row] = await t.server.db.select().from(projects).where(eq(projects.slug, shut));
    const named = await orgToken({ projectIds: [row?.id as string] });
    expect((await publish(t, named.secret, { project: shut, slug: "new" })).status).toBe(200);
    expect((await publish(t, named.secret, { project: open, slug: "other" })).status).toBe(403);
    const noOrg = await orgToken({ scopes: ["read", "publish"], projectIds: [row?.id as string] });
    expect((await publish(t, noOrg.secret, { project: shut, slug: "newer" })).status).toBe(403);
    // Restricting what a token made doesn't take it away.
    const made = unique("token-made");
    await put(broad.secret, made, "c");
    await restrict(made);
    expect((await publish(t, broad.secret, { project: made, slug: "d" })).status).toBe(200);
  });

  describe("links and outside invites in a restricted project", () => {
    test("they take manage, in a browser", async () => {
      const project = unique("links");
      const id = await put(member.token, project, "open-now");
      await grant(project, `person:${other.id}`, "manage", member.cookie);
      await restrict(project, member.cookie);
      await t.api(`/api/projects/${project}/access/person:${member.id}`, { method: "DELETE", cookie: owner });

      const link = (auth: object) =>
        t.api(`/api/artifacts/${id}/links`, { method: "POST", json: { permission: "view" }, ...auth });
      const invite = (email: string, auth: object) =>
        t.api(`/api/artifacts/${id}/access`, {
          method: "POST",
          json: { email, permission: "view" },
          ...auth,
        });
      // The publisher still has their artifact, and no project manage.
      expect((await link({ cookie: member.cookie })).status).toBe(403);
      expect((await link({ bearer: member.token })).status).toBe(403);
      expect((await invite("new@example.com", { cookie: member.cookie })).status).toBe(403);
      expect((await invite(outside.email, { cookie: member.cookie })).status).toBe(403);
      // Someone already here can be added: they aren't outside.
      expect((await invite(reviewer.email, { cookie: member.cookie })).status).toBe(200);
      expect((await link({ cookie: other.cookie })).status).toBe(200);
      expect((await link({ cookie: owner })).status).toBe(200);
      const access = await json<{ canShareOutside: boolean }>(
        await t.api(`/api/artifacts/${id}/access`, { cookie: member.cookie }),
      );
      expect(access.canShareOutside).toBe(false);
    });

    test("restricting says what stays live, and can end it", async () => {
      const project = unique("confirm");
      const id = await put(member.token, project, "shared-out");
      const made = await json<{ url: string }>(
        await t.api(`/api/artifacts/${id}/links`, {
          method: "POST",
          cookie: member.cookie,
          json: { permission: "view" },
        }),
      );
      await t.api(`/api/artifacts/${id}/access`, {
        method: "POST",
        cookie: member.cookie,
        json: { email: "pending@example.com", permission: "view" },
      });
      const broad = await orgToken();
      const before = await json<{
        impact: { loses: number; names: string[]; links: number; invites: number; tokens: number };
      }>(await t.api(`/api/projects/${project}/access`, { cookie: member.cookie }));
      expect(before.impact).toMatchObject({ links: 1, invites: 1 });
      expect(before.impact.tokens).toBeGreaterThan(0);
      expect(before.impact.loses).toBeGreaterThan(0);
      expect(before.impact.names).not.toContain(member.name);
      await t.server.db.update(tokens).set({ revokedAt: new Date() }).where(eq(tokens.id, broad.id));

      const secret = made.url.split("/s/")[1] as string;
      expect((await restrict(project, member.cookie)).status).toBe(200);
      expect((await t.api(`/api/s/${secret}`)).status).toBe(200);
      expect((await restrict(project, member.cookie, { revokeLinks: true })).status).toBe(200);
      expect((await t.api(`/api/s/${secret}`)).status).toBe(410);
      const after = await json<{ impact: { links: number; invites: number } }>(
        await t.api(`/api/projects/${project}/access`, { cookie: member.cookie }),
      );
      expect(after.impact).toMatchObject({ links: 0, invites: 0 });
      const rows = await t.server.db.select({ kind: activity.kind }).from(activity);
      expect(rows.map((row) => row.kind)).toContain("project_access_changed");
    });
  });

  test("a team with someone outside in it counts as sharing outside", async () => {
    const project = unique("through-a-team");
    const id = await put(member.token, project, "work");
    await restrict(project);
    await t.api(`/api/projects/${project}/access/person:${member.id}`, { method: "DELETE", cookie: owner });
    const inside = await makeTeam(unique("Inside"));
    await addTo(inside.slug, other);
    const mixed = await makeTeam(unique("Mixed"));
    await addTo(mixed.slug, outside);
    const share = (team: string, auth: object) =>
      t.api(`/api/artifacts/${id}/teams/${team}`, { method: "PUT", json: { permission: "view" }, ...auth });
    expect((await share(mixed.id, { cookie: member.cookie })).status).toBe(403);
    expect((await share(mixed.id, { bearer: member.token })).status).toBe(403);
    expect((await t.api(`/api/artifacts/${id}`, { cookie: outside.cookie })).status).toBe(404);
    expect((await share(inside.id, { cookie: member.cookie })).status).toBe(200);
    expect((await share(mixed.id, { cookie: owner })).status).toBe(200);
  });

  test("revoking links ends project invites too, and the count includes them", async () => {
    const project = unique("project-invites");
    await put(token, project, "work");
    const { url } = await json<{ url: string }>(
      await t.api(`/api/projects/${project}/access`, {
        method: "POST",
        cookie: owner,
        json: { email: "late@example.com", permission: "view" },
      }),
    );
    const before = await json<{ impact: { invites: number } }>(
      await t.api(`/api/projects/${project}/access`, { cookie: owner }),
    );
    expect(before.impact.invites).toBe(1);
    await restrict(project, owner, { revokeLinks: true });
    expect((await t.api(`/api/invites/${url.split("/join/")[1]}`)).status).toBe(410);
  });

  test("a brand proposal can't test whether a hidden artifact exists", async () => {
    const project = unique("probed");
    await put(token, project, "hidden-sample");
    await restrict(project);
    const propose = (slug: string) =>
      t.api("/api/brand/proposals", {
        method: "POST",
        bearer: member.token,
        json: { project, slug, brand: { name: "Probe", theme: { accent: "#123456" }, fonts: [] } },
      });
    const hidden = await propose("hidden-sample");
    const nothing = await propose("nothing-here");
    expect(hidden.status).toBe(nothing.status);
    expect(await error(hidden)).toEqual(await error(nothing));
  });

  test("the directory stays in the browser: a token reads who has access without it", async () => {
    const project = unique("no-directory");
    const id = await put(member.token, project, "work");
    const team = await makeTeam(unique("Quiet"));
    await addTo(team.slug, other);
    await grant(project, `team:${team.id}`, "view");
    await grant(project, `person:${reviewer.id}`, "view");
    await t.api(`/api/artifacts/${id}/teams/${team.id}`, {
      method: "PUT",
      bearer: member.token,
      json: { permission: "view" },
    });
    const onArtifact = await t.api(`/api/artifacts/${id}/access`, { bearer: member.token });
    const onProject = await t.api(`/api/projects/${project}/access`, { bearer: member.token });
    const seen = JSON.stringify([await onArtifact.json(), await onProject.json()]);
    expect(seen).not.toContain(OWNER.email);
    expect(seen).not.toContain(other.email);
    expect(seen).not.toContain(reviewer.email);
    const browser = await json<{ inherited: { email: string }[] }>(
      await t.api(`/api/artifacts/${id}/access`, { cookie: member.cookie }),
    );
    expect(browser.inherited.map((row) => row.email)).toContain(other.email);
  });

  test("a token that can only publish still reaches a restricted project it made", async () => {
    const made = unique("publish-only");
    const ci = await orgToken({ scopes: ["publish", "org"], projectIds: [] });
    await t.server.db.update(tokens).set({ projectIds: null }).where(eq(tokens.id, ci.id));
    expect((await publish(t, ci.secret, { project: made, slug: "one" })).status).toBe(200);
    await restrict(made);
    expect((await publish(t, ci.secret, { project: made, slug: "two" })).status).toBe(200);
  });

  test("a token can't get a session for someone who runs a project or a team", async () => {
    const admin = await makeAccount(t, orgId, "admin");
    const manager = await makeAccount(t, orgId, "member");
    const lead = await makeAccount(t, orgId, "member");
    const plain = await makeAccount(t, orgId, "member");
    const project = unique("reset-guard");
    await put(token, project, "work");
    await grant(project, `person:${manager.id}`, "manage");
    const team = await makeTeam(unique("Reset guard"));
    await t.api(`/api/teams/${team.slug}/members/${lead.id}`, {
      method: "PUT",
      cookie: owner,
      json: { role: "lead" },
    });
    const reset = (who: { id: string }, auth: object) =>
      t.api(`/api/people/${who.id}/reset-link`, { method: "POST", ...auth });
    expect((await reset(manager, { bearer: admin.token })).status).toBe(403);
    expect((await reset(lead, { bearer: admin.token })).status).toBe(403);
    expect((await reset(plain, { bearer: admin.token })).status).toBe(200);
    expect((await reset(manager, { cookie: admin.cookie })).status).toBe(200);
  });

  test("an unknown address makes a project invite; it's single purpose and capped", async () => {
    const project = unique("invited");
    const id = await put(token, project, "work");
    await restrict(project);
    const add = (email: string, permission: string) =>
      t.api(`/api/projects/${project}/access`, {
        method: "POST",
        cookie: owner,
        json: { email, permission },
      });
    expect((await add("capped@example.com", "publish")).status).toBe(400);
    const { url } = await json<{ url: string }>(await add("guest@example.com", "comment"));
    const secret = url.split("/join/")[1] as string;
    expect(await t.api(`/api/invites/${secret}`).then(json)).toMatchObject({
      project: { name: project },
      role: "outside",
    });
    const listed = await json<{ invites: { email: string }[] }>(
      await t.api("/api/people?kind=outside", { cookie: owner }),
    );
    expect(listed.invites.map((row) => row.email)).toContain("guest@example.com");
    const accepted = await t.api(`/api/invites/${secret}/accept`, {
      method: "POST",
      json: { name: "Guest", password: PASSWORD },
    });
    expect(accepted.status).toBe(200);
    const cookie = (accepted.headers.getSetCookie()[0] ?? "").split(";")[0] as string;
    expect(await t.api(`/api/artifacts/${id}`, { cookie }).then(json)).toMatchObject({
      permissions: { comment: true, manage: false },
    });
    const people_ = await json<{ people: { email: string; projects: { slug: string }[] }[] }>(
      await t.api("/api/people?kind=outside", { cookie: owner }),
    );
    expect(people_.people.find((row) => row.email === "guest@example.com")?.projects[0]?.slug).toBe(project);

    const known = await json<{ added: { id: string } }>(await add(member.email, "publish"));
    expect(known.added.id).toBe(member.id);
  });

  test("removing a person or deleting a team ends what they held", async () => {
    const project = unique("ending");
    const id = await put(token, project, "work");
    await restrict(project);
    const leaver = await makeAccount(t, orgId, "member");
    await grant(project, `person:${leaver.id}`, "comment");
    await t.api(`/api/people/${leaver.id}`, { method: "DELETE", cookie: owner });
    expect(
      await t.server.db.select().from(projectAccess).where(eq(projectAccess.personId, leaver.id)),
    ).toEqual([]);

    const team = await makeTeam(unique("Ending"));
    await addTo(team.slug, member);
    await grant(project, `team:${team.id}`, "comment");
    expect((await t.api(`/api/artifacts/${id}`, { cookie: member.cookie })).status).toBe(200);
    await t.api(`/api/teams/${team.slug}`, { method: "DELETE", cookie: owner });
    expect((await t.api(`/api/artifacts/${id}`, { cookie: member.cookie })).status).toBe(404);
  });

  test("the people list and Activity show what changed, to admins", async () => {
    const project = unique("visible-to-admins");
    await put(token, project, "work");
    await grant(project, `person:${member.id}`, "view");
    const list = await json<{ people: { id: string; projects: { slug: string; permission: string }[] }[] }>(
      await t.api("/api/people", { cookie: owner }),
    );
    expect(list.people.find((row) => row.id === member.id)?.projects).toContainEqual(
      expect.objectContaining({ slug: project, permission: "view" }),
    );
    const payload = (items: { kind: string; payload: { project?: string } }[]) =>
      items.filter((item) => item.kind === "project_access_changed" && item.payload.project === project);
    const admin = await json<{ items: { kind: string; payload: { project?: string } }[] }>(
      await t.api("/api/activity", { cookie: owner }),
    );
    expect(payload(admin.items).length).toBe(1);
    const asMember = await json<{ items: { kind: string; payload: { project?: string } }[] }>(
      await t.api("/api/activity", { cookie: member.cookie }),
    );
    expect(payload(asMember.items)).toEqual([]);
  });

  test("publishing says who can see it", async () => {
    const audience = async (bearer: string, project: string, slug: string, visibility: "me" | "org") =>
      (await json<{ audience: string }>(await publish(t, bearer, { project, slug, visibility }))).audience;
    const project = unique("audience");
    expect(await audience(token, project, "open", "org")).toBe("Everyone in Mochahub");
    expect(await audience(token, project, "private", "me")).toBe("Only the publisher");

    await restrict(project);
    expect(await audience(token, project, "open", "org")).toBe(`Only people added to ${project}`);
    const team = await makeTeam(unique("Audience"));
    await grant(project, `team:${team.id}`, "view");
    await grant(project, `person:${member.id}`, "view");
    await grant(project, `person:${other.id}`, "view");
    expect(await audience(token, project, "open", "org")).toMatch(/^Audience-\d+ and 2 people$/);

    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "open"));
    const status = (auth: object) => t.api(`/api/artifacts/${row?.id}/status`, auth).then(json);
    expect(await status({ cookie: owner })).toMatchObject({ audience: expect.stringContaining("2 people") });
    expect(await status({ cookie: member.cookie })).not.toHaveProperty("audience");
  });
});
