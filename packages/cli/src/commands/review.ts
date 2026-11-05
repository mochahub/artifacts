import { Artifact, ArtifactReviewStatus, type Thread, Thread as ThreadSchema } from "@artifacts/schema";
import { z } from "zod";
import { detectAgent } from "../agent.ts";
import { findRoot, loadManifest } from "../bundle/manifest.ts";
import type { Client } from "../client.ts";
import { CliError, type Output, UsageError } from "../output.ts";
import { signedIn } from "./account.ts";

/** A `<project>/<slug>` argument, or the nearest artifact.json (07). */
export function artifactRef(target: string | undefined) {
  if (target) {
    const [project, slug, extra] = target.split("/");
    // Slugs are a-z, 0-9 and -, so ".." can't climb out of /api/artifacts/by-slug/ in the URL below.
    if (!project || !slug || extra || ![project, slug].every((part) => /^[a-z0-9-]{1,40}$/.test(part))) {
      throw new UsageError(`Use <project>/<slug>, not "${target}".`);
    }
    return { project, slug };
  }
  const { manifest } = loadManifest(findRoot());
  if (!manifest) throw new CliError("artifact.json isn't valid. Run artifacts lint.");
  return { project: manifest.project, slug: manifest.slug };
}

/** A version number from the command line. It lands in a URL, so only digits pass. */
export function versionNumber(value: string, what = "A version") {
  if (!/^\d+$/.test(value)) throw new UsageError(`${what} must be a number, not "${value}".`);
  return value;
}

export async function resolveArtifact(client: Client, target: string | undefined) {
  const { project, slug } = artifactRef(target);
  return Artifact.parse(await client.get(`/api/artifacts/by-slug/${project}/${slug}`));
}

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

export async function statusCommand(target: string | undefined, server: string | undefined, out: Output) {
  const client = await signedIn(server);
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
  target: string | undefined,
  flags: { open?: boolean; fixed?: boolean; all?: boolean; page?: string; server?: string },
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
  n: string | undefined,
  text: string | undefined,
  flags: { fixed?: boolean; target?: string; server?: string },
  out: Output,
) {
  if (!n || !text || !/^\d+$/.test(n)) throw new UsageError('Usage: artifacts reply <n> "<text>" [--fixed]');
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, flags.target);
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

/** Frames or blocks that vanished since the latest version, for `frames/renamed` (07). */
export async function renamedProblems(
  client: Client,
  project: string,
  slug: string,
  current: { frames: Set<string>; blocks: Set<string> },
) {
  type Version = { pages: { key: string; frames?: { key: string }[]; blocks?: { key: string }[] }[] };
  let artifact: Artifact;
  try {
    artifact = Artifact.parse(await client.get(`/api/artifacts/by-slug/${project}/${slug}`));
  } catch {
    return []; // Nothing published yet, or not visible to this caller: prepare reports that.
  }
  const version = await client.get<Version>(
    `/api/artifacts/${artifact.id}/versions/${artifact.latestVersion}`,
  );
  const threads = z
    .array(ThreadSchema)
    .parse(await client.get(`/api/artifacts/${artifact.id}/threads?status=open`));
  const commented = new Set(
    threads.flatMap((thread) => {
      const anchor = thread.anchor;
      if (!anchor) return [];
      return [anchor.type === "frame" ? anchor.frameKey : `${thread.pageKey}/${anchor.blockKey}`];
    }),
  );
  const problems: { rule: string; severity: "error" | "warning"; message: string }[] = [];
  const check = (key: string, kind: string) => {
    const open = commented.has(key);
    problems.push({
      rule: "frames/renamed",
      severity: open ? "error" : "warning",
      message: `${kind} "${key}" was in v${artifact.latestVersion} and is gone${open ? ", and it has open comments. Put the id back" : ""}.`,
    });
  };
  for (const page of version.pages) {
    for (const frame of page.frames ?? []) if (!current.frames.has(frame.key)) check(frame.key, "Frame");
    for (const block of page.blocks ?? []) {
      const key = `${page.key}/${block.key}`;
      if (!current.blocks.has(key) && commented.has(key)) check(key, "Block");
    }
  }
  return problems;
}

type VersionList = {
  n: number;
  name: string | null;
  message: string | null;
  publishedBy: string;
  agent: string | null;
  publishedAt: string;
  restoredFrom: number | null;
}[];

export async function versionsCommand(
  sub: string | undefined,
  args: (string | undefined)[],
  flags: { server?: string },
  out: Output,
) {
  if (sub === "name" && args[0]) versionNumber(args[0]);
  const client = await signedIn(flags.server);
  if (sub === "name") {
    const [n, label] = args;
    if (!n || !label) throw new UsageError('Usage: artifacts versions name <n> "<label>"');
    const artifact = await resolveArtifact(client, undefined);
    await client.request("PATCH", `/api/artifacts/${artifact.id}/versions/${n}`, { name: label });
    return out.result({ n: Number(n), name: label }, () => out.say(`✓ v${n} is "${label}".`));
  }
  const artifact = await resolveArtifact(client, sub);
  const list = await client.get<VersionList>(`/api/artifacts/${artifact.id}/versions`);
  out.result(list, () => {
    for (const version of list) {
      const label = version.name ? ` "${version.name}"` : "";
      out.say(
        `v${version.n}${label}  ${version.agent ?? version.publishedBy}, ${version.publishedAt.slice(0, 10)}  ${version.message ?? ""}`,
      );
    }
  });
}

export async function diffCommand(
  a: string | undefined,
  b: string | undefined,
  flags: { server?: string },
  out: Output,
) {
  const number = (value: string | undefined) => value?.replace(/^v/, "");
  if (!number(a) || !number(b)) throw new UsageError("Usage: artifacts diff <a> <b>");
  versionNumber(number(a) as string);
  versionNumber(number(b) as string);
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, undefined);
  type Change = { added: string[]; removed: string[]; changed: string[] };
  const result = await client.get<{ frames: Change; blocks: Change }>(
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

export async function restoreCommand(n: string | undefined, flags: { server?: string }, out: Output) {
  if (!n || !/^\d+$/.test(n)) throw new UsageError("Usage: artifacts restore <n>");
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, undefined);
  const result = await client.post<{ n: number }>(`/api/artifacts/${artifact.id}/versions/${n}/restore`);
  out.result(result, () => out.say(`✓ v${n} is now v${result.n}.`));
}

export async function archiveCommand(
  target: string | undefined,
  flags: { undo?: boolean; server?: string },
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

type DeletedRow = {
  kind: string;
  artifact: { id: string; project: string; slug: string; title: string };
  version?: number;
};

export async function deleteCommand(
  target: string | undefined,
  flags: { version?: string; server?: string },
  out: Output,
) {
  if (flags.version) versionNumber(flags.version, "--version");
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, target);
  const path = flags.version
    ? `/api/artifacts/${artifact.id}/versions/${flags.version}/delete`
    : `/api/artifacts/${artifact.id}/delete`;
  const { purgeAfter } = await client.post<{ purgeAfter: string }>(path);
  const undo = `artifacts undelete ${artifact.project}/${artifact.slug}${flags.version ? ` --version ${flags.version}` : ""}`;
  out.result({ purgeAfter, undo }, () => {
    out.say(`✓ Moved to Recently deleted, until ${purgeAfter.slice(0, 10)}.`);
    out.say(`  Undo: ${undo}`);
  });
}

export async function undeleteCommand(
  target: string | undefined,
  flags: { version?: string; server?: string },
  out: Output,
) {
  if (flags.version) versionNumber(flags.version, "--version");
  const client = await signedIn(flags.server);
  const { project, slug } = artifactRef(target);
  const list = await client.get<DeletedRow[]>("/api/deleted");
  const entry = list.find(
    (row) =>
      row.artifact.project === project &&
      row.artifact.slug === slug &&
      (flags.version ? row.version === Number(flags.version) : row.kind === "artifact"),
  );
  if (!entry) throw new CliError(`Nothing of yours called ${project}/${slug} is in Recently deleted.`);
  const path = flags.version
    ? `/api/artifacts/${entry.artifact.id}/versions/${flags.version}/undelete`
    : `/api/artifacts/${entry.artifact.id}/undelete`;
  await client.post(path);
  out.result({ ok: true }, () => out.say(`✓ Restored ${entry.artifact.title}.`));
}
