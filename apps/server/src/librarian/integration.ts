import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { findArtifact } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import {
  librarianConfig,
  librarianInbox,
  librarianRuns,
  librarianWikis,
  people,
  tokens,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { claimRun } from "./budget.ts";
import { ensureConfig, fenceAll } from "./config.ts";
import { createContentTools } from "./content-tools.ts";
import { createImmutableSource } from "./creation.ts";
import type { SandboxedExtractor } from "./ingestion/extractor.ts";
import { authorize, extractSource, promoteSource } from "./ingestion/index.ts";
import { remoteExtractor } from "./ingestion/remote-extractor.ts";
import { finishLocked, locked, type RunFence, withRunFence } from "./leases.ts";
import { type RunnerIntegration, registerLibrarianJob } from "./runner/index.ts";
import { guardedAnthropicProvider } from "./runner/provider.ts";
import { subscribeRunCancellation } from "./signals.ts";

/** Trusted construction only. Defaults use fenced content services and the guarded, late-loaded SDK.
 * Private tests may inject adapters; request data never selects them. Extraction needs explicit config. */
export function createLibrarianJob(
  deps: Deps,
  adapters: Pick<RunnerIntegration, "provider" | "authorizeTool" | "tool"> = {
    ...createContentTools(deps),
    provider: async (d, fence) => guardedAnthropicProvider(d, fence),
  },
  owner = crypto.randomUUID(),
  extractor?: SandboxedExtractor,
) {
  const integration: RunnerIntegration = {
    ...adapters,
    cancellation: subscribeRunCancellation,
    context: async (d, fence) =>
      withRunFence(d, fence, async (tx) => {
        const [run] = await tx.select().from(librarianRuns).where(eq(librarianRuns.id, fence.runId));
        if (!run?.inboxId) return null;
        const [item] = await tx
          .select()
          .from(librarianInbox)
          .where(and(eq(librarianInbox.id, run.inboxId), eq(librarianInbox.orgId, fence.orgId)));
        if (!item || !item.sourceArtifactId || item.wikiId !== run.wikiId || item.status === "cancelled")
          throw new Error("submission_unavailable");
        const scoped = { ...d, db: tx } as unknown as Deps;
        const caller = await submissionCaller(scoped, fence.orgId, item.submittedBy);
        await authorize(scoped, {
          orgId: fence.orgId,
          wikiId: run.wikiId,
          caller,
        });
        await adapters.authorizeTool(tx, fence, run.wikiId, "source_read", { page: item.sourceArtifactId });
        const source = await findArtifact(scoped, fence.orgId, item.sourceArtifactId);
        if (!source || source.projectId !== run.wikiId || !can(caller, "artifact.read", source))
          throw new Error("submission_unavailable");
        return {
          sourceRef: source.row.slug,
          inboxId: item.id,
          sourceId: item.sourceArtifactId,
          title: item.title,
          note: item.note,
          task: "process_source",
        };
      }),
    claim: async (d) => {
      if (!d.env.librarianAllowed) return null;
      const configs = await d.db.select().from(librarianConfig).where(eq(librarianConfig.enabled, true));
      for (const c of configs) {
        const selected = await d.db.select().from(librarianWikis).where(eq(librarianWikis.orgId, c.orgId));
        for (const wiki of selected) {
          const pending = await d.db
            .select()
            .from(librarianInbox)
            .where(
              and(
                eq(librarianInbox.orgId, c.orgId),
                eq(librarianInbox.wikiId, wiki.projectId),
                inArray(librarianInbox.status, ["ready", "queued"]),
                isNull(librarianInbox.runId),
              ),
            )
            .orderBy(asc(librarianInbox.submittedAt), asc(librarianInbox.id))
            .limit(1);
          const fence = await claimRun(d, {
            orgId: c.orgId,
            wikiId: wiki.projectId,
            owner,
            ...(pending[0] ? { inboxId: pending[0].id } : { daily: true }),
          });
          if (fence) {
            const item = pending[0];
            if (item?.status === "queued") {
              const cancellation = await subscribeRunCancellation(d, fence);
              try {
                // Refuse before URL/upload I/O unless a qualified deployment extractor was supplied.
                const sandbox = extractor ?? configuredExtractor(d, cancellation.signal);
                if (!sandbox) throw new Error("extractor_unavailable");
                const caller = await submissionCaller(d, c.orgId, item.submittedBy);
                const submission = { orgId: c.orgId, wikiId: wiki.projectId, caller };
                const source = await extractSource(d, submission, item.id, fence, sandbox);
                const creator = await createImmutableSource(d, submission, source, item.id);
                await promoteSource(d, submission, item.id, fence, source, creator);
              } catch {
                await finalizeExecution(d, fence, "failed");
                return null;
              } finally {
                await cancellation.close();
              }
            }
            return fence;
          }
        }
      }
      return null;
    },
    disableUnauthorized: async (d, fence) =>
      locked(d, fence.orgId, async (tx) => {
        const c = await ensureConfig(tx, fence.orgId);
        if (c.generation !== fence.configGeneration) return;
        await fenceAll(d, tx, fence.orgId);
        await tx
          .update(librarianConfig)
          .set({ enabled: false, generation: c.generation + 1, updatedAt: d.clock.now() })
          .where(eq(librarianConfig.orgId, fence.orgId));
      }),
    finish: finalizeExecution,
  };
  return registerLibrarianJob(deps, integration);
}
/** Terminal accounting remains possible after expiry or kill, without authorizing any content write. */
export async function finalizeExecution(
  deps: Deps,
  fence: RunFence,
  state: "waiting_human" | "succeeded" | "failed" | "budget_exhausted" | "interrupted",
) {
  await locked(deps, fence.orgId, async (tx) => {
    const [run] = await tx
      .select()
      .from(librarianRuns)
      .where(and(eq(librarianRuns.orgId, fence.orgId), eq(librarianRuns.id, fence.runId)));
    if (!run || run.owner !== fence.owner || run.state !== "running" || run.fence !== fence.fence) return;
    await finishLocked(deps, tx, run, state);
  });
}

/** Reload current submission authority; never reuse the admin creator as the model identity. */
async function submissionCaller(deps: Deps, orgId: string, id: string): Promise<Caller> {
  const [token] = await deps.db
    .select()
    .from(tokens)
    .where(and(eq(tokens.orgId, orgId), eq(tokens.id, id)));
  if (token) {
    if (token.kind !== "org" || token.revokedAt || (token.expiresAt && token.expiresAt <= deps.clock.now()))
      throw new Error("submission_unavailable");
    return {
      kind: "orgToken",
      tokenId: token.id,
      createdBy: token.createdBy,
      scopes: token.scopes,
      projectIds: token.projectIds,
    };
  }
  const [person] = await deps.db
    .select()
    .from(people)
    .where(and(eq(people.orgId, orgId), eq(people.id, id)));
  if (!person) throw new Error("submission_unavailable");
  return { kind: "person", person, sessionId: "librarian-ingestion", recentAuth: false };
}

/** No Docker launcher or socket exists in the public server. Missing config never enables parsing. */
function configuredExtractor(deps: Deps, signal: AbortSignal): SandboxedExtractor | undefined {
  const endpoint = deps.env.librarianExtractorEndpoint;
  const encoded = deps.env.librarianExtractorKey;
  if (!endpoint || !encoded) return undefined;
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) throw new Error("extractor_unavailable");
  return remoteExtractor({ endpoint, key, signal });
}
