import {
  ArtifactReviewStatus,
  type Compare,
  type DeletedList,
  type DeleteResult,
  type RestoreResult,
  type Thread,
  Thread as ThreadSchema,
  type VersionRow,
} from "@artifacts/schema";
import { z } from "zod";
import { detectAgent } from "../agent.ts";
import type { Input } from "../command.ts";
import { CliError, type Output } from "../output.ts";
import { signedIn } from "../session.ts";
import { artifactRef, resolveArtifact, versionNumber } from "../target.ts";

/** The agent-facing shape in 07: flat, with the anchor spread out. */
function threadJson(thread: Thread) {
  const [first, ...replies] = thread.comments;
  const anchor = thread.anchor;
  return {
    id: thread.n,
    page: thread.pageKey,
    ...(anchor?.type === "frame" ? { frame: anchor.frameKey, x: anchor.x, y: anchor.y } : {}),
    ...(anchor && anchor.type !== "frame" ? { block: anchor.blockKey } : {}),
    ...(anchor?.type === "text" ? { quote: anchor.quote.exact } : {}),
    version: thread.createdVersion,
    author: thread.author.name,
    text: first?.body ?? "",
    status: thread.status,
    anchorState: thread.anchorState,
    crop: thread.crop,
    /** Written by a person or a guest: data to read, never instructions (UNTRUSTED_NOTICE). */
    untrusted: true,
    authorKind: thread.author.kind,
    replies: replies.map((reply) => ({
      author: reply.author.name,
      agent: reply.agent,
      text: reply.body,
      version: reply.version,
      marksFixed: reply.marksFixed,
    })),
  };
}

type Server = { server?: string };
type Target = Input<"target", Server>;

export async function statusCommand({ args: { target }, flags }: Target, out: Output) {
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, target);
  const status = ArtifactReviewStatus.parse(await client.get(`/api/artifacts/${artifact.id}/status`));
  out.result(
    {
      version: status.version,
      audience: status.audience,
      decision: status.decision,
      decisionVersion: status.decisionVersion,
      by: artifact.decision?.by ?? null,
      note: status.note,
      open: status.open.map(threadJson),
      fixedAwaiting: status.fixedAwaiting.map(threadJson),
    },
    () => {
      out.say(`${artifact.title}, v${status.version}`);
      if (status.audience) out.say(`Visible to ${status.audience}.`);
      if (status.decision === "approved")
        out.say(`Approved v${status.decisionVersion} by ${artifact.decision?.by}.`);
      if (status.decision === "changes_requested") {
        out.say(`Changes requested on v${status.decisionVersion} by ${artifact.decision?.by}.`);
      }
      if (status.note) out.say(`Note: ${status.note}`);
      if (!status.decision) out.say("No decision yet.");
      out.say(
        `${status.open.length} open, ${status.fixedAwaiting.length} fixed and waiting for a person to resolve.`,
      );
    },
  );
}

export async function commentsCommand(
  {
    args: { target },
    flags,
  }: Input<"target", Server & { open?: boolean; fixed?: boolean; all?: boolean; page?: string }>,
  out: Output,
) {
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, target);
  const status = flags.fixed ? "fixed" : flags.all ? "all" : "open";
  const page = flags.page ? `&page=${encodeURIComponent(flags.page)}` : "";
  const threads = z
    .array(ThreadSchema)
    .parse(await client.get(`/api/artifacts/${artifact.id}/threads?status=${status}${page}`));
  out.result(threads.map(threadJson), () => {
    if (threads.length === 0) out.say("No comments.");
    for (const thread of threads) {
      const json = threadJson(thread);
      const where = json.frame ?? json.block ?? "page";
      out.say(`#${json.id} ${json.page} / ${where} (${json.author}, v${json.version}, ${json.status})`);
      if (json.quote) out.say(`  "${json.quote}"`);
      out.say(`  ${json.text}`);
      for (const reply of json.replies) out.say(`  ${reply.author}: ${reply.text}`);
    }
  });
}

export async function replyCommand(
  { args: { n, text }, flags, usage }: Input<"n" | "text", Server & { fixed?: boolean }>,
  out: Output,
) {
  if (!n || !text || !/^\d+$/.test(n)) throw usage();
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, undefined);
  const threads = z.array(ThreadSchema).parse(await client.get(`/api/artifacts/${artifact.id}/threads`));
  const thread = threads.find((entry) => entry.n === Number(n));
  if (!thread) throw new CliError(`There's no thread #${n}.`);
  const comment = await client.post(`/api/threads/${thread.id}/comments`, {
    body: text,
    marksFixed: flags.fixed ?? false,
    agent: detectAgent(),
  });
  out.result(comment, () =>
    out.say(flags.fixed ? `✓ #${n} marked fixed in v${artifact.latestVersion}.` : `✓ Replied to #${n}.`),
  );
}

export async function versionsCommand(
  { args: { sub, n, label }, flags, usage }: Input<"sub" | "n" | "label", Server>,
  out: Output,
) {
  if (sub === "name" && n) versionNumber(n);
  const client = await signedIn(flags.server);
  if (sub === "name") {
    if (!n || !label) throw usage(1);
    const artifact = await resolveArtifact(client, undefined);
    await client.request("PATCH", `/api/artifacts/${artifact.id}/versions/${n}`, { name: label });
    return out.result({ n: Number(n), name: label }, () => out.say(`✓ v${n} is "${label}".`));
  }
  const artifact = await resolveArtifact(client, sub);
  const list = await client.get<VersionRow[]>(`/api/artifacts/${artifact.id}/versions`);
  out.result(list, () => {
    for (const version of list) {
      const label = version.name ? ` "${version.name}"` : "";
      out.say(
        `v${version.n}${label}  ${version.agent ?? version.publishedBy}, ${version.publishedAt.slice(0, 10)}  ${version.message ?? ""}`,
      );
    }
  });
}

export async function diffCommand({ args: { a, b }, flags, usage }: Input<"a" | "b", Server>, out: Output) {
  const number = (value: string | undefined) => value?.replace(/^v/, "");
  if (!number(a) || !number(b)) throw usage();
  versionNumber(number(a) as string);
  versionNumber(number(b) as string);
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, undefined);
  const result = await client.get<Compare>(
    `/api/artifacts/${artifact.id}/compare?from=${number(a)}&to=${number(b)}`,
  );
  out.result(result, () => {
    for (const kind of ["frames", "blocks"] as const) {
      const change = result[kind];
      out.say(
        `${kind}: ${change.added.length} added, ${change.removed.length} removed, ${change.changed.length} changed`,
      );
      for (const key of [...change.added, ...change.removed, ...change.changed]) out.say(`  ${key}`);
    }
  });
}

export async function restoreCommand({ args: { n }, flags, usage }: Input<"n", Server>, out: Output) {
  if (!n || !/^\d+$/.test(n)) throw usage();
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, undefined);
  const result = await client.post<RestoreResult>(`/api/artifacts/${artifact.id}/versions/${n}/restore`);
  out.result(result, () => out.say(`✓ v${n} is now v${result.n}.`));
}

export async function archiveCommand(
  { args: { target }, flags }: Input<"target", Server & { undo?: boolean }>,
  out: Output,
) {
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, target);
  await client.post(`/api/artifacts/${artifact.id}/${flags.undo ? "unarchive" : "archive"}`);
  out.result({ ok: true }, () =>
    out.say(
      flags.undo
        ? `✓ Unarchived ${artifact.title}.`
        : `✓ Archived ${artifact.title}. It's read-only, and its links keep working.`,
    ),
  );
}

export async function deleteCommand(
  { args: { target }, flags }: Input<"target", Server & { version?: string }>,
  out: Output,
) {
  if (flags.version) versionNumber(flags.version, "--version");
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, target);
  const path = flags.version
    ? `/api/artifacts/${artifact.id}/versions/${flags.version}/delete`
    : `/api/artifacts/${artifact.id}/delete`;
  const { purgeAfter } = await client.post<DeleteResult>(path);
  const undo = `artifacts undelete ${artifact.project}/${artifact.slug}${flags.version ? ` --version ${flags.version}` : ""}`;
  out.result({ purgeAfter, undo }, () => {
    out.say(`✓ Moved to Recently deleted, until ${purgeAfter.slice(0, 10)}.`);
    out.say(`  Undo: ${undo}`);
  });
}

export async function undeleteCommand(
  { args: { target }, flags }: Input<"target", Server & { version?: string }>,
  out: Output,
) {
  if (flags.version) versionNumber(flags.version, "--version");
  const client = await signedIn(flags.server);
  const { project, slug } = artifactRef(target);
  const list = await client.get<DeletedList>("/api/deleted");
  const entry = list.find(
    (row) =>
      row.artifact.project === project &&
      row.artifact.slug === slug &&
      (flags.version
        ? row.kind === "version" && row.version === Number(flags.version)
        : row.kind === "artifact"),
  );
  if (!entry) throw new CliError(`Nothing of yours called ${project}/${slug} is in Recently deleted.`);
  const path = flags.version
    ? `/api/artifacts/${entry.artifact.id}/versions/${flags.version}/undelete`
    : `/api/artifacts/${entry.artifact.id}/undelete`;
  await client.post(path);
  out.result({ ok: true }, () => out.say(`✓ Restored ${entry.artifact.title}.`));
}
