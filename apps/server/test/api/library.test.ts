import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ArtifactLinks,
  DecisionList,
  LibraryCard,
  LibraryFrames,
  LibraryPage,
  LibraryPages,
  LibraryProjects,
  LibraryRead,
  LibraryView,
  SUMMARY_MAX,
  TAG_MAX,
  TAGS_MAX,
  VersionBundle,
  WikiSpace,
} from "@artifacts/schema";
import {
  claim,
  joinAsGuest,
  json,
  orgToken as makeOrgToken,
  OWNER,
  signIn,
  startTestServer,
  type TestServer,
} from "../helpers.ts";
import { file, makePerson, publish } from "../publish-helper.ts";

describe("the library", () => {
  let t: TestServer;
  let owner: string;
  let member: string;
  let reviewer: string;
  let outside: string;
  let orgToken: string;
  let orgId: string;
  let cookie: string;
  const get = (path: string, bearer = owner) => t.api(path, { bearer });
  const search = async (q: string, bearer = owner, more = "") =>
    LibraryPage.parse(
      await (await get(`/api/library/search?q=${encodeURIComponent(q)}${more}`, bearer)).json(),
    );

  beforeAll(async () => {
    t = await startTestServer();
    const claimed = await claim(t);
    owner = claimed.token;
    orgId = claimed.orgId;
    cookie = await signIn(t, OWNER.email, OWNER.password);
    member = (await makePerson(t, orgId, "member")).token;
    reviewer = (await makePerson(t, orgId, "reviewer")).token;
    outside = (await makePerson(t, orgId, "outside")).token;
    orgToken = (await makeOrgToken(t, cookie, { scopes: ["read"] })).token;
    await publish(t, owner, {
      project: "game",
      slug: "art-styles",
      title: "Art style studies",
      summary: "Six painterly styles for the forest level; the gouache one won.",
      tags: ["art", "styles"],
      frameTitle: "Gouache forest",
      frameKey: "gouache",
      repo: "git@github.com:Mocha/Game.git",
      blocks: [],
      notes: { gouache: "Warmer shadows after review" },
    });
    await publish(t, owner, {
      project: "game",
      slug: "economy",
      title: "Economy plan",
      summary: "How coins flow.",
      blocks: [
        { key: "intro/p1", text: "We tune the sink rates with a spreadsheet of marmalade values." },
        { key: "intro/p2", text: "Second paragraph." },
      ],
    });
    await publish(t, owner, {
      project: "game",
      slug: "secret",
      title: "Secret marmalade plan",
      visibility: "me",
      summary: "Hidden summary about marmalade.",
      blocks: [{ key: "intro/p1", text: "Hidden marmalade body." }],
    });
    await publish(t, owner, { project: "legacy", slug: "old", summary: null, message: "Old message" });
  });
  afterAll(() => t.stop());

  test("search finds a summary, a tag, a frame title, a note and article text", async () => {
    expect((await search("gouache")).cards[0]?.slug).toBe("art-styles");
    const tag = await search("styles");
    expect(tag.cards[0]?.match?.source).toBe("title");
    expect((await search("painterly")).cards[0]?.match?.source).toBe("summary");
    expect((await search("warmer shadows")).cards[0]?.match?.source).toBe("note");
    const body = (await search("spreadsheet")).cards[0];
    expect(body?.slug).toBe("economy");
    expect(body?.match).toMatchObject({ source: "block", page: "plan", ref: "intro/p1" });
    expect(body?.match?.snippet).toContain("spreadsheet");
  });

  test("the last word is a prefix, and stemming matches other forms", async () => {
    expect((await search("spreads")).cards[0]?.slug).toBe("economy");
    expect((await search("tuning")).cards[0]?.slug).toBe("economy");
  });

  test("search reads comments, marks them as such, and only the latest version's text", async () => {
    const { id } = (await (await get("/api/artifacts/by-slug/game/economy")).json()) as { id: string };
    await t.api(`/api/artifacts/${id}/threads`, {
      method: "POST",
      bearer: owner,
      json: { pageKey: "plan", anchor: null, body: "Why not quince instead?", version: 1 },
    });
    expect((await search("quince")).cards[0]?.match?.source).toBe("comment");
    await publish(t, owner, {
      project: "game",
      slug: "economy",
      title: "Economy plan",
      summary: "How coins flow.",
      blocks: [{ key: "intro/p1", text: "The new text talks about silverware." }],
    });
    expect((await search("spreadsheet")).cards).toEqual([]);
    expect((await search("silverware")).cards[0]?.slug).toBe("economy");
  });

  test("nothing about a hidden artifact shows, for anyone without access", async () => {
    for (const caller of [member, reviewer, orgToken]) {
      const found = await search("marmalade", caller);
      expect(JSON.stringify(found)).not.toContain("Hidden");
      expect(found.cards.map((card) => card.slug)).not.toContain("secret");
    }
    expect(JSON.stringify(await search("marmalade", outside))).toBe('{"cards":[],"nextCursor":null}');
    expect((await search("marmalade", owner)).cards.map((card) => card.slug)).toContain("secret");
    const projects = LibraryProjects.parse(await (await get("/api/library/projects", member)).json());
    expect(projects.projects.find((row) => row.slug === "game")?.artifacts).toBe(2);
    expect((await get("/api/library/projects/game/secret", member)).status).toBe(404);
    expect((await get("/api/library/projects/game/secret/read", member)).status).toBe(404);
    expect((await get("/api/library/projects/game/secret/view", member)).status).toBe(404);
    expect((await get("/api/library/projects/game/secret/bundle", member)).status).toBe(404);
    expect((await get("/api/library/projects/game", outside)).status).toBe(404);
  });

  test("a guest and anonymous callers can't search or list", async () => {
    const { id } = (await (await get("/api/artifacts/by-slug/game/economy")).json()) as { id: string };
    const made = await t.api(`/api/artifacts/${id}/links`, {
      method: "POST",
      bearer: owner,
      json: { permission: "view" },
    });
    const cookie = await joinAsGuest(t, (await json<{ url: string }>(made)).url, "Sam");
    expect((await t.api("/api/library/search?q=coins", { cookie })).status).toBe(403);
    expect((await t.api("/api/library/projects", { cookie })).status).toBe(403);
    expect((await t.api("/api/search?q=coins", { cookie })).status).toBe(403);
    expect((await t.api("/api/library/search?q=coins")).status).toBe(401);
    expect((await t.api("/api/library/projects/game/economy/read")).status).toBe(401);
    // A guest reads what their link opens, the same way the viewer does.
    expect((await t.api("/api/library/projects/game/economy/read", { cookie })).status).toBe(200);
    expect((await t.api("/api/library/projects/game/art-styles/read", { cookie })).status).toBe(404);
  });

  test("a project resolves from any form of its git remote, without a password", async () => {
    const forms = [
      "git@github.com:mocha/game.git",
      "https://user:secret@github.com/Mocha/Game.git",
      "ssh://git@github.com:22/mocha/game",
      "https://github.com/mocha/game/",
    ];
    for (const repo of forms) {
      const found = LibraryProjects.parse(
        await (await get(`/api/library/projects?repo=${encodeURIComponent(repo)}`)).json(),
      );
      expect(found.projects.map((row) => row.slug)).toEqual(["game"]);
      expect(found.projects[0]?.repo).toBe("mocha/game");
    }
    const scoped = await search("gouache", owner, `&repo=${encodeURIComponent(forms[0] as string)}`);
    expect(scoped.cards).toHaveLength(1);
    expect((await search("gouache", owner, "&repo=other/thing")).cards).toEqual([]);
    expect((await get("/api/library/search?q=gouache&repo=nonsense")).status).toBe(400);
  });

  test("the outcome shows a decision, open comments and the archive", async () => {
    const first = (await search("coins")).cards[0];
    expect(first?.outcome.openComments).toBe(1);
    expect(first?.outcome.decision).toBe(null);
    const { id } = (await (await get("/api/artifacts/by-slug/legacy/old")).json()) as { id: string };
    await t.api(`/api/artifacts/${id}/archive`, { method: "POST", bearer: owner });
    const archived = (await search("roadmap")).cards.find((card) => card.slug === "old");
    expect(archived?.outcome.archived).toBe(true);
    expect((await search("roadmap", owner, "&archived=false")).cards.map((c) => c.slug)).not.toContain("old");
    // People's search hides it (SPEC 5.5).
    const people = (await (await get("/api/search?q=roadmap")).json()) as { artifacts: { slug: string }[] };
    expect(people.artifacts.map((hit) => hit.slug)).not.toContain("old");
    await t.api(`/api/artifacts/${id}/unarchive`, { method: "POST", bearer: owner });
  });

  test("an old version with no summary shows its first text", async () => {
    const cards = LibraryPage.parse(await (await get("/api/library/projects/legacy")).json()).cards;
    expect(cards[0]?.summary).toBe("Hello");
  });

  test("list goes only as deep as asked", async () => {
    const top = LibraryProjects.parse(await (await get("/api/library/projects")).json());
    expect(top.projects.map((row) => row.slug).sort()).toEqual(["game", "legacy"]);
    const artifacts = LibraryPage.parse(await (await get("/api/library/projects/game")).json());
    expect(artifacts.cards.map((card) => card.slug)).toContain("art-styles");
    const pages = LibraryPages.parse(await (await get("/api/library/projects/game/art-styles")).json());
    expect(pages.pages.map((page) => [page.key, page.frames])).toEqual([
      ["plan", 0],
      ["mocks", 1],
    ]);
    const frames = LibraryFrames.parse(
      await (await get("/api/library/projects/game/art-styles/pages/mocks")).json(),
    );
    expect(frames.frames[0]).toMatchObject({ key: "gouache", title: "Gouache forest" });
    expect(frames.frames[0]?.note).toBe("Warmer shadows after review");
  });

  test("read is paged by characters and keeps every word, even inside one long block", async () => {
    const long = "word ".repeat(1000).trim();
    await publish(t, owner, {
      project: "game",
      slug: "long",
      summary: "Long.",
      blocks: [
        { key: "intro/p1", text: "Short." },
        { key: "intro/p2", text: long },
      ],
    });
    let cursor: string | null = null;
    let text = "";
    let calls = 0;
    do {
      const query: string = `/api/library/projects/game/long/read?chars=1000${cursor ? `&cursor=${cursor}` : ""}`;
      const body = LibraryRead.parse(await (await get(query)).json());
      expect(body.items.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(1000);
      text += body.items.map((item) => item.text).join("");
      cursor = body.nextCursor;
      calls += 1;
    } while (cursor);
    expect(calls).toBeGreaterThan(4);
    expect(text).toContain(long);
    expect((await get("/api/library/projects/game/long/read?cursor=bad")).status).toBe(400);
    expect((await get("/api/library/projects/game/long/read?page=nope")).status).toBe(404);
    expect((await get("/api/library/projects/game/long/read?version=99")).status).toBe(404);
  });

  test("view returns a thumbnail by default, a larger render on request, and only for a real frame", async () => {
    const view = LibraryView.parse(
      await (await get("/api/library/projects/game/art-styles/view?frame=gouache")).json(),
    );
    expect(view).toMatchObject({ frame: "gouache", size: "thumb" });
    const picture = await get(view.image as string);
    expect(picture.status).toBe(200);
    expect(picture.headers.get("content-type")).toContain("image/webp");
    const big = LibraryView.parse(
      await (await get("/api/library/projects/game/art-styles/view?frame=gouache&size=2x")).json(),
    );
    expect(big.size).toBe("2x");
    expect((await get("/api/library/projects/game/art-styles/view?frame=none")).status).toBe(404);
    expect((await get("/api/library/projects/game/art-styles/view?size=huge")).status).toBe(400);
  });

  test("a substring title hit ranks before a weak body hit", async () => {
    await publish(t, owner, {
      project: "substring",
      slug: "notes",
      title: "Apigateway notes",
      blocks: [],
    });
    await publish(t, owner, {
      project: "substring",
      slug: "body",
      title: "Body notes",
      blocks: [{ key: "intro/p1", text: "the gateway is here" }],
    });
    const found = await search("gateway", owner, "&project=substring");
    expect(found.cards.map((card) => card.slug)).toEqual(["notes", "body"]);
    expect(found.cards[0]?.match?.source).toBe("title");
    const first = await search("gateway", owner, "&project=substring&limit=1");
    const second = await search("gateway", owner, `&project=substring&limit=1&cursor=${first.nextCursor}`);
    expect([...first.cards, ...second.cards]).toEqual(found.cards);
  });

  test("a card has a fixed maximum size, whatever is in it", async () => {
    const worst = "\u{1F600}".repeat(SUMMARY_MAX / 2);
    const tags = Array.from({ length: TAGS_MAX }, (_, i) => `${i}`.padEnd(TAG_MAX, '"'));
    await publish(t, owner, {
      project: "budget-project-with-a-rather-long-name",
      slug: "budget-artifact-with-a-rather-long-name",
      title: "T".repeat(120),
      summary: worst,
      tags,
      blocks: [{ key: "intro/p1", text: `needle ${'"'.repeat(5000)}` }],
    });
    const { cards } = await search("needle");
    const card = LibraryCard.parse(cards[0]);
    expect(card.match?.snippet.length).toBeLessThanOrEqual(200);
    // Quotes double when escaped, so this is the true worst case, not a typical card.
    expect(JSON.stringify(card).length).toBeLessThanOrEqual(1800);

    const project = "budget-wiki-with-a-rather-long-name";
    expect(
      (await t.api("/api/wikis", { method: "POST", bearer: owner, json: { slug: project, name: "Budget" } }))
        .status,
    ).toBe(201);
    const origin = `https://example.com/${'"'.repeat(1880)}`;
    expect(
      (
        await publish(t, owner, {
          project,
          slug: "budget-source-with-a-rather-long-name",
          title: '"'.repeat(120),
          summary: '"'.repeat(SUMMARY_MAX),
          tags,
          wiki: { role: "source", sources: [], untrusted: true, origin },
          blocks: [{ key: "intro/p1", text: `needle ${'"'.repeat(5000)}` }],
        })
      ).status,
    ).toBe(200);
    const source = LibraryCard.parse((await search("needle", owner, `&project=${project}`)).cards[0]);
    expect(source.origin).toBe(`${origin.slice(0, 199)}…`);
    expect(source.summary.endsWith("…")).toBe(true);
    expect(JSON.stringify(source).length).toBeLessThanOrEqual(1800);
    const wiki = WikiSpace.parse(await (await get(`/api/wikis/${project}`)).json());
    expect(wiki.sources[0]?.origin).toBe(origin);
    const { id } = await json<{ id: string }>(await get(`/api/artifacts/by-slug/${project}/${source.slug}`));
    const links = ArtifactLinks.parse(await (await get(`/api/artifacts/${id}/links`)).json());
    expect(links.origin).toBe(origin);
  });

  test("over-long frontmatter is refused at commit", async () => {
    const long = await publish(t, owner, { project: "game", slug: "too-long", summary: "x".repeat(281) });
    expect(long.status).toBe(400);
    const tags = await publish(t, owner, { project: "game", slug: "too-long", tags: Array(9).fill("x") });
    expect(tags.status).toBe(400);
  });

  test("a hundred results across pages stay inside a fixed budget", async () => {
    for (let i = 0; i < 100; i++) {
      await publish(t, owner, {
        project: "bulk",
        slug: `a-${i}`,
        title: `Lantern study ${i}`,
        summary: `Lantern study number ${i}, a comparison of light falloff.`.padEnd(280, "."),
        tags: ["lantern", "study"],
      });
    }
    let cursor: string | null = null;
    let total = 0;
    let size = 0;
    const seen = new Set<string>();
    do {
      const response: Response = await get(
        `/api/library/search?q=lantern&limit=20${cursor ? `&cursor=${cursor}` : ""}`,
      );
      const text = await response.text();
      const page = LibraryPage.parse(JSON.parse(text));
      expect(page.cards.length).toBeLessThanOrEqual(20);
      for (const card of page.cards) seen.add(card.slug);
      total += page.cards.length;
      size += text.length;
      cursor = page.nextCursor;
    } while (cursor);
    expect(total).toBe(100);
    expect(seen.size).toBe(100);
    // About 120 KB, or 30,000 tokens, in the worst case; a real result is a third of this.
    expect(size).toBeLessThan(100 * 900);
    const big = LibraryPage.parse(await (await get("/api/library/search?q=lantern&limit=500")).json());
    expect(big.cards).toHaveLength(50);
  }, 120_000);

  test("search's limit counts for an agent's cards too", async () => {
    const flood = (await makePerson(t, orgId, "member")).token;
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++)
      statuses.push((await get("/api/library/search?q=lantern&limit=1", flood)).status);
    expect(statuses).toEqual([...Array(60).fill(200), 429]);
  }, 60_000);

  test("a bundle lists a version's files, with links that need no token", async () => {
    const bundle = VersionBundle.parse(await (await get("/api/library/projects/legacy/old/bundle")).json());
    expect(bundle.rebuilt).toBe(true);
    expect(bundle.manifest).toMatchObject({ project: "legacy", slug: "old" });
    const file = bundle.files.find((entry) => entry.path === "index.html");
    expect(await (await fetch(file?.url as string)).text()).toContain("<h1>");
    expect((await get("/api/library/projects/legacy/old/bundle?version=7")).status).toBe(404);
  });

  test("a path that could climb out of a folder is refused at commit", async () => {
    for (const path of ["../evil.sh", "/etc/passwd", "a/../../b", ".git/hooks/pre-commit", "a\\b"]) {
      const response = await publish(t, owner, {
        project: "game",
        slug: "paths",
        files: [file("index.html", "<p>"), file(path, "x", "text/plain")],
      });
      expect(response.status).toBe(400);
    }
  });

  test("decisions list every decision on an artifact, newest first", async () => {
    const { id } = (await (await get("/api/artifacts/by-slug/legacy/old")).json()) as { id: string };
    const list = async () => DecisionList.parse(await json(await get(`/api/artifacts/${id}/decisions`)));
    expect(await list()).toEqual([]);
    const decide = (kind: string, note?: string) =>
      t.api(`/api/artifacts/${id}/decisions`, { method: "POST", cookie, json: { version: 1, kind, note } });
    expect((await decide("changes_requested", "Not yet")).status).toBe(200);
    t.clock.advance(1000);
    expect((await decide("approved")).status).toBe(200);
    expect((await list()).map(({ kind, note, by, version }) => ({ kind, note, by, version }))).toEqual([
      { kind: "approved", note: null, by: "Zahin", version: 1 },
      { kind: "changes_requested", note: "Not yet", by: "Zahin", version: 1 },
    ]);
  });
});
