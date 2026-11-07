import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { cli, sandbox } from "./run.ts";

const ID = "6f1c7c9e-3a52-4d4e-9d0a-2b7d6c5a1e10";
const TEAM = "7a1c7c9e-3a52-4d4e-9d0a-2b7d6c5a1e11";
const NOW = "2026-11-07T10:00:00.000Z";

type Seen = { method: string; path: string; body: unknown };
let seen: Seen[] = [];
let refuse = false;

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const text = await request.text();
    seen.push({ method: request.method, path: url.pathname, body: text ? JSON.parse(text) : undefined });
    if (url.pathname === "/api/artifacts/by-slug/brain/pricing") {
      return Response.json({
        id: ID,
        project: "brain",
        slug: "pricing",
        title: "Pricing",
        cover: { title: "Pricing" },
        pageCount: 1,
        latestVersion: 7,
        status: { kind: "not_reviewed" },
        counts: { open: 0, repliesToYou: 0, changedFrames: 0 },
        publishedBy: "Sam",
        agent: null,
        publishedAt: NOW,
        archivedAt: null,
        visibility: "org",
        publisherId: ID,
        hasBackend: false,
        pages: [],
        decision: null,
        permissions: { comment: true, manage: true, share: true, delete: true, purge: true },
      });
    }
    if (url.pathname === "/api/teams/design")
      return Response.json({
        team: { id: TEAM, slug: "design", name: "Design", description: null, members: 2 },
        members: [],
        shared: [],
        permissions: { manage: false, members: false },
      });
    if (refuse && request.method !== "GET")
      return Response.json(
        { error: { code: "forbidden", message: "You can't do that.", details: {} } },
        { status: 403 },
      );
    if (url.pathname === `/api/artifacts/${ID}/access`) return Response.json({ added: true });
    return Response.json({});
  },
});
afterAll(() => server.stop(true));

const box = sandbox();
const env = { ...box.env, ARTIFACTS_URL: `http://127.0.0.1:${server.port}`, ARTIFACTS_TOKEN: "art_test" };
beforeEach(() => {
  seen = [];
  refuse = false;
});

describe("share --edit", () => {
  test("sends edit for a person and for a team", async () => {
    const person = await cli(["share", "brain/pricing", "--invite", "sam@example.com", "--edit"], env);
    expect(person.code).toBe(0);
    expect(person.stdout).toContain("sam@example.com can edit Pricing");
    expect(seen.at(-1)).toMatchObject({
      method: "POST",
      path: `/api/artifacts/${ID}/access`,
      body: { email: "sam@example.com", permission: "edit" },
    });
    const team = await cli(["share", "brain/pricing", "--team", "design", "--edit"], env);
    expect(team.code).toBe(0);
    expect(seen.at(-1)).toMatchObject({
      method: "PUT",
      path: `/api/artifacts/${ID}/teams/${TEAM}`,
      body: { permission: "edit" },
    });
  });

  test("the server's refusal of a token becomes a pointer to the Share sheet", async () => {
    refuse = true;
    for (const args of [
      ["--invite", "sam@example.com", "--edit"],
      ["--team", "design", "--edit"],
    ]) {
      const result = await cli(["share", "brain/pricing", ...args], env);
      expect(result.code).toBe(1);
      expect(result.stderr.trim()).toBe("Only a person can give edit access. Use the Share sheet.");
    }
    // A script reading --json gets the server's own error.
    const json = await cli(["share", "brain/pricing", "--team", "design", "--edit", "--json"], env);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stderr).error.code).toBe("forbidden");
    // Any other refusal keeps the server's words.
    const other = await cli(["share", "brain/pricing", "--invite", "sam@example.com", "--comment"], env);
    expect(other.code).toBe(1);
    expect(other.stderr.trim()).toBe("You can't do that.");
  });

  test("a link never carries edit, and edit doesn't mix with the other levels", async () => {
    for (const args of [
      ["--link", "--edit"],
      ["--invite", "a@b.co", "--edit", "--publish"],
      ["--invite", "a@b.co", "--edit", "--comment"],
    ]) {
      expect((await cli(["share", "brain/pricing", ...args], env)).code).toBe(2);
    }
    expect(seen).toEqual([]);
  });
});
