import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ArtifactLinks,
  ProjectRow,
  PublishPrepared,
  PublishResult,
  WikiCreated,
  WikiSpace,
} from "@artifacts/schema";
import { articleRecords, buildArticle } from "@artifacts/schema/article";
import { and, eq } from "drizzle-orm";
import { GUIDES } from "../../../../skill/index.ts";
import { artifacts, projectAccess, projects, teams, tokens, versions } from "../../src/db/schema.ts";
import { claim, mcp, OWNER, orgToken, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { file, makePerson, publish } from "../publish-helper.ts";

describe("wikis", () => {
  let t: TestServer;
  let token: string;
  let orgId: string;
  let cookie: string;
  const call = async (name: string, args: object, bearer = token) => {
    const r = await mcp(t, bearer, "tools/call", { name, arguments: args });
    const b = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return { ...b.result, content: b.result.content.map((c) => c) };
  };
  const article = (slug: string, markdown: string, extra: object = {}) =>
    call("artifacts_publish_article", {
      project: "brain",
      slug,
      title: slug,
      summary: "Wiki knowledge.",
      markdown,
      ...extra,
    });
  const create = (slug: string, extra = {}, bearer = token) =>
    t.api("/api/wikis", { method: "POST", bearer, json: { slug, name: slug, ...extra } });
  beforeAll(async () => {
    t = await startTestServer();
    ({ token, orgId } = await claim(t));
    cookie = await signIn(t, OWNER.email, OWNER.password);
  });
  afterAll(() => t.stop());
  test("creation is idempotent and managed projects convert", async () => {
    expect((await create("brain")).status).toBe(201);
    expect((await create("brain")).status).toBe(200);
    await publish(t, token, { project: "convert" });
    expect((await create("convert")).status).toBe(200);
    const other = await makePerson(t, orgId, "member");
    await publish(t, token, { project: "taken" });
    expect((await create("taken", {}, other.token)).status).toBe(409);
    expect((await create("private", { onlyMe: true }, other.token)).status).toBe(201);
    const stranger = await makePerson(t, orgId, "member");
    expect((await t.api("/api/wikis/private", { bearer: stranger.token })).status).toBe(404);
    expect((await t.api("/api/wikis/private", { bearer: other.token })).status).toBe(200);
  });
  test("audiences follow real access, retain legacy input, and hide team metadata", async () => {
    const member = await makePerson(t, orgId, "member");
    const createAs = (slug: string, extra: object) => create(slug, extra, member.token);
    const mine = WikiCreated.parse(await (await createAs("mine", { onlyMe: true })).json());
    expect(mine.audience).toEqual({ kind: "me", label: "Only you" });
    expect(mine.guidance.edits).toBe("direct");
    expect(WikiCreated.parse(await (await createAs("legacy", { personal: true })).json()).audience).toEqual(
      mine.audience,
    );
    expect(WikiCreated.parse(await (await createAs("open", {})).json()).audience).toEqual({
      kind: "org",
      label: "Everyone in Mochahub",
    });
    const teamId = Bun.randomUUIDv7();
    await t.server.db
      .insert(teams)
      .values({ id: teamId, orgId, slug: "design", name: "Design", createdBy: member.id });
    const shared = WikiCreated.parse(await (await createAs("team-wiki", { team: "design" })).json());
    expect(shared.audience).toEqual({
      kind: "team",
      label: "Design team",
      teams: [{ slug: "design", name: "Design" }],
    });
    expect(shared.guidance.edits).toBe("suggestion");
    expect((await createAs("team-wiki", { onlyMe: true })).status).toBe(409);
    expect(
      WikiCreated.parse(await (await createAs("team-wiki", { team: "design" })).json()).audience,
    ).toEqual(shared.audience);
    expect((await createAs("conflicting", { onlyMe: true, team: "design" })).status).toBe(400);
    expect((await createAs("bad-team", { team: "absent" })).status).toBe(400);
    const reviewer = await makePerson(t, orgId, "reviewer");
    const [project] = await t.server.db.select().from(projects).where(eq(projects.slug, "team-wiki"));
    if (!project) throw new Error("Missing wiki");
    await t.server.db.insert(projectAccess).values({
      id: Bun.randomUUIDv7(),
      orgId,
      projectId: project.id,
      personId: reviewer.id,
      permission: "view",
      grantedBy: member.id,
    });
    const hidden = WikiSpace.parse(
      await (await t.api("/api/wikis/team-wiki", { bearer: reviewer.token })).json(),
    );
    expect(hidden.project.audience).toEqual({ kind: "team", label: "Shared wiki" });
    expect(JSON.stringify(hidden)).not.toContain("Design");
    expect(JSON.stringify(hidden)).not.toContain("design");
    const listed = ProjectRow.array().parse(
      await (await t.api("/api/projects", { bearer: reviewer.token })).json(),
    );
    expect(listed.find((p: { slug: string }) => p.slug === "team-wiki")?.audience).toEqual(
      hidden.project.audience,
    );
  });
  test("status redacts team wiki audiences for readers without directory access", async () => {
    const owner = await makePerson(t, orgId, "member");
    await t.server.db.insert(teams).values({
      id: Bun.randomUUIDv7(),
      orgId,
      slug: "secret-team",
      name: "Confidential",
      createdBy: owner.id,
    });
    await create("status-wiki", { team: "secret-team" }, owner.token);
    await call(
      "artifacts_publish_article",
      { project: "status-wiki", slug: "topic", title: "Topic", summary: "A topic", markdown: "Hello" },
      owner.token,
    );
    const [project] = await t.server.db.select().from(projects).where(eq(projects.slug, "status-wiki"));
    if (!project) throw new Error("Missing project");
    const [page] = await t.server.db.select().from(artifacts).where(eq(artifacts.projectId, project.id));
    if (!project) throw new Error("Missing project");
    const reader = await orgToken(t, cookie, { projectIds: [project.id] });
    if (!page) throw new Error("Missing page");
    const response = await t.api(`/api/artifacts/${page.id}/status`, { bearer: reader.token });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { audience: string }).audience).toBe("Shared wiki");
    const status = await call("artifacts_status", { artifact: "status-wiki/topic" }, reader.token);
    expect(status.isError).not.toBe(true);
    expect(JSON.stringify(status)).toContain("Shared wiki");
    expect(JSON.stringify(status)).not.toContain("Confidential");
  });
  test("an organization token reader changes only-me guidance until revoked", async () => {
    await create("token-reader", { onlyMe: true });
    const [project] = await t.server.db.select().from(projects).where(eq(projects.slug, "token-reader"));
    if (!project) throw new Error("Missing project");
    const reader = await orgToken(t, cookie, { projectIds: [project.id] });
    const detail = () =>
      t.api("/api/wikis/token-reader", { bearer: token }).then(async (r) => WikiSpace.parse(await r.json()));
    expect((await detail()).project).toMatchObject({
      audience: { kind: "team", label: "Shared wiki" },
      guidance: { edits: "suggestion" },
    });
    await t.server.db.update(tokens).set({ revokedAt: t.clock.now() }).where(eq(tokens.id, reader.id));
    expect((await detail()).project).toMatchObject({
      audience: { kind: "me", label: "Only you" },
      guidance: { edits: "direct" },
    });
  });
  test("idempotent creation ignores renamed and deleted requested teams", async () => {
    const id = Bun.randomUUIDv7();
    const owner = await makePerson(t, orgId, "member");
    await t.server.db.insert(teams).values({ id, orgId, slug: "old-team", name: "Old", createdBy: owner.id });
    await create("rename-wiki", { team: "old-team" }, owner.token);
    await t.server.db.update(teams).set({ slug: "new-team", name: "New" }).where(eq(teams.id, id));
    const renamed = await create("rename-wiki", { team: "old-team" }, owner.token);
    expect(renamed.status).toBe(200);
    expect(WikiCreated.parse(await renamed.json()).audience.label).toBe("New team");
    await t.server.db.delete(projectAccess).where(eq(projectAccess.teamId, id));
    await t.server.db.delete(teams).where(eq(teams.id, id));
    const deleted = await create("rename-wiki", { team: "old-team" }, owner.token);
    expect(deleted.status).toBe(200);
    expect(WikiCreated.parse(await deleted.json()).audience.kind).toBe("me");
  });
  test("HTTP and MCP accept team slugs reserved for project routes", async () => {
    const owner = await makePerson(t, orgId, "member");
    await t.server.db
      .insert(teams)
      .values({ id: Bun.randomUUIDv7(), orgId, slug: "settings", name: "Settings", createdBy: owner.id });
    expect((await create("reserved-team", { team: "settings" }, owner.token)).status).toBe(201);
    const result = await call(
      "artifacts_wiki_create",
      { slug: "reserved-mcp", name: "Reserved", team: "settings" },
      owner.token,
    );
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("Settings team");
  });
  test("latest links, sources and every garden finding respect visibility", async () => {
    await article("rules", "# Rules\nFollow these rules.");
    await article("source", "# Original", { role: "source", untrusted: true, origin: "https://example.com" });
    await article("page", "[[Missing]] [[source]]", { sources: ["source"] });
    t.clock.advance(1000);
    await article("source", "# Updated", { role: "source", untrusted: true });
    await article("lonely", "# Alone");
    const space = WikiSpace.parse(await (await t.api("/api/wikis/brain", { bearer: token })).json());
    expect(space.rules?.slug).toBe("rules");
    expect(space.sources).toHaveLength(1);
    expect(new Set(space.garden.map((f: { kind: string }) => f.kind))).toEqual(
      new Set(["untrusted", "stale", "wanted", "orphan", "unsourced"]),
    );
    const [a] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "page"));
    if (!a) throw new Error("Missing page");
    const [v] = await t.server.db.select().from(versions).where(eq(versions.artifactId, a.id));
    expect(v?.links).toEqual(["brain/missing", "brain/source"]);
    const links = ArtifactLinks.parse(
      await (await t.api(`/api/artifacts/${a.id}/links`, { bearer: token })).json(),
    );
    expect(links.outgoing[0]).toMatchObject({ exists: false, title: null });
    expect(links.sources[0]?.slug).toBe("source");
    expect((await call("artifacts_wiki", { wiki: "brain" })).content[1]?.text).toContain("rulesText");
    expect((await call("artifacts_wiki", {})).content[1]?.text).toContain("brain");
    expect((await call("artifacts_wiki_links", { artifact: "brain/page" })).content[1]?.text).toContain(
      "outgoing",
    );
    expect(
      (await call("artifacts_wiki_create", { slug: "toolwiki", name: "Tool Wiki" })).content[1]?.text,
    ).toContain("toolwiki");
    expect(
      JSON.parse(
        (await call("artifacts_comment", { artifact: "brain/page", message: "Please review." })).content[0]
          ?.text as string,
      ).id,
    ).toBe(1);
    expect(
      WikiSpace.parse(await (await t.api("/api/wikis/brain", { bearer: token })).json()).log.some(
        (e: { kind: string }) => e.kind === "commented",
      ),
    ).toBe(true);
    await t.server.db
      .update(artifacts)
      .set({ visibility: "me" })
      .where(and(eq(artifacts.projectId, a.projectId), eq(artifacts.slug, "source")));
    const other = await makePerson(t, orgId, "member");
    const hidden = ArtifactLinks.parse(
      await (await t.api(`/api/artifacts/${a.id}/links`, { bearer: other.token })).json(),
    );
    expect(hidden.sources[0]).toMatchObject({ exists: false, title: null, summary: null, untrusted: false });
    expect(hidden.untrusted).toBe(false);
    const clean = WikiSpace.parse(await (await t.api("/api/wikis/brain", { bearer: other.token })).json());
    expect(clean.sources).toHaveLength(0);
    expect(clean.garden.some((f: { kind: string }) => f.kind === "untrusted" || f.kind === "stale")).toBe(
      false,
    );
  });
  test("a narrower audience on an existing wiki or project is refused, not ignored", async () => {
    const owner = await makePerson(t, orgId, "member");
    const first = await create("aud-org", {}, owner.token);
    expect(first.status).toBe(201);
    expect(WikiCreated.parse(await first.json()).created).toBe(true);
    {
      const again = await create("aud-org", {}, owner.token);
      expect(again.status).toBe(200);
      expect(WikiCreated.parse(await again.json()).created).toBe(false);
    }
    const refused = await create("aud-org", { onlyMe: true }, owner.token);
    expect(refused.status).toBe(409);
    const message = ((await refused.json()) as { error: { code: string; message: string } }).error;
    expect(message.code).toBe("conflict");
    expect(message.message).toContain("aud-org already exists with audience");
    expect(message.message).toContain("Everyone in Mochahub");
    expect(message.message).toContain("not changed");
    expect(message.message).toContain("Share sheet");
    expect(message.message).not.toContain("..");
    expect((await create("aud-org", { personal: true }, owner.token)).status).toBe(409);
    await t.server.db.insert(teams).values({
      id: Bun.randomUUIDv7(),
      orgId,
      slug: "aud-team",
      name: "Aud",
      createdBy: owner.id,
    });
    expect((await create("aud-org", { team: "aud-team" }, owner.token)).status).toBe(409);
    const mcpRefused = await call(
      "artifacts_wiki_create",
      { slug: "aud-org", name: "x", onlyMe: true },
      owner.token,
    );
    expect(mcpRefused.isError).toBe(true);
    expect(JSON.stringify(mcpRefused)).toContain("Share sheet");
    const mcpSame = await call("artifacts_wiki_create", { slug: "aud-org", name: "x" }, owner.token);
    expect(mcpSame.isError).not.toBe(true);
    expect(JSON.parse(mcpSame.content[1]?.text ?? "null").created).toBe(false);

    // Narrowing from a team wiki to only-me is refused too; asking wider stays idempotent.
    await create("aud-team-wiki", { team: "aud-team" }, owner.token);
    expect((await create("aud-team-wiki", { onlyMe: true }, owner.token)).status).toBe(409);
    expect((await create("aud-team-wiki", { team: "aud-team" }, owner.token)).status).toBe(200);
    expect((await create("aud-team-wiki", {}, owner.token)).status).toBe(200);

    // An ordinary org-visible project is not converted by a refused only-me request.
    await publish(t, token, { project: "aud-plain" });
    const kindOf = async () =>
      (await t.server.db.select().from(projects).where(eq(projects.slug, "aud-plain")))[0]?.kind;
    expect(await kindOf()).not.toBe("wiki");
    const plainRefused = await create("aud-plain", { onlyMe: true });
    expect(plainRefused.status).toBe(409);
    expect(await kindOf()).not.toBe("wiki");
    const plain = await create("aud-plain");
    expect(plain.status).toBe(200);
    expect(WikiCreated.parse(await plain.json()).created).toBe(false);
    expect(await kindOf()).toBe("wiki");
  });
  test("guidance text follows the audience and never names a hidden team", async () => {
    const member = await makePerson(t, orgId, "member");
    const text = async (slug: string, extra: object) =>
      WikiCreated.parse(await (await create(slug, extra, member.token)).json()).guidance.text;
    expect(await text("g-me", { onlyMe: true })).toBe("Only you can read this wiki: edit directly.");
    expect(await text("g-org", {})).toBe(
      "Everyone in Mochahub can read this wiki: propose suggestions rather than editing directly.",
    );
    await t.server.db
      .insert(teams)
      .values({ id: Bun.randomUUIDv7(), orgId, slug: "g-team", name: "Guide", createdBy: member.id });
    expect(await text("g-team-wiki", { team: "g-team" })).toBe(
      "Guide team can read this wiki: propose suggestions rather than editing directly.",
    );
    const reviewer = await makePerson(t, orgId, "reviewer");
    const [project] = await t.server.db.select().from(projects).where(eq(projects.slug, "g-team-wiki"));
    if (!project) throw new Error("Missing wiki");
    await t.server.db.insert(projectAccess).values({
      id: Bun.randomUUIDv7(),
      orgId,
      projectId: project.id,
      personId: reviewer.id,
      permission: "view",
      grantedBy: member.id,
    });
    const hidden = WikiSpace.parse(
      await (await t.api("/api/wikis/g-team-wiki", { bearer: reviewer.token })).json(),
    );
    expect(hidden.project.guidance.text).toBe(
      "Others can read this wiki: propose suggestions rather than editing directly.",
    );
    expect(JSON.stringify(hidden)).not.toContain("Guide");
    const adminView = WikiSpace.parse(await (await t.api("/api/wikis/g-me", { bearer: token })).json());
    expect(adminView.project.guidance).toEqual({
      edits: "suggestion",
      text: "Only the owner can read this wiki: propose suggestions rather than editing directly.",
    });
  });
  test("refusals say why", async () => {
    const owner = await makePerson(t, orgId, "member");
    const mcpError = async (args: object) => {
      const r = await call("artifacts_wiki_create", args, owner.token);
      expect(r.isError).toBe(true);
      return JSON.stringify(r);
    };
    expect(await mcpError({ slug: "settings", name: "x" })).toContain("slug: this word is reserved");
    expect(await mcpError({ slug: "okay", name: "x", onlyMe: true, team: "design" })).toContain(
      "team: Choose onlyMe or team, not both.",
    );
    expect(await mcpError({ slug: "okay", name: "" })).toContain("name:");
    const unknown = await create("okay", { team: "no-such-team" }, owner.token);
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(await unknown.json())).toContain("Run artifacts teams");
    expect(await mcpError({ slug: "okay", name: "x", team: "no-such-team" })).toContain(
      "Run artifacts teams",
    );
  });
  test("showing an ordinary project says it isn't a wiki, without revealing hidden ones", async () => {
    const owner = await makePerson(t, orgId, "member");
    await publish(t, owner.token, { project: "not-a-wiki" });
    const stranger = await makePerson(t, orgId, "member");
    const message = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;
    const shown = await t.api("/api/wikis/not-a-wiki", { bearer: owner.token });
    expect(shown.status).toBe(404);
    expect(await message(shown)).toBe(
      "not-a-wiki isn't a wiki. Make it one with artifacts wiki create not-a-wiki.",
    );
    const mcpShown = await call("artifacts_wiki", { wiki: "not-a-wiki" }, owner.token);
    expect(mcpShown.isError).toBe(true);
    expect(JSON.stringify(mcpShown)).toContain("isn't a wiki. Make it one with artifacts wiki create");
    await create("hidden-plain", { onlyMe: true }, owner.token);
    await t.server.db.update(projects).set({ kind: "project" }).where(eq(projects.slug, "hidden-plain"));
    const hidden = await call("artifacts_wiki", { wiki: "hidden-plain" }, stranger.token);
    expect(hidden.isError).toBe(true);
    expect(JSON.stringify(hidden)).toContain("Not found.");
    expect(JSON.stringify(hidden)).not.toContain("isn't a wiki");
    expect(JSON.stringify(await call("artifacts_wiki", { wiki: "no-such" }, owner.token))).toContain(
      "Not found.",
    );
  });
  test("wiki list counts match detail pages, excluding rules and sources", async () => {
    await create("counts");
    await article("rules", "# Rules", { project: "counts" });
    for (const count of [0, 1]) {
      if (count) {
        await article("topic", "# Topic", { project: "counts" });
        await article("notes", "# Notes", { project: "counts", role: "source" });
      }
      const detail = WikiSpace.parse(
        JSON.parse((await call("artifacts_wiki", { wiki: "counts" })).content[1]?.text ?? "null"),
      );
      expect(detail.rules?.slug).toBe("rules");
      expect(detail.pages).toHaveLength(count);
      expect(detail.sources).toHaveLength(count);
      const listed = JSON.parse((await call("artifacts_wiki", {})).content[1]?.text ?? "null");
      expect(listed).toContainEqual({
        slug: "counts",
        name: "counts",
        audience: { kind: "org", label: "Everyone in Mochahub" },
        guidance: detail.project.guidance,
        pages: detail.pages.length,
        sources: detail.sources.length,
      });
    }
  });
  test("the hosted starter rules publish without wanted findings", async () => {
    const resource = (await (
      await mcp(t, token, "resources/read", { uri: "artifacts://guides/wiki" })
    ).json()) as { result: { contents: { text: string }[] } };
    const guide = resource.result.contents[0]?.text;
    expect(guide).toBe(GUIDES.wiki);
    const starter = /```markdown\n([\s\S]*?)\n```/.exec(guide ?? "")?.[1];
    expect(starter).toContain("# Wiki rules");
    await create("starter");
    expect((await article("rules", starter ?? "", { project: "starter" })).isError).not.toBe(true);
    await article("notes", "# Notes", { project: "starter", role: "source" });
    const space = WikiSpace.parse(await (await t.api("/api/wikis/starter", { bearer: token })).json());
    expect(space.rules?.slug).toBe("rules");
    expect(space.garden).toEqual([]);
    const links = JSON.parse(
      (await call("artifacts_wiki_links", { artifact: "starter/rules" })).content[1]?.text ?? "null",
    );
    expect(links.outgoing).toEqual([]);
  });
  test("reserved and inaccessible cross-wiki targets create no local wanted finding", async () => {
    await create("link-scope");
    await create("hidden-links", { onlyMe: true });
    await article("secret", "# Secret", { project: "hidden-links" });
    await article("topic", "[[Settings]] [[hidden-links/Secret]]", { project: "link-scope" });
    const other = await makePerson(t, orgId, "member");
    const links = ArtifactLinks.parse(
      JSON.parse(
        (await call("artifacts_wiki_links", { artifact: "link-scope/topic" }, other.token)).content[1]
          ?.text ?? "null",
      ),
    );
    expect(links.outgoing).toEqual([
      {
        project: "hidden-links",
        slug: "secret",
        exists: false,
        title: null,
        summary: null,
        untrusted: false,
        origin: null,
      },
    ]);
    const space = WikiSpace.parse(
      await (await t.api("/api/wikis/link-scope", { bearer: other.token })).json(),
    );
    expect(space.garden.filter((f) => f.kind === "wanted")).toEqual([]);
  });
  test("API article links survive restore and hidden backlinks never count", async () => {
    const built = buildArticle({
      project: "brain",
      path: "doc.md",
      source: "[[page]] [[source]]",
      readFile: () => "",
      blobHash: () => undefined,
      frameHash: () => undefined,
      mermaid: new Map(),
    });
    const html = file("__articles/doc.html", built.html);
    const ready = PublishPrepared.parse(
      await (
        await t.api("/api/publish/prepare", {
          method: "POST",
          bearer: token,
          json: {
            project: "brain",
            slug: "api-page",
            title: "API Page",
            files: [{ path: html.path, sha256: html.sha256, size: html.size, type: html.type }],
          },
        })
      ).json(),
    );
    for (const missing of ready.missing) {
      const uploaded = await fetch(missing.url, { method: "PUT", headers: missing.headers, body: html.body });
      expect(uploaded.ok || uploaded.status === 412).toBe(true);
    }
    const records = articleRecords(built, {
      id: "doc",
      title: "API Page",
      group: null,
      position: 0,
      htmlHash: html.sha256,
      theme: null,
    });
    const result = PublishResult.parse(
      await (
        await t.api("/api/publish/commit", {
          method: "POST",
          bearer: token,
          json: {
            uploadId: ready.uploadId,
            name: null,
            message: null,
            notes: {},
            wiki: { role: "page", sources: ["source"] },
            files: { [html.path]: { hash: html.sha256, size: html.size, type: html.type } },
            pages: [records.page],
            blocks: records.blocks,
            frames: [],
          },
        })
      ).json(),
    );
    const [a] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "api-page"));
    if (!a) throw new Error("Missing API article");
    const [v] = await t.server.db.select().from(versions).where(eq(versions.artifactId, a.id));
    expect(v?.links).toEqual(["brain/page", "brain/source"]);
    await article("api-page", "Replacement");
    expect(
      (await t.api(`/api/artifacts/${a.id}/versions/1/restore`, { method: "POST", bearer: token, json: {} }))
        .status,
    ).toBe(200);
    const [restored] = await t.server.db
      .select()
      .from(versions)
      .where(and(eq(versions.artifactId, a.id), eq(versions.n, 3)));
    expect(restored?.links).toEqual(v?.links);
    expect(restored?.wiki).toEqual(v?.wiki);
    expect(result.version).toBe(1);
    await t.server.db.update(artifacts).set({ visibility: "me" }).where(eq(artifacts.id, a.id));
    const other = await makePerson(t, orgId, "member");
    const space = WikiSpace.parse(await (await t.api("/api/wikis/brain", { bearer: other.token })).json());
    expect(space.pages.find((p) => p.slug === "page")?.backlinks).toBe(0);
    expect(JSON.stringify(space)).not.toContain("API Page");
  });
  test("new MCP tools refuse insufficient scopes", async () => {
    const other = await makePerson(t, orgId, "member");
    await t.server.db.update(tokens).set({ scopes: [] }).where(eq(tokens.personId, other.id));
    for (const name of [
      "artifacts_wiki",
      "artifacts_wiki_links",
      "artifacts_wiki_create",
      "artifacts_comment",
    ]) {
      const r = await mcp(t, other.token, "tools/call", { name, arguments: {} });
      expect(r.status).toBe(403);
    }
  });
});
