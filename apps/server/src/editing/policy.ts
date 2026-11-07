import { type AgentPolicy, PRESENCE_TTL_MS } from "@artifacts/schema";
import { and, eq, gt, isNull, ne, or } from "drizzle-orm";
import { type LoadedArtifact, toProject } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { artifactAccess, artifactTeamAccess, editPresence, editRuns, shareLinks } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { wikiAudience } from "../wiki/service.ts";

export const POLICY_TEXT = {
  no_edit: "You can read this page, not edit it.",
  writing: "Someone is writing this page. Agents stay out until they switch to Pair or Delegate.",
  pair: "Someone is pairing on this page, so agent edits arrive as suggestions.",
  runDirect: "This Delegate run's edits apply directly.",
  runSuggestion: "This Delegate run's edits wait as one change set for a person to accept.",
  only_reader: "Only you can read this page, so agent edits apply directly.",
  maintained: "An owner marked this page agent-maintained, so agent edits apply directly.",
  audience: "Others can read this page, so agent edits arrive as suggestions.",
  person: "You edit directly.",
} as const;

/**
 * Whether anyone but the owner reads this page on its own grants: a person or team added to it, or a
 * share link that still works. The wiki's audience covers the project; this covers the page (13).
 */
async function sharedPage(deps: Deps, artifact: LoadedArtifact, ownerId: string | null) {
  const now = deps.clock.now();
  const [person, team, link] = await Promise.all([
    deps.db
      .select({ id: artifactAccess.personId })
      .from(artifactAccess)
      .where(
        and(
          eq(artifactAccess.artifactId, artifact.id),
          ownerId ? ne(artifactAccess.personId, ownerId) : undefined,
        ),
      )
      .limit(1),
    deps.db
      .select({ id: artifactTeamAccess.teamId })
      .from(artifactTeamAccess)
      .where(eq(artifactTeamAccess.artifactId, artifact.id))
      .limit(1),
    deps.db
      .select({ id: shareLinks.id })
      .from(shareLinks)
      .where(
        and(
          eq(shareLinks.artifactId, artifact.id),
          isNull(shareLinks.revokedAt),
          or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, now)),
        ),
      )
      .limit(1),
  ]);
  return person.length > 0 || team.length > 0 || link.length > 0;
}

export type Policy = AgentPolicy & { held(blockId: string): boolean };

/** Whose run, for the caller: its person, or an organization token itself. */
const ownsRun = (caller: Caller, run: { startedBy: string; tokenId: string | null }) =>
  caller.kind === "orgToken"
    ? run.tokenId === caller.tokenId
    : caller.kind === "cliToken" || caller.kind === "person"
      ? run.startedBy === caller.person.id
      : false;

/**
 * Step 5 of the policy, by audience (13): direct where the token's person is the wiki's one reader, or
 * on an agent-maintained page; suggestions anywhere else. A run's `edits` are fixed from this.
 */
export async function basePolicy(deps: Deps, caller: Caller, artifact: LoadedArtifact): Promise<AgentPolicy> {
  const { guidance } = await wikiAudience(deps, caller, await toProject(deps, artifact.project));
  // The wiki's only reader is its owner, and organization tokens that read it count in that audience.
  const owner = caller.kind === "person" || caller.kind === "cliToken" ? caller.person.id : null;
  if (guidance.edits === "direct" && !(await sharedPage(deps, artifact, owner)))
    return { edits: "direct", reason: "only_reader", text: POLICY_TEXT.only_reader };
  if (artifact.row.agentMaintained)
    return { edits: "direct", reason: "maintained", text: POLICY_TEXT.maintained };
  return { edits: "suggestion", reason: "audience", text: POLICY_TEXT.audience };
}

/** Fresh presence rows: who is in the editor now, on any replica. */
export async function freshPresence(deps: Deps, artifactId: string) {
  return deps.db
    .select({
      connectionId: editPresence.connectionId,
      personId: editPresence.personId,
      mode: editPresence.mode,
      blocks: editPresence.blocks,
      objects: editPresence.objects,
    })
    .from(editPresence)
    .where(
      and(
        eq(editPresence.artifactId, artifactId),
        gt(editPresence.seenAt, new Date(deps.clock.now().getTime() - PRESENCE_TTL_MS)),
      ),
    )
    .limit(200);
}

/**
 * How an agent's operation lands on this page now (13, "Policy: direct or suggestion"), in order: no edit
 * right, someone writing, someone pairing, the named Delegate run, then the audience. `suggest` turns any
 * direct into a suggestion. `held` says whether a person's caret or unsent changes are in a block, which
 * turns a direct replace or delete of it into a suggestion. The policy reads the caller's person for step
 * 5, so `DocState.agents` for a person is what their own agents would get.
 */
export async function agentPolicy(
  deps: Deps,
  caller: Caller,
  artifact: LoadedArtifact,
  options: { run?: string | null; suggest?: boolean; forAgents?: boolean } = {},
): Promise<Policy> {
  // A person in a browser always edits directly (13); `forAgents` asks what their agents would get.
  if (caller.kind === "person" && !options.forAgents) {
    if (!can(caller, "artifact.edit", artifact)) {
      return { edits: "refused", reason: "no_edit", text: POLICY_TEXT.no_edit, held: () => false };
    }
    return { edits: "direct", reason: "person", text: POLICY_TEXT.person, held: () => false };
  }
  const present = await freshPresence(deps, artifact.id);
  const heldBlocks = new Set(present.flatMap((row) => [...row.blocks, ...row.objects]));
  const held = (blockId: string) => heldBlocks.has(blockId);
  const decide = (policy: AgentPolicy): Policy => ({
    ...(options.suggest && policy.edits === "direct" ? { ...policy, edits: "suggestion" as const } : policy),
    held,
  });

  if (!can(caller, "artifact.edit", artifact)) {
    return { edits: "refused", reason: "no_edit", text: POLICY_TEXT.no_edit, held };
  }
  if (present.some((row) => row.mode === "write")) {
    return { edits: "refused", reason: "writing", text: POLICY_TEXT.writing, held };
  }
  if (present.some((row) => row.mode === "pair")) {
    return decide({ edits: "suggestion", reason: "pair", text: POLICY_TEXT.pair });
  }
  if (options.run) {
    const [run] = await deps.db
      .select({ edits: editRuns.edits, startedBy: editRuns.startedBy, tokenId: editRuns.tokenId })
      .from(editRuns)
      .where(
        and(
          eq(editRuns.id, options.run),
          eq(editRuns.artifactId, artifact.id),
          eq(editRuns.status, "active"),
          gt(editRuns.expiresAt, deps.clock.now()),
        ),
      )
      .limit(1);
    if (run && ownsRun(caller, run)) {
      return decide({
        edits: run.edits,
        reason: "run",
        text: run.edits === "direct" ? POLICY_TEXT.runDirect : POLICY_TEXT.runSuggestion,
      });
    }
  }
  return decide(await basePolicy(deps, caller, artifact));
}

export { ownsRun };
