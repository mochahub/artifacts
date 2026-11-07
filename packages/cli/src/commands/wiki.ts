import { ArtifactLinks, CreateWiki, ProjectRow, Slug, WikiCreated, WikiSpace } from "@artifacts/schema";
import type { Input } from "../command.ts";
import { type Output, UsageError } from "../output.ts";
import { signedIn } from "../session.ts";
import { namedArtifact, resolveArtifact } from "../target.ts";

export function wikiSummary(space: WikiSpace): string[] {
  const page = (p: WikiSpace["pages"][number]) =>
    `  ${p.slug}  ${p.title}${p.untrusted ? " [untrusted]" : ""}${p.summary ? `: ${p.summary}` : ""}${p.origin ? ` (${p.origin})` : ""}`;
  return [
    `${space.project.name} (${space.project.audience.label})`,
    "Rules",
    ...(space.rules ? [page(space.rules)] : ["  No rules page yet."]),
    "Pages",
    ...(space.pages.length ? space.pages.map(page) : ["  none"]),
    "Sources",
    ...(space.sources.length ? space.sources.map(page) : ["  none"]),
    "Garden",
    ...(space.garden.length ? space.garden.map((f) => `  ${f.kind} ${f.slug}: ${f.message}`) : ["  none"]),
    "Log",
    ...(space.log.length
      ? space.log
          .slice(0, LOG_LINES)
          .map(
            (e) =>
              `  ${e.at.slice(0, 10)}  ${e.kind}${e.slug ? `  ${e.slug}` : ""}${e.version ? ` v${e.version}` : ""}  by ${e.by}${e.agent ? ` (${e.agent})` : ""}${e.message ? `: ${e.message}` : ""}`,
          )
      : ["  none"]),
  ];
}

const LOG_LINES = 10;

/** The deprecated `personal` alias stays in payloads for released CLIs; this CLI's own output leaves it out. */
function withoutPersonal<T extends { personal?: boolean }>({ personal: _, ...rest }: T) {
  return rest;
}

/** The first thing wrong with a create request, in the user's own terms. */
function createProblem(target: string, flags: { team?: string }, body: unknown) {
  const issue = CreateWiki.safeParse(body).error?.issues[0];
  if (!issue) return null;
  const field = issue.path[0];
  if (field === "name") return "--name: use 1–80 characters.";
  if (field === "slug") return `Wiki name "${target}": ${issue.message}.`;
  if (issue.code === "custom") return "Choose --only-me or --team, not both.";
  return `--team "${flags.team ?? ""}": ${issue.message}.`;
}

export function linksSummary(links: ArtifactLinks): string[] {
  if (!links.wiki) return [];
  return [
    `Role: ${links.role}${links.untrusted ? " [untrusted]" : ""}${links.origin ? ` (${links.origin})` : ""}`,
    ...(["outgoing", "backlinks", "sources"] as const).flatMap((kind) => [
      kind === "outgoing" ? "Links" : kind === "backlinks" ? "Linked from" : "Sources",
      ...(links[kind].length
        ? links[kind].map(
            (p) =>
              `  ${p.project}/${p.slug}${p.title ? `  ${p.title}` : ""}${!p.exists ? " [wanted]" : ""}${p.untrusted ? " [untrusted]" : ""}${p.summary ? `: ${p.summary}` : ""}${p.origin ? ` (${p.origin})` : ""}`,
          )
        : ["  none"]),
    ]),
  ];
}

export async function wikiCommand(
  {
    args: { sub, target },
    rest,
    flags,
    usage,
  }: Input<
    "sub" | "target",
    { name?: string; personal?: boolean; "only-me"?: boolean; team?: string; server?: string }
  >,
  out: Output,
) {
  const operation = ["create", "show", "links", "list"].includes(sub ?? "");
  if (!operation || (sub === "list" ? rest.length !== 1 : !target || rest.length !== 2)) throw usage();
  if (
    sub !== "create" &&
    (flags.name !== undefined ||
      flags.personal !== undefined ||
      flags["only-me"] !== undefined ||
      flags.team !== undefined)
  )
    throw usage();
  if (target && sub === "links") namedArtifact(target);
  else if (target && sub !== "create" && !Slug.safeParse(target).success) throw usage();
  if (target && sub === "create") {
    const problem = createProblem(target, flags, {
      slug: target,
      name: flags.name ?? target,
      onlyMe: flags["only-me"],
      team: flags.team,
      personal: flags.personal,
    });
    if (problem) throw new UsageError(`${problem}\n${usage().message}`);
  }
  const client = await signedIn(flags.server);
  if (sub === "list") {
    const projects = ProjectRow.array().parse(await client.get("/api/projects"));
    const wikis = await Promise.all(
      projects
        .filter((p) => p.kind === "wiki")
        .map(async (p) => {
          const space = WikiSpace.parse(await client.get(`/api/wikis/${p.slug}`));
          return {
            slug: p.slug,
            name: p.name,
            audience: space.project.audience,
            pages: space.pages.length,
            sources: space.sources.length,
          };
        }),
    );
    return out.result(wikis, () =>
      out.say(
        wikis.length
          ? wikis
              .map(
                (w) =>
                  `${w.slug}  ${w.name} (${w.audience.label})  ${w.pages} ${w.pages === 1 ? "page" : "pages"}`,
              )
              .join("\n")
          : "No wikis yet. Make one with artifacts wiki create <slug>.",
      ),
    );
  }
  if (sub === "create") {
    const result = WikiCreated.parse(
      await client.post("/api/wikis", {
        slug: target,
        name: flags.name ?? target,
        onlyMe: flags["only-me"],
        team: flags.team,
        personal: flags.personal ?? false,
      }),
    );
    return out.result(withoutPersonal(result), () =>
      out.say(
        `${result.created === false ? "Already exists: " : ""}${result.name} (${result.audience.label})\n${result.url}`,
      ),
    );
  }
  if (sub === "show") {
    const result = WikiSpace.parse(await client.get(`/api/wikis/${target}`));
    return out.result({ ...result, project: withoutPersonal(result.project) }, () =>
      wikiSummary(result).forEach((line) => {
        out.say(line);
      }),
    );
  }
  const artifact = await resolveArtifact(client, target);
  const result = ArtifactLinks.parse(await client.get(`/api/artifacts/${artifact.id}/links`));
  out.result(result, () =>
    linksSummary(result).forEach((line) => {
      out.say(line);
    }),
  );
}
