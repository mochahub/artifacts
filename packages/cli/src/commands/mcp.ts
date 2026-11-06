import { readFileSync, rmSync } from "node:fs";
import { LibraryProjects, UNTRUSTED_NOTICE } from "@artifacts/schema";
import {
  MCP_GUIDANCE as GUIDANCE,
  libraryTools,
  MCP_LEGACY,
  MCP_MAX_IMAGE,
  MCP_MODERN,
  MCP_SERVER_INFO_META,
  MCP_SERVER_NAME,
  type McpProperty,
  type McpToolSpec,
  REPLY_INPUT,
  REVIEW_TOOLS,
} from "@artifacts/schema/mcp";
import { gitRepo, repoRoot } from "../git.ts";
import { findClient } from "../session.ts";
import { VERSION } from "../version.ts";
import { commandNamed } from "./table.ts";

/** `--name=<value>`, for a flag the command declares in the table, and only in the expected form. */
type Flag = (name: string, value: unknown, form: RegExp, label: string) => string[];

/** A tool here is one CLI command, and the arguments a model gave it become that command's arguments. */
type Tool = McpToolSpec & { command: string; args(input: Record<string, unknown>, flag: Flag): string[] };

const target: McpProperty = {
  type: "string",
  description: "project/artifact, or nothing for this folder's artifact",
};

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
const requiredArtifact = (value: unknown) => {
  if (value === undefined || value === "") throw new BadArguments("artifact is required.");
  return artifactArg(value);
};
const listPath = (value: unknown) => {
  if (typeof value === "string" && LIST_PATH.test(value)) return [value];
  throw new BadArguments("path must look like project, project/artifact or project/artifact/page.");
};

/** One argument whatever it holds, so a value can't become a second flag. */
const flagFor =
  (command: string): Flag =>
  (name, value, form, label) => {
    if (commandNamed(command)?.options[name]?.type !== "string")
      throw new Error(`${command} has no --${name}`);
    if (value === undefined || value === "" || value === null) return [];
    const text = String(value);
    if (!form.test(text)) throw new BadArguments(`${label} isn't valid.`);
    return [`--${name}=${text}`];
  };
const KEY = /^[a-z0-9][a-z0-9-]{0,59}$/;
const CURSOR = /^[A-Za-z0-9:_-]{1,40}$/;
const NUMBER = /^\d{1,9}$/;
const REPO = /^[\w@:/.+%~-]{1,300}$/;
const LIST_PATH = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*){0,2}$/;
const limitAndCursor = (input: Record<string, unknown>, flag: Flag) => [
  ...flag("limit", input.limit, NUMBER, "limit"),
  ...flag("cursor", input.cursor, CURSOR, "cursor"),
];
const library = libraryTools({
  type: "string",
  description: "A git remote, to look only at that repo's project",
});

/** Each tool is one CLI command with --json, so tools without a shell behave the same as those with one. */
const TOOLS: Tool[] = [
  {
    ...library.search,
    command: "search",
    args: (input, flag) => [
      ...flag("project", input.project, KEY, "project"),
      ...flag("repo", input.repo, REPO, "repo"),
      ...limitAndCursor(input, flag),
      "--",
      text(input.query, "query"),
    ],
  },
  {
    ...library.list,
    command: "list",
    args: (input, flag) => [
      ...flag("repo", input.repo, REPO, "repo"),
      ...limitAndCursor(input, flag),
      ...(input.path ? ["--", ...listPath(input.path)] : []),
    ],
  },
  {
    ...library.read,
    command: "read",
    args: (input, flag) => [
      ...flag("page", input.page, KEY, "page"),
      ...flag("cursor", input.cursor, CURSOR, "cursor"),
      ...flag("version", input.version, NUMBER, "version"),
      ...requiredArtifact(input.artifact),
    ],
  },
  {
    ...library.view,
    command: "view",
    args: (input, flag) => [
      ...flag("page", input.page, KEY, "page"),
      ...flag("frame", input.frame, /^[a-z0-9-]{1,100}$/, "frame"),
      ...flag("size", input.size, /^(thumb|1x|2x)$/, "size"),
      ...requiredArtifact(input.artifact),
    ],
  },
  {
    ...REVIEW_TOOLS.status,
    command: "status",
    properties: { artifact: target },
    args: ({ artifact }) => artifactArg(artifact),
  },
  {
    ...REVIEW_TOOLS.comments,
    command: "comments",
    properties: { artifact: target },
    args: ({ artifact }) => artifactArg(artifact),
  },
  {
    ...REVIEW_TOOLS.reply,
    command: "reply",
    properties: {
      n: { type: "number", description: "The comment's number, as in artifacts_comments" },
      ...REPLY_INPUT,
    },
    required: ["n", "message"],
    args: ({ n, message, fixed }) => {
      if (!Number.isInteger(n) || (n as number) < 1) throw new BadArguments("n must be a comment number.");
      return [...(fixed === true ? ["--fixed"] : []), "--", String(n), text(message, "message")];
    },
  },
  {
    name: "artifacts_publish",
    description: "Lint, render and publish the artifact in the working folder.",
    command: "publish",
    properties: { message: { type: "string", description: "What changed" } },
    required: ["message"],
    args: ({ message }, flag) => flag("message", text(message, "message"), /^/, "message"),
  },
  {
    ...REVIEW_TOOLS.versions,
    description: "The versions of the artifact in the working folder.",
    command: "versions",
    properties: {},
    args: () => [],
  },
  {
    name: "artifacts_data_export",
    description: "Everything a micro app has saved, for reading results.",
    command: "data",
    properties: {},
    untrusted: true,
    args: () => ["export"],
  },
];

/** What a tool runs. --json goes first, because everything after a -- is taken literally. */
export function toolCommand(name: string, input: Record<string, unknown>) {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) return null;
  return ["--json", tool.command, ...tool.args(input, flagFor(tool.command))];
}

/** A model reads everything a tool prints, so one big answer (a data export) can't fill its context. */
const MAX_OUTPUT = 100_000;
export function capOutput(text: string) {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n… cut off, ${text.length - MAX_OUTPUT} more characters. Run the command in a shell to read it all.`;
}

/** A local path comes back from `view`; the model gets the picture itself. */
function imageResult(output: string) {
  const { path, ...about } = JSON.parse(output) as { path: string };
  try {
    const image = readFileSync(path);
    if (image.length > MCP_MAX_IMAGE) {
      return {
        content: [{ type: "text", text: "That picture is too big to return. Ask for a smaller size." }],
        isError: true,
      };
    }
    return {
      content: [
        { type: "text", text: JSON.stringify(about) },
        { type: "image", data: image.toString("base64"), mimeType: "image/webp" },
      ],
    };
  } finally {
    rmSync(path, { force: true });
  }
}

async function callTool(name: string, args: string[]) {
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
  if (name === "artifacts_view" && code === 0) return imageResult(out);
  const untrusted = TOOLS.find((tool) => tool.name === name)?.untrusted && code === 0;
  return {
    content: [
      ...(untrusted ? [{ type: "text", text: UNTRUSTED_NOTICE }] : []),
      { type: "text", text: capOutput((out || err).trim()) },
    ],
    ...(code === 0 ? {} : { isError: true }),
  };
}

const CORE = [
  GUIDANCE.library,
  `${GUIDANCE.searchFirst}; earlier work may already answer the question, including experiments that were dropped.`,
  GUIDANCE.reading,
  GUIDANCE.untrusted,
  GUIDANCE.decisions,
  GUIDANCE.publish(" with artifacts_publish"),
  `${GUIDANCE.prototype}.`,
  GUIDANCE.sharing,
];
const GIVE_UP_MS = 2000;

/** The core rules, plus this repo's project when it's quick to find out. It must never hold up a client. */
export async function instructions(cwd = process.cwd()) {
  const lookup = async () => {
    const repo = gitRepo(repoRoot(cwd));
    if (!repo) return null;
    const client = await findClient();
    if (!client) return null;
    const { projects } = LibraryProjects.parse(
      await client.get(`/api/library/projects?repo=${encodeURIComponent(repo)}`),
    );
    if (projects.length === 0) return null;
    return projects.map((project) => `${project.slug} (${project.artifacts} artifacts)`).join(", ");
  };
  const found = await Promise.race([
    lookup().catch(() => null),
    new Promise<null>((resolve) => setTimeout(resolve, GIVE_UP_MS, null)),
  ]);
  return [...CORE, ...(found ? [`This repo's project: ${found}.`] : [])].join(" ");
}

async function answer(request: { id?: unknown; method: string; params?: Record<string, unknown> }) {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: MCP_LEGACY.includes(request.params?.protocolVersion as string)
          ? request.params?.protocolVersion
          : MCP_LEGACY[0],
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: VERSION },
        instructions: await instructions(),
      };
    // The current revision has no handshake: a client asks this, or goes straight to a request.
    case "server/discover":
      return {
        resultType: "complete",
        supportedVersions: [MCP_MODERN, ...MCP_LEGACY],
        capabilities: { tools: {} },
        _meta: { [MCP_SERVER_INFO_META]: { name: MCP_SERVER_NAME, version: VERSION } },
        instructions: await instructions(),
        ttlMs: 60_000,
        cacheScope: "private",
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
        return await callTool(String(request.params?.name), args);
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
