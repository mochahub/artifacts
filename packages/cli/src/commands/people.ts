import { ProjectAccessList, TeamDetail, TeamList } from "@artifacts/schema";
import { findRoot, loadManifest } from "../bundle/manifest.ts";
import { CliError, type Output, UsageError } from "../output.ts";
import { signedIn } from "./account.ts";
import { resolveArtifact } from "./review.ts";

export async function orgCommand(
  sub: string | undefined,
  email: string | undefined,
  flags: { role?: string; server?: string },
  out: Output,
) {
  if (!email || (sub !== "invite" && sub !== "reset-link")) {
    throw new UsageError(
      "Usage: artifacts org invite <email> [--role member|reviewer|admin] | org reset-link <email>",
    );
  }
  const client = await signedIn(flags.server);
  if (sub === "invite") {
    const role = flags.role ?? "member";
    const { url } = await client.post<{ url: string }>("/api/invites", { email, role });
    return out.result({ url, email, role }, () => {
      out.say(`✓ Invite for ${email} (${role}), works once, expires in 7 days`);
      out.say(`  ${url}   send this yourself; nothing was emailed`);
    });
  }
  const { people } = await client.get<{ people: { id: string; email: string }[] }>("/api/people");
  const person = people.find((row) => row.email.toLowerCase() === email.toLowerCase());
  if (!person) throw new CliError(`Nobody here has the email ${email}.`);
  const { url, expiresAt } = await client.post<{ url: string; expiresAt: string }>(
    `/api/people/${person.id}/reset-link`,
  );
  out.result({ url, expiresAt }, () => out.say(`Works once, for one hour:\n  ${url}`));
}

export async function teamsCommand(server: string | undefined, out: Output) {
  const client = await signedIn(server);
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
  publish: "can publish",
  manage: "can manage",
};

/** Who has a project. Read-only: tokens can't change it (04). */
export async function projectCommand(
  sub: string | undefined,
  target: string | undefined,
  server: string | undefined,
  out: Output,
) {
  if (sub !== "access") throw new UsageError("Usage: artifacts project access [<project>]");
  const project = target ?? loadManifest(findRoot()).manifest?.project;
  if (!project || !/^[a-z0-9-]{1,40}$/.test(project)) {
    throw new UsageError("Name a project: artifacts project access <project>");
  }
  const client = await signedIn(server);
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
  value: string | undefined,
  target: string | undefined,
  server: string | undefined,
  out: Output,
) {
  if (value !== "org" && value !== "me") throw new UsageError("Usage: artifacts visibility org|me");
  const client = await signedIn(server);
  const artifact = await resolveArtifact(client, target);
  await client.request("PATCH", `/api/artifacts/${artifact.id}`, { visibility: value });
  out.result({ visibility: value }, () =>
    out.say(
      `✓ ${artifact.title} is visible to ${value === "org" ? "the organization" : "only you and people you add"}.`,
    ),
  );
}

export async function shareCommand(
  target: string | undefined,
  flags: {
    link?: boolean;
    invite?: string;
    team?: string;
    comment?: boolean;
    publish?: boolean;
    expires?: string;
    server?: string;
  },
  out: Output,
) {
  if (!flags.link && !flags.invite && !flags.team) {
    throw new UsageError(
      "Usage: artifacts share --link [--comment] [--expires 1d|7d|30d] | --invite <email> [--comment|--publish] | --team <slug> [--comment]",
    );
  }
  if (flags.team && flags.publish) {
    throw new UsageError("Only a person can let a team publish. Use the Share sheet.");
  }
  // It lands in a URL, so only a slug passes.
  if (flags.team && !/^[a-z0-9-]{1,40}$/.test(flags.team)) {
    throw new UsageError(`--team wants a team's slug, not "${flags.team}". See artifacts teams.`);
  }
  const client = await signedIn(flags.server);
  const artifact = await resolveArtifact(client, target);
  if (flags.link) {
    const { url } = await client.post<{ url: string }>(`/api/artifacts/${artifact.id}/links`, {
      permission: flags.comment ? "comment" : "view",
      expiresIn: flags.expires ?? null,
    });
    return out.result({ url }, () => out.say(url));
  }
  if (flags.team) {
    const { team } = TeamDetail.parse(await client.get(`/api/teams/${flags.team}`));
    const permission = flags.comment ? "comment" : "view";
    await client.request("PUT", `/api/artifacts/${artifact.id}/teams/${team.id}`, { permission });
    return out.result({ team: team.slug, permission }, () =>
      out.say(
        `✓ ${team.name} can ${permission} ${artifact.title}. Until a person confirms it, they can't approve.`,
      ),
    );
  }
  const permission = flags.publish ? "publish" : flags.comment ? "comment" : "view";
  const result = await client.post<{ url?: string }>(`/api/artifacts/${artifact.id}/access`, {
    email: flags.invite,
    permission,
  });
  out.result(result, () => out.say(result.url ?? `✓ ${flags.invite} can ${permission} ${artifact.title}.`));
}
