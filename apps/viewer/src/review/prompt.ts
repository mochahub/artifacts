import { artifactHref } from "../paths.ts";

/**
 * The prompt that sends an agent to a review. It names the artifact and leaves the comments out:
 * guests can write them, and pasted text would read as the person's own instructions. The CLI needs
 * `<project>/<slug>`, not a URL, and `artifacts reply` only works next to the source.
 */
export function agentPrompt(artifact: { project: string; slug: string }, origin: string) {
  const ref = `${artifact.project}/${artifact.slug}`;
  return [
    `Address the open comments on ${ref} using the artifacts skill.`,
    `If the source isn't in this repo, run \`artifacts pull ${ref}\` first.`,
    `${origin}${artifactHref(artifact)}`,
  ].join("\n");
}
