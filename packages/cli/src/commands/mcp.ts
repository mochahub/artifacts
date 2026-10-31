import { VERSION } from "../version.ts";

type Tool = {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
  args(input: Record<string, unknown>): string[];
};

const target = { type: "string", description: "project/artifact, or nothing for this folder's artifact" };

class BadArguments extends Error {}

/**
 * Arguments come from a model that may be reading someone's comment, so nothing here can become a
 * flag: a value like --server=https://evil.test would send the token there.
 */
const artifactArg = (value: unknown) => {
  if (value === undefined || value === "") return [];
  if (typeof value === "string" && /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(value)) return [value];
  throw new BadArguments("artifact must look like project/artifact.");
};
const text = (value: unknown, name: string) => {
  if (typeof value === "string" && value.trim()) return value;
  throw new BadArguments(`${name} is required.`);
};

/** Each tool is one CLI command with --json, so tools without a shell behave the same as those with one. */
const TOOLS: Tool[] = [
  {
    name: "artifacts_status",
    description: "The latest decision, the note, and the open comments on an artifact.",
    properties: { artifact: target },
    args: ({ artifact }) => ["status", ...artifactArg(artifact)],
  },
  {
    name: "artifacts_comments",
    description: "The comments on an artifact.",
    properties: { artifact: target },
    args: ({ artifact }) => ["comments", ...artifactArg(artifact)],
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
    args: ({ n, message, fixed }) => {
      if (!Number.isInteger(n) || (n as number) < 1) throw new BadArguments("n must be a comment number.");
      return ["reply", ...(fixed === true ? ["--fixed"] : []), "--", String(n), text(message, "message")];
    },
  },
  {
    name: "artifacts_publish",
    description: "Lint, render and publish the artifact in the working folder.",
    properties: { message: { type: "string", description: "What changed" } },
    required: ["message"],
    args: ({ message }) => ["publish", `--message=${text(message, "message")}`],
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

/** What a tool runs. --json goes first, because everything after a -- is taken literally. */
export function toolCommand(name: string, input: Record<string, unknown>) {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) return null;
  return ["--json", ...tool.args(input)];
}

/** A model reads everything a tool prints, so one big answer (a data export) can't fill its context. */
const MAX_OUTPUT = 100_000;
export function capOutput(text: string) {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n… cut off, ${text.length - MAX_OUTPUT} more characters. Run the command in a shell to read it all.`;
}

async function callTool(args: string[]) {
  // Run from a script, this needs Bun and the script; a compiled binary is the whole command.
  const script = process.argv[1] ?? "";
  const self =
    /\.(ts|js)$/.test(script) && !script.startsWith("/$bunfs")
      ? [process.execPath, script]
      : [process.execPath];
  const child = Bun.spawn([...self, ...args], {
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
    content: [{ type: "text", text: capOutput((out || err).trim()) }],
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
      try {
        const args = toolCommand(
          String(request.params?.name),
          (request.params?.arguments ?? {}) as Record<string, unknown>,
        );
        if (!args) throw Object.assign(new Error("No such tool."), { code: -32602 });
        return await callTool(args);
      } catch (error) {
        if (!(error instanceof BadArguments)) throw error;
        return { content: [{ type: "text", text: error.message }], isError: true };
      }
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
    // No message is anywhere near this long; a line that never ends would otherwise grow without bound.
    if (pending.length > 10_000_000) {
      pending = "";
      send({ id: null, error: { code: -32600, message: "That message is too long." } });
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let request: Parameters<typeof answer>[0];
      try {
        request = JSON.parse(line);
      } catch {
        send({ id: null, error: { code: -32700, message: "That isn't JSON." } });
        continue;
      }
      if (typeof request !== "object" || request === null) {
        send({ id: null, error: { code: -32600, message: "That isn't a request." } });
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
