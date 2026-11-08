import { readFileSync, rmSync } from "node:fs";
import { EditRequest, LibraryProjects, UNTRUSTED_NOTICE } from "@artifacts/schema";
import { BoardEditRequest } from "@artifacts/schema/boards";
import {
  BOARD_TOOLS,
  EDIT_TOOLS,
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
import { z } from "zod";
import { ApiCallError } from "../client.ts";
import { gitRepo, repoRoot } from "../git.ts";
import { findClient } from "../session.ts";
import { VERSION } from "../version.ts";
import { commandNamed } from "./table.ts";
import { SourceSubmission, submitSource } from "./wiki-source.ts";

/** `--name=<value>`, for a flag the command declares in the table, and only in the expected form. */
type Flag = (name: string, value: unknown, form: RegExp, label: string) => string[];

/** A tool here is one CLI command, and the arguments a model gave it become that command's arguments. */
type Tool = McpToolSpec & {
  command: string;
  args(input: Record<string, unknown>, flag: Flag): string[];
  /** Page text for the command's standard input, so a model's Markdown or operations never sit in an argument. */
  stdin?(input: Record<string, unknown>): string;
  /** The command's own text form is what a model should read, so it runs without --json. */
  plain?: boolean;
  /** The command prints its whole answer even when it exits 1 (a refused operation) or 2 (a board suggestion), as the hosted tool returns it. */
  answersOnRefusal?: boolean;
};

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR = /^[A-Za-z0-9:_-]{1,40}$/;
const NUMBER = /^\d{1,9}$/;
/** A board cursor binds the read it came from, so it is longer than a page cursor; it still rides as one argument. */
const BOARD_CURSOR = /^[^\s\0]{1,500}$/;
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

/** What a model sent as operations, checked here so a bad call fails before a process starts. */
const editOps = (input: Record<string, unknown>, suggest: boolean) => {
  const request = EditRequest.safeParse({ ops: input.ops, suggest: suggest || undefined });
  if (!request.success) {
    throw new BadArguments(
      request.error.issues.map((issue) => `ops.${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  }
  return JSON.stringify({ ops: request.data.ops });
};
const slugList = (flag: Flag, name: string, value: unknown, label: string) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new BadArguments(`${label} must be a list of slugs.`);
  return value.flatMap((item) => flag(name, item, KEY, label));
};
/** Everything `page edit` and `page suggest` take besides the operations. */
const editArgs = (input: Record<string, unknown>, flag: Flag) => [
  "--ops=-",
  ...flag("note", input.note, /^[^\0]{1,2000}$/s, "note"),
  ...slugList(flag, "source", input.sources, "sources"),
  ...(Array.isArray(input.fixes)
    ? (() => {
        if (!input.fixes.every((n) => Number.isInteger(n) && (n as number) > 0))
          throw new BadArguments("fixes must be comment numbers.");
        return input.fixes.length > 0 ? [`--fixes=${input.fixes.join(",")}`] : [];
      })()
    : []),
  ...flag("run", input.run, UUID, "run"),
];

/**
 * What a model sent as a board batch (14), checked here so a bad call fails before a process starts.
 * A request id or bases it leaves out are the command's to fill, as they are for a person.
 */
const boardOps = (input: Record<string, unknown>, suggest: boolean) => {
  const { artifact: _artifact, ...rest } = input;
  const request = BoardEditRequest.partial({ requestId: true, bases: true }).safeParse({
    ...rest,
    ...(suggest ? { suggest: true } : {}),
  });
  if (!request.success) {
    throw new BadArguments(
      request.error.issues
        .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
        .join("; "),
    );
  }
  if (suggest && request.data.checkpoint) throw new BadArguments("A suggestion has nothing to checkpoint.");
  return JSON.stringify(request.data);
};
const epochFlag = (flag: Flag, value: unknown) => {
  if (!Number.isInteger(value) || (value as number) < 1) throw new BadArguments("epoch is required.");
  return flag("epoch", value, NUMBER, "epoch");
};
const csv = (flag: Flag, name: string, value: unknown, form: RegExp, label: string) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new BadArguments(`${label} must be a list.`);
  for (const item of value)
    if (typeof item !== "string" || !form.test(item) || item.includes(","))
      throw new BadArguments(`${label} isn't valid.`);
  return flag(name, value.join(","), /^.{0,2000}$/s, label);
};

/** Each tool is one CLI command with --json, so tools without a shell behave the same as those with one. */
const TOOLS: Tool[] = [
  {
    name: "artifacts_source_add",
    description:
      "Queue an untrusted wiki source. Does not enable Librarian or complete processing. Files require an owned wiki-bound quarantine uploadId; never a filesystem path.",
    command: "wiki",
    properties: {
      wiki: { type: "string", description: "Wiki slug" },
      source: {
        type: "object",
        description: "SourceInput: text (text,title), url (url,title?), or file (uploadId,title?) with kind",
      },
      idempotencyKey: { type: "string", description: "Stable UUID; reuse for retries with identical input" },
      note: { type: "string", description: "Optional plain text note, at most 2000 characters" },
    },
    required: ["wiki", "source", "idempotencyKey"],
    args: () => {
      throw new BadArguments("Source submissions use the authenticated ingestion adapter.");
    },
  },
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
    ...EDIT_TOOLS.read,
    command: "page",
    plain: true,
    args: (input, flag) => [
      "read",
      ...(input.draft === true ? ["--draft"] : input.draft === false ? ["--latest"] : []),
      ...flag("cursor", input.cursor, CURSOR, "cursor"),
      ...requiredArtifact(input.artifact),
    ],
  },
  {
    ...EDIT_TOOLS.edit,
    command: "page",
    answersOnRefusal: true,
    args: (input, flag) => [
      "edit",
      ...editArgs(input, flag),
      ...(input.checkpoint === true ? ["--checkpoint"] : []),
      ...requiredArtifact(input.artifact),
    ],
    stdin: (input) => editOps(input, false),
  },
  {
    ...EDIT_TOOLS.suggest,
    command: "page",
    answersOnRefusal: true,
    args: (input, flag) => ["suggest", ...editArgs(input, flag), ...requiredArtifact(input.artifact)],
    stdin: (input) => editOps(input, true),
  },
  {
    ...EDIT_TOOLS.create,
    command: "page",
    args: (input, flag) => {
      const wikiSlug = `${text(input.wiki, "wiki")}/${text(input.slug, "slug")}`;
      if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(wikiSlug))
        throw new BadArguments("wiki and slug must be slugs.");
      return [
        "create",
        "--file=-",
        ...flag("title", text(input.title, "title"), /^[^\0]{1,120}$/s, "title"),
        ...flag("summary", text(input.summary, "summary"), /^[^\0]{1,280}$/s, "summary"),
        ...(Array.isArray(input.tags)
          ? input.tags.flatMap((tag) => flag("tag", tag, /^[^\0]{1,32}$/s, "tag"))
          : []),
        ...flag("role", input.role, /^(page|source)$/, "role"),
        ...slugList(flag, "source", input.sources, "sources"),
        ...flag("origin", input.origin, /^https?:\/\/\S{1,2000}$/, "origin"),
        ...(input.untrusted === true ? ["--untrusted"] : []),
        ...flag("message", input.message, /^[^\0]{1,2000}$/s, "message"),
        wikiSlug,
      ];
    },
    stdin: (input) => text(input.markdown, "markdown"),
  },
  {
    ...EDIT_TOOLS.suggestions,
    command: "page",
    args: (input, flag) => [
      "suggestions",
      ...flag("status", input.status, /^(open|accepted|rejected|stale|expired|withdrawn|all)$/, "status"),
      ...flag("run", input.run, UUID, "run"),
      ...requiredArtifact(input.artifact),
    ],
  },
  {
    ...EDIT_TOOLS.delegate,
    command: "page",
    args: (input, flag) => {
      const artifact = requiredArtifact(input.artifact);
      if (input.action === "start")
        return [
          "delegate",
          ...flag("goal", text(input.goal, "goal"), /^[^\0]{1,500}$/s, "goal"),
          ...artifact,
        ];
      if (input.action !== "finish" && input.action !== "cancel")
        throw new BadArguments("action is start, finish or cancel.");
      return [
        "delegate",
        ...flag(input.action, text(input.run, "run"), UUID, "run"),
        ...(input.action === "finish" ? flag("message", input.message, /^[^\0]{1,2000}$/s, "message") : []),
        ...artifact,
      ];
    },
  },
  {
    ...BOARD_TOOLS.read,
    command: "board",
    args: (input, flag) => [
      "read",
      ...(input.draft === true ? ["--draft"] : []),
      ...flag("version", input.version, NUMBER, "version"),
      ...flag("cursor", input.cursor, BOARD_CURSOR, "cursor"),
      ...requiredArtifact(input.artifact),
    ],
  },
  {
    ...BOARD_TOOLS.edit,
    command: "board",
    answersOnRefusal: true,
    args: (input) => ["edit", "--ops=-", ...requiredArtifact(input.artifact)],
    stdin: (input) => boardOps(input, false),
  },
  {
    ...BOARD_TOOLS.suggest,
    command: "board",
    answersOnRefusal: true,
    args: (input) => ["suggest", "--ops=-", ...requiredArtifact(input.artifact)],
    stdin: (input) => boardOps(input, true),
  },
  {
    ...BOARD_TOOLS.checkpoint,
    command: "board",
    args: (input, flag) => [
      "save",
      ...epochFlag(flag, input.epoch),
      ...flag("name", input.name, /^[^\0]{1,120}$/s, "name"),
      ...flag("message", input.message, /^[^\0]{1,2000}$/s, "message"),
      ...requiredArtifact(input.artifact),
    ],
  },
  {
    ...BOARD_TOOLS.suggestions,
    command: "board",
    args: (input, flag) => [
      "suggestions",
      ...flag("status", input.status, /^(open|accepted|rejected|stale|expired|withdrawn|all)$/, "status"),
      ...flag("preview", input.preview, UUID, "preview"),
      ...flag("cursor", input.cursor, BOARD_CURSOR, "cursor"),
      ...requiredArtifact(input.artifact),
    ],
  },
  {
    ...BOARD_TOOLS.delegate,
    command: "board",
    args: (input, flag) => {
      const artifact = requiredArtifact(input.artifact);
      if ((input.goal === undefined) === (input.finish === undefined))
        throw new BadArguments("Give a goal to start a run, or finish with a run id.");
      if (input.goal !== undefined)
        return [
          "delegate",
          ...flag("goal", text(input.goal, "goal"), /^[^\0]{1,500}$/s, "goal"),
          ...flag("agent", input.agent, /^[^\0]{1,80}$/s, "agent"),
          ...artifact,
        ];
      return [
        "delegate",
        ...flag("finish", text(input.finish, "finish"), UUID, "run"),
        ...flag("message", input.message, /^[^\0]{1,2000}$/s, "message"),
        ...artifact,
      ];
    },
  },
  {
    ...BOARD_TOOLS.create,
    command: "board",
    args: (input, flag) => {
      const wikiSlug = `${text(input.project, "project")}/${text(input.slug, "slug")}`;
      if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(wikiSlug))
        throw new BadArguments("project and slug must be slugs.");
      return [
        "create",
        ...flag("title", text(input.title, "title"), /^[^\0]{1,120}$/s, "title"),
        ...flag("summary", text(input.summary, "summary"), /^[^\0]{1,280}$/s, "summary"),
        ...csv(flag, "tags", input.tags, /^[^\0]{1,32}$/s, "tags"),
        ...csv(flag, "sources", input.sources, KEY, "sources"),
        wikiSlug,
      ];
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
  return [...(tool.plain ? [] : ["--json"]), tool.command, ...tool.args(input, flagFor(tool.command))];
}

/** What a tool's command reads on standard input, if anything. */
export function toolStdin(name: string, input: Record<string, unknown>) {
  return TOOLS.find((entry) => entry.name === name)?.stdin?.(input);
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

async function callTool(name: string, args: string[], stdin?: string) {
  // Run from a script, this needs Bun and the script; a compiled binary is the whole command.
  const script = process.argv[1] ?? "";
  const self =
    /\.(ts|js)$/.test(script) && !script.startsWith("/$bunfs")
      ? [process.execPath, script]
      : [process.execPath];
  const child = Bun.spawn([...self, ...args], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (name === "artifacts_view" && code === 0) return imageResult(out);
  const tool = TOOLS.find((entry) => entry.name === name);
  // A refused edit is an answer, not a failure of the tool: it holds the block's current text, which is data.
  // So is a board batch that became a suggestion (exit 2), as long as the command printed its receipt.
  const answered =
    code === 0 ||
    (tool?.answersOnRefusal === true && (code === 1 || code === 2) && out.trimStart().startsWith("{"));
  return {
    content: [
      ...(tool?.untrusted && answered ? [{ type: "text", text: UNTRUSTED_NOTICE }] : []),
      { type: "text", text: capOutput((out || err).trim()) },
    ],
    ...(answered ? {} : { isError: true }),
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
        const input = (request.params?.arguments ?? {}) as Record<string, unknown>;
        if (request.params?.name === "artifacts_source_add") {
          const parsedInput = SourceSubmission.omit({ requestId: true })
            .extend({ idempotencyKey: z.uuid() })
            .strict()
            .safeParse(input);
          const parsed = parsedInput.success
            ? SourceSubmission.safeParse({
                wiki: parsedInput.data.wiki,
                source: parsedInput.data.source,
                note: parsedInput.data.note,
                requestId: parsedInput.data.idempotencyKey,
              })
            : parsedInput;
          if (!parsed.success)
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: {
                      code: "invalid",
                      message: "Invalid source submission.",
                      details: parsed.error.issues,
                    },
                  }),
                },
              ],
            };
          try {
            const client = await findClient();
            if (!client) throw new Error("Sign in first.");
            return {
              content: [{ type: "text", text: JSON.stringify(await submitSource(client, parsed.data)) }],
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error:
                      error instanceof ApiCallError
                        ? error.failure
                        : {
                            code: "source_add_failed",
                            message: "Could not queue source. Check authentication and server availability.",
                          },
                  }),
                },
              ],
            };
          }
        }
        const args = toolCommand(String(request.params?.name), input);
        if (!args) throw Object.assign(new Error("No such tool."), { code: -32602 });
        return await callTool(
          String(request.params?.name),
          args,
          toolStdin(String(request.params?.name), input),
        );
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
