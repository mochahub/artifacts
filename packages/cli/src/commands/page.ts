import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type Artifact,
  type CheckpointResult,
  DocState,
  EditRequest,
  EditResult,
  PageRead,
  PublishResult,
  Run,
  SLUG_PATTERN,
  SUGGESTION_STATUSES,
  type Suggestion,
  SuggestionList,
  Tags,
  UNTRUSTED_NOTICE,
  WIKI_ROLES,
} from "@artifacts/schema";
import { pageReadText } from "@artifacts/schema/mcp";
import { z } from "zod";
import { ApiCallError, type Client } from "../client.ts";
import type { Input } from "../command.ts";
import { CliError, type Output, UsageError } from "../output.ts";
import { signedIn } from "../session.ts";
import { namedArtifact, resolveArtifact, versionNumber } from "../target.ts";

type Server = { server?: string };
export type PageFlags = Server & {
  json?: boolean;
  draft?: boolean;
  latest?: boolean;
  cursor?: string;
  ops?: string;
  suggest?: boolean;
  checkpoint?: boolean;
  note?: string;
  source?: string[];
  fixes?: string;
  run?: string;
  replace?: string;
  base?: string;
  file?: string;
  "insert-after"?: string;
  delete?: string;
  name?: string;
  message?: string;
  status?: string;
  goal?: string;
  finish?: string;
  cancel?: string;
  version?: string;
  out?: string;
  title?: string;
  summary?: string;
  tag?: string[];
  role?: string;
  origin?: string;
  untrusted?: boolean;
};

const SUBCOMMANDS = ["read", "edit", "suggest", "save", "suggestions", "delegate", "export", "create"];

/** Page text is other people's: JSON output says so, as the library's does. */
const data = <T extends object>(result: T) => ({ untrusted: UNTRUSTED_NOTICE, ...result });

/** A token from before editing existed lacks the `edit` scope; the server's `forbidden` says so in `details.scope`. */
export function editFailure(error: unknown, out: Output): unknown {
  if (!(error instanceof ApiCallError) || out.json) return error;
  const { failure } = error;
  if (failure.code === "forbidden" && failure.details?.scope === "edit") {
    return new CliError("Run artifacts login again to edit pages.");
  }
  return error;
}

export async function editing<T>(out: Output, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw editFailure(error, out);
  }
}

function suggestionLine(s: Suggestion): string {
  const where = s.op === "insert" ? `after ${s.block ?? "start"}` : (s.block ?? "page");
  const by =
    s.author.kind === "agent"
      ? `${s.author.agent ?? "an agent"} for ${s.author.for ?? "an organization"}`
      : s.author.name;
  const text = s.markdown ? `: ${s.markdown.replace(/\s+/g, " ").slice(0, 120)}` : "";
  return `  ${s.id}  ${s.status}  ${s.op} ${where}, by ${by}${text}${s.note ? ` (${s.note})` : ""}`;
}

export function usageFor<F extends object>(flags: F, allowed: (keyof F)[], usage: () => UsageError) {
  const bad = (Object.keys(flags) as (keyof F)[]).filter(
    (key) => key !== "server" && key !== "json" && flags[key] !== undefined && !allowed.includes(key),
  );
  if (bad.length > 0) throw usage();
}

/** The artifact and, for editing, the signed-in client. Bad arguments stop before this. */
export async function open(flags: Server, target: string) {
  const client = await signedIn(flags.server);
  return { client, artifact: await resolveArtifact(client, target) };
}

export function readStdinOrFile(path: string, what: string): string {
  try {
    return path === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(path), "utf8");
  } catch (error) {
    throw new UsageError(
      `Can't read ${what} ${path === "-" ? "from standard input" : path}: ${(error as Error).message}`,
    );
  }
}

const numbers = (value: string, flag: string) =>
  value
    .split(",")
    .filter(Boolean)
    .map((item) => {
      if (!/^\d+$/.test(item)) throw new UsageError(`${flag} wants thread numbers like 3,5, not "${value}".`);
      return Number(item);
    });

/** An edit request from flags: `--ops` is a file of operations (or `-`), and the shorthands make one. */
export function editRequest(flags: PageFlags, suggest: boolean): EditRequest {
  const shorthands = [flags.replace, flags["insert-after"], flags.delete].filter((v) => v !== undefined);
  if (flags.ops !== undefined && shorthands.length > 0)
    throw new UsageError("Use --ops or one of --replace, --insert-after and --delete, not both.");
  if (flags.ops !== undefined && (flags.base !== undefined || flags.file !== undefined))
    throw new UsageError("--base and --file go with --replace, --insert-after and --delete, not --ops.");
  if (flags.ops === undefined && shorthands.length !== 1)
    throw new UsageError("Give --ops <file.json>, or one of --replace, --insert-after and --delete.");
  let request: Record<string, unknown> = {};
  if (flags.ops !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readStdinOrFile(flags.ops, "the operations"));
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError(`The operations aren't valid JSON: ${(error as Error).message}`);
    }
    request = Array.isArray(parsed) ? { ops: parsed } : { ...(parsed as object) };
  } else if (flags.delete !== undefined) {
    request = { ops: [{ op: "delete", block: flags.delete, base: flags.base }] };
  } else {
    if (flags.file === undefined) throw new UsageError("Add --file <markdown> (or - for standard input).");
    const markdown = readStdinOrFile(flags.file, "the Markdown");
    request =
      flags.replace !== undefined
        ? { ops: [{ op: "replace", block: flags.replace, base: flags.base, markdown }] }
        : {
            ops: [
              {
                op: "insert",
                after: flags["insert-after"] === "start" ? null : flags["insert-after"],
                markdown,
              },
            ],
          };
  }
  if (suggest) request.suggest = true;
  if (flags.checkpoint) request.checkpoint = true;
  if (flags.note !== undefined) request.note = flags.note;
  if (flags.source?.length) request.sources = flags.source;
  if (flags.fixes !== undefined) request.fixes = numbers(flags.fixes, "--fixes");
  if (flags.run !== undefined) request.run = flags.run;
  const parsed = EditRequest.safeParse(request);
  if (!parsed.success) {
    throw new UsageError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("\n"),
    );
  }
  if (suggest && flags.checkpoint)
    throw new UsageError("A suggestion changes nothing yet, so --checkpoint has nothing to save.");
  return parsed.data;
}

const outcomeMark = { applied: "✓", suggested: "~", refused: "✗" } as const;

function editLines(result: EditResult): string[] {
  const lines = result.results.map((r) => {
    const why = r.reason ? ` (${r.reason})` : "";
    const where = r.block ? ` ${r.block}` : "";
    return `${outcomeMark[r.outcome]} op ${r.index} ${r.outcome}${where}${why}${r.message ? `: ${r.message}` : ""}`;
  });
  if (result.version !== null) lines.push(`✓ saved as v${result.version}`);
  if (result.results.some((r) => r.outcome !== "applied")) lines.push(`agents: ${result.agents.text}`);
  return lines;
}

async function readPage(client: Client, artifact: Artifact, flags: PageFlags) {
  let draft = flags.draft === true;
  if (!flags.draft && !flags.latest) {
    // Like the hosted tool: the live draft when this person can edit it, so the bases are the current ones.
    const state = DocState.parse(await client.get(`/api/artifacts/${artifact.id}/doc`));
    draft = state.canEdit && state.editable;
  }
  const query = new URLSearchParams();
  if (draft) query.set("draft", "1");
  if (flags.cursor) query.set("cursor", flags.cursor);
  const text = query.size > 0 ? `?${query}` : "";
  return PageRead.parse(await client.get(`/api/artifacts/${artifact.id}/doc/markdown${text}`));
}

/** The hosted MCP over HTTP, for the tools that have no route of their own. The token is this CLI's. */
export async function hostedTool(client: Client, name: string, args: object): Promise<string> {
  const reply = await client.post<{
    result?: { content?: { type: string; text: string }[]; isError?: boolean };
    error?: { message: string };
  }>("/api/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  if (reply.error) throw new CliError(reply.error.message);
  const text = reply.result?.content?.filter((part) => part.type === "text").at(-1)?.text ?? "";
  if (reply.result?.isError) throw new CliError(text || "The server refused that.");
  return text;
}

/** The run lifecycle of `page delegate` and `board delegate`: start with a goal, then finish or cancel (13). */
export async function delegate(
  flags: Pick<PageFlags, "goal" | "finish" | "cancel" | "message" | "server"> & { agent?: string },
  target: string,
  out: Output,
  use: { edit: string; bad: () => UsageError },
) {
  const given = [flags.goal, flags.finish, flags.cancel].filter((v) => v !== undefined);
  if (given.length !== 1) throw use.bad();
  if (flags.message !== undefined && flags.finish === undefined) throw use.bad();
  if (flags.agent !== undefined && flags.goal === undefined) throw use.bad();
  const id = flags.finish ?? flags.cancel;
  if (id !== undefined && !z.uuid().safeParse(id).success) throw new UsageError("That isn't a run id.");
  const { client, artifact } = await open(flags, target);
  if (flags.goal !== undefined) {
    const run = Run.parse(
      await editing(out, () =>
        client.post(`/api/artifacts/${artifact.id}/doc/runs`, {
          goal: flags.goal,
          ...(flags.agent === undefined ? {} : { agent: flags.agent }),
        }),
      ),
    );
    return out.result(run, () => {
      out.say(run.id);
      out.warn(
        `Run started (${run.edits === "direct" ? "edits apply to the page" : "edits wait as suggestions"}). Pass --run ${run.id} to ${use.edit}, then --finish ${run.id}.`,
      );
    });
  }
  const verb = flags.finish !== undefined ? "finish" : "cancel";
  const run = Run.parse(
    await editing(out, () =>
      client.post(`/api/runs/${id}/${verb}`, verb === "finish" ? { message: flags.message } : {}),
    ),
  );
  return out.result(run, () =>
    out.say(
      verb === "cancel"
        ? "✓ Run cancelled."
        : run.version !== null
          ? `✓ Run finished, saved as v${run.version}.`
          : `✓ Run finished with ${run.suggestions} suggestions waiting for a person.`,
    ),
  );
}

export async function pageCommand(
  { args: { sub, target }, rest, flags, usage }: Input<"sub" | "target", PageFlags>,
  out: Output,
) {
  if (!sub || !SUBCOMMANDS.includes(sub) || !target || rest.length !== 2)
    throw usage(Math.max(0, SUBCOMMANDS.indexOf(sub ?? "")));
  const form = SUBCOMMANDS.indexOf(sub);
  const bad = () => usage(form);
  if (flags.version !== undefined) versionNumber(flags.version, "--version");

  if (sub === "read") {
    usageFor(flags, ["draft", "latest", "cursor"], bad);
    if (flags.draft && flags.latest) throw new UsageError("Use --draft or --latest, not both.");
    namedArtifact(target);
    const { client, artifact } = await open(flags, target);
    const read = await editing(out, () => readPage(client, artifact, flags));
    return out.result(data(read), () => {
      out.say(pageReadText(read));
    });
  }

  if (sub === "edit" || sub === "suggest") {
    usageFor(
      flags,
      [
        "ops",
        "suggest",
        "checkpoint",
        "note",
        "source",
        "fixes",
        "run",
        "replace",
        "base",
        "file",
        "insert-after",
        "delete",
      ],
      bad,
    );
    namedArtifact(target);
    if (sub === "suggest" && flags.suggest) throw bad();
    const request = editRequest(flags, sub === "suggest" || flags.suggest === true);
    const { client, artifact } = await open(flags, target);
    const result = EditResult.parse(
      await editing(out, () => client.post(`/api/artifacts/${artifact.id}/doc/ops`, request)),
    );
    // A refusal is a failure the caller must handle: the exit code says so, with the full answer still printed.
    if (result.results.some((r) => r.outcome === "refused")) process.exitCode = 1;
    return out.result(data(result), () => {
      for (const line of editLines(result)) out.say(line);
    });
  }

  if (sub === "save") {
    usageFor(flags, ["name", "message"], bad);
    namedArtifact(target);
    const { client, artifact } = await open(flags, target);
    const result = await editing(out, () =>
      client.post<CheckpointResult>(`/api/artifacts/${artifact.id}/doc/checkpoint`, {
        name: flags.name,
        message: flags.message,
      }),
    );
    return out.result(result, () =>
      out.say(
        result.created
          ? `✓ v${result.version} saved`
          : `Nothing new to save. v${result.version} is the latest.`,
      ),
    );
  }

  if (sub === "suggestions") {
    usageFor(flags, ["status", "run", "cursor"], bad);
    namedArtifact(target);
    if (
      flags.status &&
      flags.status !== "all" &&
      !(SUGGESTION_STATUSES as readonly string[]).includes(flags.status)
    )
      throw new UsageError(`--status is one of: ${[...SUGGESTION_STATUSES, "all"].join(", ")}.`);
    if (flags.run && !z.uuid().safeParse(flags.run).success) throw new UsageError("--run wants a run id.");
    const { client, artifact } = await open(flags, target);
    const query = new URLSearchParams();
    // The server lists every status when none is named, which is what "all" means.
    for (const key of ["status", "run", "cursor"] as const)
      if (flags[key] && !(key === "status" && flags.status === "all")) query.set(key, flags[key]);
    const result = SuggestionList.parse(
      await editing(out, () =>
        client.get(`/api/artifacts/${artifact.id}/suggestions${query.size ? `?${query}` : ""}`),
      ),
    );
    return out.result(data(result), () => {
      if (result.suggestions.length === 0) out.say("No suggestions.");
      for (const suggestion of result.suggestions) out.say(suggestionLine(suggestion));
      if (result.nextCursor) out.say(`More: --cursor ${result.nextCursor}`);
    });
  }

  if (sub === "delegate") {
    usageFor(flags, ["goal", "finish", "cancel", "message"], bad);
    namedArtifact(target);
    return delegate(flags, target, out, { edit: "page edit", bad });
  }

  if (sub === "export") {
    usageFor(flags, ["version", "draft", "out"], bad);
    namedArtifact(target);
    if (flags.version && flags.draft) throw new UsageError("Use --version or --draft, not both.");
    const { client, artifact } = await open(flags, target);
    const query = flags.draft ? "?draft=1" : flags.version ? `?version=${flags.version}` : "";
    const markdown = await editing(out, () => client.text(`/api/artifacts/${artifact.id}/export.md${query}`));
    if (flags.out) {
      const path = resolve(flags.out);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, markdown);
      return out.result({ path, bytes: Buffer.byteLength(markdown) }, () => out.say(path));
    }
    return out.result(data({ markdown }), () => process.stdout.write(markdown));
  }

  // create
  usageFor(
    flags,
    ["title", "summary", "tag", "role", "source", "origin", "untrusted", "file", "message"],
    bad,
  );
  const [wiki, slug, extra] = target.split("/");
  if (!wiki || !slug || extra || ![wiki, slug].every((part) => SLUG_PATTERN.test(part)))
    throw new UsageError(`Use <wiki>/<slug>, not "${target}".`);
  if (!flags.title || !flags.summary || flags.file === undefined)
    throw new UsageError("Give --title, --summary and --file <markdown> (or - for standard input).");
  if (flags.role !== undefined && !(WIKI_ROLES as readonly string[]).includes(flags.role))
    throw new UsageError(`--role is one of: ${WIKI_ROLES.join(", ")}.`);
  const tags = Tags.safeParse(flags.tag ?? []);
  if (!tags.success) throw new UsageError("--tag: up to 8, each up to 32 characters.");
  const markdown = readStdinOrFile(flags.file, "the Markdown");
  const client = await signedIn(flags.server);
  const answer = await editing(out, () =>
    hostedTool(client, "artifacts_page_create", {
      wiki,
      slug,
      title: flags.title,
      summary: flags.summary,
      markdown,
      tags: tags.data,
      role: flags.role,
      sources: flags.source,
      origin: flags.origin,
      untrusted: flags.untrusted,
      message: flags.message,
    }),
  );
  let created: PublishResult;
  try {
    created = PublishResult.parse(JSON.parse(answer));
  } catch {
    throw new CliError(answer || "The server's answer wasn't what this CLI expected.");
  }
  out.result(created, () => out.say(`✓ ${wiki}/${slug} v${created.version}  ${created.url}`));
}
