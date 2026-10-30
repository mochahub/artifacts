import { VERSION } from "../version.ts";

type Tool = {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
  args(input: Record<string, unknown>): string[];
};

const target = { type: "string", description: "project/artifact, or nothing for this folder's artifact" };
const optional = (value: unknown) => (typeof value === "string" && value ? [value] : []);

/** Each tool is one CLI command with --json, so tools without a shell behave the same as those with one. */
const TOOLS: Tool[] = [
  {
    name: "artifacts_status",
    description: "The latest decision, the note, and the open comments on an artifact.",
    properties: { artifact: target },
    args: ({ artifact }) => ["status", ...optional(artifact)],
  },
  {
    name: "artifacts_comments",
    description: "The comments on an artifact.",
    properties: { artifact: target },
    args: ({ artifact }) => ["comments", ...optional(artifact)],
  },
  {
    name: "artifacts_reply",
    description: "Reply to a comment. Set fixed when a published version addresses it.",
    properties: {
      n: { type: "number", description: "The comment's number, as in artifacts_comments" },
      message: { type: "string", description: "The reply" },
      fixed: { type: "boolean", description: "Mark it fixed" },
    },
    required: ["n", "message"],
    args: ({ n, message, fixed }) => ["reply", String(n), String(message), ...(fixed ? ["--fixed"] : [])],
  },
  {
    name: "artifacts_publish",
    description: "Lint, render and publish the artifact in the working folder.",
    properties: { message: { type: "string", description: "What changed" } },
    required: ["message"],
    args: ({ message }) => ["publish", "-m", String(message)],
  },
  {
    name: "artifacts_versions",
    description: "The versions of the artifact in the working folder.",
    properties: {},
    args: () => ["versions"],
  },
  {
    name: "artifacts_data_export",
    description: "Everything a micro app has saved, for reading results.",
    properties: {},
    args: () => ["data", "export"],
  },
];

async function callTool(tool: Tool, input: Record<string, unknown>) {
  const self = process.argv[1]?.endsWith(".ts") ? [process.execPath, process.argv[1]] : [process.execPath];
  const child = Bun.spawn([...self, ...tool.args(input), "--json"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    content: [{ type: "text", text: (out || err).trim() }],
    ...(code === 0 ? {} : { isError: true }),
  };
}

async function answer(request: { id?: unknown; method: string; params?: Record<string, unknown> }) {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "artifacts", version: VERSION },
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOLS.map(({ name, description, properties, required }) => ({
          name,
          description,
          inputSchema: { type: "object", properties, required: required ?? [] },
        })),
      };
    case "tools/call": {
      const tool = TOOLS.find((entry) => entry.name === request.params?.name);
      if (!tool) throw Object.assign(new Error("No such tool."), { code: -32602 });
      return callTool(tool, (request.params?.arguments ?? {}) as Record<string, unknown>);
    }
    default:
      throw Object.assign(new Error("No such method."), { code: -32601 });
  }
}

/** `artifacts mcp`: a Model Context Protocol server on stdin and stdout, one JSON message a line. */
export async function mcpCommand() {
  const send = (message: object) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  let pending = "";
  for await (const chunk of process.stdin) {
    pending += Buffer.from(chunk).toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let request: Parameters<typeof answer>[0];
      try {
        request = JSON.parse(line);
      } catch {
        send({ id: null, error: { code: -32700, message: "That isn't JSON." } });
        continue;
      }
      // A notification has no id and gets no answer.
      if (request.id === undefined) continue;
      await answer(request).then(
        (result) => send({ id: request.id, result }),
        (error) => send({ id: request.id, error: { code: error.code ?? -32603, message: error.message } }),
      );
    }
  }
}
