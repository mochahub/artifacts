import { describe, expect, test } from "bun:test";
import { toolCommand } from "../src/commands/mcp.ts";
import { sandbox, start } from "./sandbox.ts";

describe("artifacts mcp", () => {
  test("a tool's arguments can't become flags", () => {
    expect(toolCommand("artifacts_status", { artifact: "a/b" })).toEqual(["--json", "status", "a/b"]);
    expect(() => toolCommand("artifacts_status", { artifact: "--server=https://evil.test" })).toThrow();
    expect(() => toolCommand("artifacts_comments", { artifact: "-x" })).toThrow();
    expect(toolCommand("artifacts_reply", { n: 3, message: "--fixed" })).toEqual([
      "--json",
      "reply",
      "--",
      "3",
      "--fixed",
    ]);
    expect(toolCommand("artifacts_reply", { n: 3, message: "- done", fixed: true })).toEqual([
      "--json",
      "reply",
      "--fixed",
      "--",
      "3",
      "- done",
    ]);
    expect(() => toolCommand("artifacts_reply", { n: "--server=x", message: "m" })).toThrow();
    expect(() => toolCommand("artifacts_reply", { n: 1 })).toThrow();
    expect(toolCommand("artifacts_publish", { message: "-1 bug" })).toEqual([
      "--json",
      "publish",
      "--message=-1 bug",
    ]);
  });

  test("speaks MCP on stdio and turns tool calls into commands", async () => {
    const box = sandbox();
    const child = start(["mcp"], box.env);
    const send = (message: object) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    send({ id: 1, method: "initialize", params: {} });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    send({
      id: 3,
      method: "tools/call",
      params: { name: "artifacts_status", arguments: { artifact: "a/b" } },
    });
    send({ id: 4, method: "tools/call", params: { name: "nope" } });
    send({ id: 5, method: "nope" });
    child.stdin.write("null\n");
    send({ id: 6, method: "ping" });
    child.stdin.end();
    const lines = (await new Response(child.stdout).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const by = (id: number) => lines.find((line) => line.id === id);
    expect(by(1).result.serverInfo.name).toBe("artifacts");
    expect(by(2).result.tools.map((tool: { name: string }) => tool.name)).toContain("artifacts_reply");
    expect(by(3).result.isError).toBe(true);
    expect(by(4).error.code).toBe(-32602);
    expect(by(5).error.code).toBe(-32601);
    expect(by(6).result).toEqual({});
  }, 30_000);
});
