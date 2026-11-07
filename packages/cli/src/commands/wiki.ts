import { ArtifactLinks, CreateWiki, Slug, WikiCreated, WikiSpace } from "@artifacts/schema";
import type { Input } from "../command.ts";
import type { Output } from "../output.ts";
import { signedIn } from "../session.ts";
import { namedArtifact, resolveArtifact } from "../target.ts";

export function wikiSummary(space: WikiSpace): string[] {
  const page = (p: WikiSpace["pages"][number]) =>
    `  ${p.slug}  ${p.title}${p.untrusted ? " [untrusted]" : ""}${p.summary ? `: ${p.summary}` : ""}`;
  return [
    `${space.project.name}${space.project.personal ? " (personal)" : ""}`,
    "Rules",
    ...(space.rules ? [page(space.rules)] : ["  No rules page yet."]),
    "Pages",
    ...space.pages.map(page),
    "Sources",
    ...space.sources.map(page),
    "Garden",
    ...space.garden.map((f) => `${f.kind} ${f.slug}: ${f.message}`),
  ];
}

export function linksSummary(links: ArtifactLinks): string[] {
  return (["outgoing", "backlinks", "sources"] as const).flatMap((kind) => [
    kind === "outgoing" ? "Links" : kind === "backlinks" ? "Linked from" : "Sources",
    ...links[kind].map(
      (p) =>
        `  ${p.project}/${p.slug}${p.title ? `  ${p.title}` : ""}${!p.exists ? " [wanted]" : ""}${p.untrusted ? " [untrusted]" : ""}${p.summary ? `: ${p.summary}` : ""}`,
    ),
  ]);
}

export async function wikiCommand(
  {
    args: { sub, target },
    rest,
    flags,
    usage,
  }: Input<"sub" | "target", { name?: string; personal?: boolean; server?: string }>,
  out: Output,
) {
  if (!target || rest.length !== 2 || !["create", "show", "links"].includes(sub ?? "")) throw usage();
  if (sub !== "create" && (flags.name !== undefined || flags.personal !== undefined)) throw usage();
  if (sub === "links") namedArtifact(target);
  else if (!Slug.safeParse(target).success) throw usage();
  if (
    sub === "create" &&
    !CreateWiki.safeParse({ slug: target, name: flags.name ?? target, personal: flags.personal }).success
  )
    throw usage();
  const client = await signedIn(flags.server);
  if (sub === "create") {
    const result = WikiCreated.parse(
      await client.post("/api/wikis", {
        slug: target,
        name: flags.name ?? target,
        personal: flags.personal ?? false,
      }),
    );
    return out.result(result, () =>
      out.say(`${result.name}${result.personal ? " (personal)" : ""}\n${result.url}`),
    );
  }
  if (sub === "show") {
    const result = WikiSpace.parse(await client.get(`/api/wikis/${target}`));
    return out.result(result, () =>
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
