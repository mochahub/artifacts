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
    comment?: boolean;
    publish?: boolean;
    expires?: string;
    server?: string;
  },
  out: Output,
) {
  if (!flags.link && !flags.invite) {
    throw new UsageError(
      "Usage: artifacts share --link [--comment] [--expires 1d|7d|30d] | --invite <email> [--comment|--publish]",
    );
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
  const permission = flags.publish ? "publish" : flags.comment ? "comment" : "view";
  const result = await client.post<{ url?: string }>(`/api/artifacts/${artifact.id}/access`, {
    email: flags.invite,
    permission,
  });
  out.result(result, () => out.say(result.url ?? `✓ ${flags.invite} can ${permission} ${artifact.title}.`));
}
