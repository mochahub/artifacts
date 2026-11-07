import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI_SCOPES } from "@artifacts/schema";
import { tokens, versions } from "../../src/db/schema.ts";
import { claim, mcp, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { makeAccount } from "../publish-helper.ts";

/**
 * 13, "The socket": what `GET /api/artifacts/:id/doc/sync` answers before any upgrade. The sockets
 * themselves are in replicas.test.ts.
 */
describe("the sync route", () => {
  let t: TestServer;
  let token: string;
  let cookie: string;
  let reader: string;
  let id: string;

  beforeAll(async () => {
    t = await startTestServer();
    const claimed = await claim(t);
    token = claimed.token;
    cookie = await signIn(t, OWNER.email, OWNER.password);
    await t.server.db.update(tokens).set({ scopes: [...CLI_SCOPES] });
    await t.api("/api/wikis", { method: "POST", bearer: token, json: { slug: "brain", name: "Brain" } });
    await mcp(t, token, "tools/call", {
      name: "artifacts_publish_article",
      arguments: {
        project: "brain",
        slug: "pricing",
        title: "Pricing",
        summary: "How we price.",
        markdown: "# Pricing\n\nOne.\n",
      },
    });
    const [row] = await t.server.db.select({ id: versions.artifactId }).from(versions).limit(1);
    id = row?.id as string;
    reader = (await makeAccount(t, claimed.orgId, "member")).cookie;
  });
  afterAll(() => t.stop());

  const sync = (headers: Record<string, string>, auth: { cookie?: string; bearer?: string }) =>
    t.api(`/api/artifacts/${id}/doc/sync`, { headers, ...auth });

  test("an editor from a viewer origin, but not a WebSocket: 426", async () => {
    expect((await sync({ Origin: "http://viewer.test" }, { cookie })).status).toBe(426);
  });

  test("no Origin, or another site's: 403, before any upgrade", async () => {
    expect((await sync({}, { cookie })).status).toBe(403);
    expect((await sync({ Origin: "https://evil.example" }, { cookie })).status).toBe(403);
  });

  test("a token: 403, because agents edit by operation", async () => {
    expect((await sync({ Origin: "http://viewer.test" }, { bearer: token })).status).toBe(403);
  });

  test("someone who can read but not edit: 403; an unknown page: 404", async () => {
    expect((await sync({ Origin: "http://viewer.test" }, { cookie: reader })).status).toBe(403);
    const unknown = await t.api(`/api/artifacts/${Bun.randomUUIDv7()}/doc/sync`, {
      headers: { Origin: "http://viewer.test" },
      cookie,
    });
    expect(unknown.status).toBe(404);
  });
});
