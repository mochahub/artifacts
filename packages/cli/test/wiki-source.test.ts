import { expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, sandbox, start } from "./run.ts";

const ID = "6f1c7c9e-3a52-4d4e-9d0a-2b7d6c5a1e10";
const UPLOAD = "0b6c2b1e-8f0e-4c5a-a1c4-5f3c2d1e9a77";
test("CLI and local MCP queue while OFF, transfer bytes and preserve file retry identity", async () => {
  const box = sandbox();
  const requests: {
    path: string;
    body: { source: { kind: string; text?: string; title?: string }; note?: string; name?: string };
    authorization: string | null;
  }[] = [];
  let put = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      const path = new URL(req.url).pathname;
      if (req.method === "PUT") {
        put = await req.text();
        expect(req.headers.get("authorization")).toBeNull();
        return new Response(null, { status: 200 });
      }
      const body = (await req.json()) as {
        source: { kind: string; text?: string; title?: string };
        note?: string;
        name?: string;
      };
      requests.push({ path, body, authorization: req.headers.get("authorization") });
      if (path.endsWith("/uploads"))
        return Response.json({
          uploadId: UPLOAD,
          url: `${server.url}quarantine`,
          headers: { "Content-Type": "text/markdown" },
        });
      if (body.note === "conflict")
        return Response.json(
          { error: { code: "conflict", message: "Idempotency key already used.", details: {} } },
          { status: 409 },
        );
      return Response.json(
        {
          id: ID,
          wikiId: ID,
          kind: body.source.kind,
          title: body.source.title ?? "Source",
          status: "queued",
          submittedAt: "2026-11-07T10:00:00.000Z",
          message: "Saved to inbox. Librarian is off.",
        },
        { status: 202 },
      );
    },
  });
  try {
    const url = String(server.url).replace(/\/$/, "");
    const config = join(box.env.XDG_CONFIG_HOME ?? "", "artifacts");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, "config.json"),
      JSON.stringify({ servers: [{ url, name: "mock", default: true }] }),
    );
    writeFileSync(join(config, "credentials.json"), JSON.stringify({ [url]: "private-mock-token" }));
    const file = join(box.home, "private-name.md");
    writeFileSync(file, "# untrusted source");
    const args = ["wiki", "add", "brain", "--file", file, "--request-id", ID, "--json"];
    for (let i = 0; i < 2; i++) {
      const result = await cli(args, box.env);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "queued",
        requestId: ID,
        message: "Saved to inbox. Librarian is off.",
      });
      expect(result.stdout).not.toContain(box.home);
    }
    expect(put).toBe("# untrusted source");
    expect(requests.filter((r) => r.path.endsWith("/uploads"))).toHaveLength(1);
    expect(requests[0]?.body.name).toBe("source.md");
    expect(requests.at(-1)?.body).toMatchObject({
      source: { kind: "file", uploadId: UPLOAD },
      idempotencyKey: ID,
    });
    writeFileSync(file, "changed");
    expect((await cli(args, box.env)).code).toBe(1);
    const text = await cli(
      ["wiki", "add", "brain", "--text-file", file, "--title", "Notes", "--json"],
      box.env,
    );
    expect(text.code).toBe(0);
    expect(requests.at(-1)?.body.source).toEqual({ kind: "text", title: "Notes", text: "changed" });
    const conflict = await cli(
      ["wiki", "add", "brain", "--url", "https://example.test/notes", "--note", "conflict", "--json"],
      box.env,
    );
    expect(conflict.code).toBe(1);
    expect(JSON.parse(conflict.stderr.trim().split("\n").at(-1) ?? "").error.code).toBe("conflict");
    const child = start(["mcp"], box.env);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "artifacts_source_add",
          arguments: {
            wiki: "brain",
            idempotencyKey: ID,
            source: { kind: "url", url: "https://example.test/notes" },
          },
        },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "artifacts_source_add",
          arguments: { wiki: "brain", idempotencyKey: ID, source: { kind: "file", path: "/server/secret" } },
        },
      })}\n`,
    );
    child.stdin.end();
    const output = (await new Response(child.stdout).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(await child.exited).toBe(0);
    expect(
      output[0].result.tools.find((t: { name: string }) => t.name === "artifacts_source_add"),
    ).toBeDefined();
    expect(JSON.parse(output[1].result.content[0].text).status).toBe("queued");
    expect(output[2].result.isError).toBe(true);
    expect(JSON.parse(output[2].result.content[0].text).error.code).toBe("invalid");
  } finally {
    server.stop(true);
    rmSync(box.home, { recursive: true, force: true });
  }
});

test("source validation precedes sign-in and rejects unsafe or ambiguous inputs", async () => {
  const box = sandbox();
  try {
    const file = join(box.home, "source.md");
    writeFileSync(file, "hello");
    const link = join(box.home, "link.md");
    symlinkSync(file, link);
    for (const flags of [
      [],
      ["--url", "http://example.test"],
      ["--url", "https://127.0.0.1"],
      ["--url", "https://user:pass@example.test"],
      ["--url", "https://example.test", "--file", file],
      ["--text-file", file],
      ["--file", link],
      ["--url", "https://example.test", "--request-id", "wrong"],
      ["--url", "https://example.test", "--note", "x".repeat(2001)],
    ]) {
      const result = await cli(["wiki", "add", "brain", ...flags, "--json"], box.env);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr).error.code).toBe("invalid");
    }
  } finally {
    rmSync(box.home, { recursive: true, force: true });
  }
});
