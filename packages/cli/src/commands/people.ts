import {
  type AccessAdded,
  INVITE_DAYS,
  type InviteCreated,
  type PeopleList,
  ProjectAccessList,
  type ResetLinkCreated,
  type ShareLinkCreated,
  SLUG_PATTERN,
  TeamDetail,
  TeamList,
} from "@artifacts/schema";
import { findRoot, loadManifest } from "../bundle/manifest.ts";
import { ApiCallError } from "../client.ts";
import type { Input } from "../command.ts";
import { CliError, type Output, UsageError } from "../output.ts";
import { signedIn } from "../session.ts";
import { resolveArtifact } from "../target.ts";

export async function orgCommand(
  { args: { sub, email }, flags, usage }: Input<"sub" | "email", { role?: string; server?: string }>,
  out: Output,
) {
  if (!email || (sub !== "invite" && sub !== "reset-link")) throw usage();
  const client = await signedIn(flags.server);
  if (sub === "invite") {
    const role = flags.role ?? "member";
    const { url } = await client.post<InviteCreated>("/api/invites", { email, role });
    return out.result({ url, email, role }, () => {
      out.say(`✓ Invite for ${email} (${role}), works once, expires in ${INVITE_DAYS} days`);
      out.say(`  ${url}   send this yourself; nothing was emailed`);
    });
  }
  const { people } = await client.get<PeopleList>("/api/people");
  const person = people.find((row) => row.email.toLowerCase() === email.toLowerCase());
  if (!person) throw new CliError(`Nobody here has the email ${email}.`);
  const { url, expiresAt } = await client.post<ResetLinkCreated>(`/api/people/${person.id}/reset-link`);
  out.result({ url, expiresAt }, () => out.say(`Works once, for one hour:\n  ${url}`));
}

export async function teamsCommand({ flags }: Input<never, { server?: string }>, out: Output) {
  const client = await signedIn(flags.server);
  const { teams } = TeamList.parse(await client.get("/api/teams"));
  out.result({ teams }, () => {
    if (teams.length === 0) out.say("No teams yet. Admins make them in Settings, Teams.");
    for (const team of teams) {
      const yours = team.role === "lead" ? ", you lead it" : team.role ? ", you're in it" : "";
      out.say(
        `${team.slug}  ${team.name} (${team.members} ${team.members === 1 ? "person" : "people"}${yours})`,
      );
    }
  });
}

const LEVEL_WORDS = {
  view: "can view",
  comment: "can comment",
  edit: "can edit",
  publish: "can publish",
  manage: "can manage",
};

/** Who has a project. Read-only: tokens can't change it (04). */
export async function projectCommand(
  { args: { sub, project: named }, flags, usage }: Input<"sub" | "project", { server?: string }>,
  out: Output,
) {
  if (sub !== "access") throw usage();
  const project = named ?? loadManifest(findRoot()).manifest?.project;
  if (!project || !SLUG_PATTERN.test(project)) {
    throw new UsageError("Name a project: artifacts project access <project>");
  }
  const client = await signedIn(flags.server);
  const access = ProjectAccessList.parse(await client.get(`/api/projects/${project}/access`));
  out.result(access, () => {
    out.say(
      `${access.project.name}: ${access.project.restricted ? "restricted" : "open to the organization"}`,
    );
    for (const team of access.teams) {
      out.say(`  ${team.name} (${team.members}), ${LEVEL_WORDS[team.permission]}`);
    }
    for (const person of access.people) {
      out.say(
        `  ${person.name}, ${LEVEL_WORDS[person.permission]}${person.capped ? ", capped by role" : ""}`,
      );
    }
    for (const person of access.inherited) {
      const via = person.via === "role" ? "role" : person.sources.map((source) => source.name).join(", ");
      out.say(`  ${person.name}, ${LEVEL_WORDS[person.level]}, via ${via}`);
    }
    out.say("Change this in the viewer. Tokens can't.");
  });
}

export async function visibilityCommand(
  { args: { value, target }, flags, usage }: Input<"value" | "target", { server?: string }>,
  out: Output,
) {
  if (value !== "org" && value !== "me") throw usage();
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, target);
  await client.request("PATCH", `/api/artifacts/${artifact.id}`, { visibility: value });
  out.result({ visibility: value }, () =>
    out.say(
      `✓ ${artifact.title} is visible to ${value === "org" ? "the organization" : "only you and people you add"}.`,
    ),
  );
}

/** Only a person can give edit access (04): the server refuses a token, and this says what to do instead. */
async function tokenCantGiveEdit<T>(
  edit: boolean | undefined,
  out: Output,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // With --json the server's own error is what a script reads.
    if (edit && !out.json && error instanceof ApiCallError && error.failure.code === "forbidden") {
      throw new CliError("Only a person can give edit access. Use the Share sheet.");
    }
    throw error;
  }
}

export async function shareCommand(
  {
    args: { target },
    flags,
    usage,
  }: Input<
    "target",
    {
      link?: boolean;
      invite?: string;
      team?: string;
      comment?: boolean;
      edit?: boolean;
      publish?: boolean;
      expires?: string;
      server?: string;
    }
  >,
  out: Output,
) {
  if (!flags.link && !flags.invite && !flags.team) throw usage();
  if (flags.edit && (flags.comment || flags.publish)) {
    throw new UsageError("Pick one of --comment, --edit and --publish.");
  }
  // A link would let a stranger edit (13, "Permissions").
  if (flags.link && flags.edit)
    throw new UsageError("A link can't let people edit. Share with a person or a team.");
  if (flags.team && flags.publish) {
    throw new UsageError("Only a person can let a team publish. Use the Share sheet.");
  }
  // It lands in a URL, so only a slug passes.
  if (flags.team && !SLUG_PATTERN.test(flags.team)) {
    throw new UsageError(`--team wants a team's slug, not "${flags.team}". See artifacts teams.`);
  }
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, target);
  if (flags.link) {
    const { url } = await client.post<ShareLinkCreated>(`/api/artifacts/${artifact.id}/links`, {
      permission: flags.comment ? "comment" : "view",
      expiresIn: flags.expires ?? null,
    });
    return out.result({ url }, () => out.say(url));
  }
  if (flags.team) {
    const { team } = TeamDetail.parse(await client.get(`/api/teams/${flags.team}`));
    const permission = flags.edit ? "edit" : flags.comment ? "comment" : "view";
    await tokenCantGiveEdit(flags.edit, out, () =>
      client.request("PUT", `/api/artifacts/${artifact.id}/teams/${team.id}`, { permission }),
    );
    return out.result({ team: team.slug, permission }, () =>
      out.say(
        `✓ ${team.name} can ${permission} ${artifact.title}. Until a person confirms it, they can't approve.`,
      ),
    );
  }
  const permission = flags.publish ? "publish" : flags.edit ? "edit" : flags.comment ? "comment" : "view";
  const result = await tokenCantGiveEdit(flags.edit, out, () =>
    client.post<AccessAdded>(`/api/artifacts/${artifact.id}/access`, {
      email: flags.invite,
      permission,
    }),
  );
  out.result(result, () =>
    out.say("url" in result ? result.url : `✓ ${flags.invite} can ${permission} ${artifact.title}.`),
  );
}
