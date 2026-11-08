import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BOARD_TOOLS } from "@artifacts/schema/mcp";
import { claim, mcp, startTestServer, type TestServer } from "./helpers.ts";

/**
 * Board tools on the hosted MCP (14, "Hosted MCP tools"): names, scopes, untrusted answers, and the
 * refusals that come before any board content. Batch application is covered as a pure plan in
 * boards-ops.test.ts; the seeded-draft paths join here once board drafts can be seeded.
 */
describe("board MCP tools", () => {
  let t: TestServer;
  let token: string;
  type Call = { content: { text: string }[]; isError?: boolean };
  const call = async (name: string, args: object, bearer = token) => {
    const r = await mcp(t, bearer, "tools/call", { name, arguments: args });
    const body = (await r.json()) as { result?: Call; error?: { code: number; message: string } };
    return { status: r.status, ...(body.result ?? { content: [], isError: true }), error: body.error };
  };
  const text = (r: Call) => r.content.at(-1)?.text ?? "";

  beforeAll(async () => {
    t = await startTestServer();
    ({ token } = await claim(t));
    const r = await t.api("/api/wikis", {
      method: "POST",
      bearer: token,
      json: { slug: "mine", name: "mine", onlyMe: true },
    });
    expect(r.status).toBe(201);
    const published = await call("artifacts_publish_article", {
      project: "mine",
      slug: "notes",
      title: "Notes",
      summary: "A page.",
      markdown: "# Notes\n\nSome text.\n",
    });
    expect(published.isError).toBeFalsy();
  }, 30_000);
  afterAll(() => t.stop());

  test("every board tool is listed by its fixed name, and every answer is marked untrusted", async () => {
    const r = await mcp(t, token, "tools/list", {});
    const { result } = (await r.json()) as {
      result: { tools: { name: string; inputSchema: { required: string[] } }[] };
    };
    const names = result.tools.map((tool) => tool.name);
    for (const spec of Object.values(BOARD_TOOLS)) {
      expect(names).toContain(spec.name);
      expect(spec.untrusted).toBe(true);
      expect(spec.name.startsWith("artifacts_board_")).toBe(true);
    }
    const edit = result.tools.find((tool) => tool.name === "artifacts_board_edit");
    expect(edit?.inputSchema.required).toEqual(["artifact", "epoch", "requestId", "ops"]);
  });

  test("a malformed batch is refused with zod's words, before any lookup of content", async () => {
    const r = await call("artifacts_board_edit", {
      artifact: "mine/notes",
      epoch: 1,
      requestId: "nope",
      ops: [],
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("requestId");
    expect(text(r)).toContain("ops");
  });

  test("an article page isn't a board: edits and draft reads say so", async () => {
    const edit = await call("artifacts_board_edit", {
      artifact: "mine/notes",
      epoch: 1,
      requestId: crypto.randomUUID(),
      ops: [{ op: "delete", object: "~k3j9x0a1b2" }],
      bases: { "~k3j9x0a1b2": "000000000000" },
    });
    expect(edit.isError).toBe(true);
    expect(text(edit)).toMatch(/can't be edited|article/);
    const read = await call("artifacts_board_read", { artifact: "mine/notes", draft: true });
    expect(read.isError).toBe(true);
  });

  test("a checkpoint read of a page with no board has no objects and no draft data", async () => {
    const r = await call("artifacts_board_read", { artifact: "mine/notes" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain("never");
    const read = JSON.parse(text(r)) as {
      draft: boolean;
      objects: unknown[];
      suggestions: unknown[];
      epoch: number;
    };
    expect(read.draft).toBe(false);
    expect(read.objects).toEqual([]);
    expect(read.suggestions).toEqual([]);
    expect(read.epoch).toBe(0);
  });

  test("hidden artifacts are not found, never forbidden", async () => {
    const r = await call("artifacts_board_read", { artifact: "mine/nothing-here" });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toMatch(/forbidden|can't edit/i);
  });
});
