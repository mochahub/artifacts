import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { claim, json, startTestServer } from "../../test/helpers.ts";
import { librarianWikis, projects } from "../db/schema.ts";

test("hosted MCP source_add registers, queues while OFF, replays and enforces ingestion guards", async () => {
  const t = await startTestServer();
  try {
    const setup = await claim(t);
    const created = await t.api("/api/wikis", {
      bearer: setup.token,
      method: "POST",
      json: { slug: "inbox-qa", name: "Private inbox QA" },
    });
    expect(created.status).toBe(201);
    const [wiki] = await t.server.db.select().from(projects).where(eq(projects.slug, "inbox-qa"));
    if (!wiki) throw new Error("Missing QA wiki");
    await t.server.db
      .insert(librarianWikis)
      .values({ orgId: setup.orgId, projectId: wiki.id, selectedBy: setup.person.id });
    const call = (method: string, params: unknown) =>
      t.api("/api/mcp", {
        bearer: setup.token,
        method: "POST",
        json: { jsonrpc: "2.0", id: 1, method, params },
      });
    const list = await json<{ result: { tools: { name: string; inputSchema: { required: string[] } }[] } }>(
      await call("tools/list", {}),
    );
    expect(
      list.result.tools.find(
        (x: { name: string; inputSchema: { required: string[] } }) => x.name === "artifacts_source_add",
      )?.inputSchema.required,
    ).toContain("idempotencyKey");
    const input = {
      wiki: "inbox-qa",
      idempotencyKey: crypto.randomUUID(),
      source: { kind: "text", text: "untrusted notes", title: "Notes" },
    };
    const run = async (args: unknown) =>
      (
        await json<{ result: { isError?: boolean; content: { text: string }[] } }>(
          await call("tools/call", { name: "artifacts_source_add", arguments: args }),
        )
      ).result;
    const first = await run(input);
    expect(first.isError).toBeUndefined();
    const item = JSON.parse(first.content[0]?.text ?? "{}");
    expect(item).toMatchObject({ status: "queued", message: "Saved to inbox. Librarian is off." });
    expect(JSON.parse((await run(input)).content[0]?.text ?? "{}").id).toBe(item.id);
    for (const bad of [
      { ...input, note: "changed" },
      { ...input, source: { kind: "file", path: "/server/private" } },
      { ...input, source: { kind: "url", url: "http://localhost" } },
    ]) {
      const result = await run(bad);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]?.text ?? "{}").error.code).toBeDefined();
    }
    await t.server.db.delete(librarianWikis).where(eq(librarianWikis.projectId, wiki.id));
    const denied = await run(input);
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0]?.text ?? "{}").error.code).toBe("not_found");
  } finally {
    await t.stop();
  }
});
