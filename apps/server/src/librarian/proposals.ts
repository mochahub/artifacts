import { createHash } from "node:crypto";
import { LibrarianProposal } from "@artifacts/schema";
import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/index.ts";
import { lockArtifact } from "../db/locks.ts";
import { librarianProposals, librarianReceipts, librarianRuns } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import type { RunFence } from "./leases.ts";
import { withToolReceipt } from "./mutations.ts";

/** Caller must check each citation with can() using this same transaction. No source text is persisted here. */
export async function storeProposal(
  deps: Deps,
  fence: RunFence,
  input: {
    proposalKey: string;
    inputHash: string;
    title: string;
    summary: string;
    markdown: string;
    sources: string[];
  },
  authorizeSources: (tx: Tx, wikiId: string, sources: string[]) => Promise<void>,
): Promise<{ proposalId: string }> {
  return withToolReceipt(
    deps,
    fence,
    { toolKey: input.proposalKey, inputHash: input.inputHash },
    async (tx) => {
      const [run] = await tx.select().from(librarianRuns).where(eq(librarianRuns.id, fence.runId));
      if (!run) throw new ApiError("not_found", "Not found.");
      const proposalId = crypto.randomUUID();
      const proposal = LibrarianProposal.parse({
        title: input.title,
        summary: input.summary,
        markdown: input.markdown,
        sources: input.sources,
        id: proposalId,
        runId: run.id,
        wikiId: run.wikiId,
        untrusted: true,
        status: "open",
      });

      await tx.insert(librarianProposals).values({
        ...proposal,
        orgId: fence.orgId,
        proposalKey: input.proposalKey,
        createdAt: deps.clock.now(),
      });
      return { proposalId };
    },
    async (tx) => {
      const [run] = await tx.select().from(librarianRuns).where(eq(librarianRuns.id, fence.runId));
      if (!run) throw new ApiError("not_found", "Not found.");
      await authorizeSources(tx, run.wikiId, input.sources);
    },
  );
}

/** Review adapter must check current session project.publish and page-create policy in tx.
 * create MUST use tx for page creation; never call a service opening its own transaction. */
export async function reviewProposal<T>(
  deps: Deps,
  input: {
    orgId: string;
    wikiId: string;
    proposalId: string;
    personId: string;
    reject?: boolean;
    requestId?: string;
  },
  authorize: (tx: Tx, proposal: typeof librarianProposals.$inferSelect) => Promise<void>,
  create: (
    tx: Tx,
    proposal: typeof librarianProposals.$inferSelect,
  ) => Promise<{ artifactId: string; result: T }>,
): Promise<{ artifactId?: string; result?: T; replay: boolean }> {
  return deps.db.transaction(async (tx) => {
    if (input.requestId) await lockArtifact(tx, input.requestId, "content");
    const [p] = await tx
      .select()
      .from(librarianProposals)
      .where(
        and(
          eq(librarianProposals.id, input.proposalId),
          eq(librarianProposals.orgId, input.orgId),
          eq(librarianProposals.wikiId, input.wikiId),
        ),
      )
      .for("update");
    if (!p) throw new ApiError("not_found", "Not found.");
    await authorize(tx, p);
    const reviewHash = createHash("sha256")
      .update(JSON.stringify([input.orgId, input.wikiId, input.proposalId, input.personId]))
      .digest("hex");
    if (input.requestId) {
      const [receipt] = await tx
        .select()
        .from(librarianReceipts)
        .where(and(eq(librarianReceipts.runId, p.runId), eq(librarianReceipts.toolKey, input.requestId)));
      if (receipt) {
        if (receipt.inputHash !== reviewHash) throw new ApiError("conflict", "Request already used.");
        return { artifactId: p.createdArtifactId ?? undefined, replay: true };
      }
    }
    if (!input.reject && p.status === "created")
      return { artifactId: p.createdArtifactId ?? undefined, replay: true };
    if (input.reject && p.status === "rejected") return { replay: true };
    if (p.status !== "open") throw new ApiError("conflict", "Proposal already reviewed.");
    const made = input.reject ? undefined : await create(tx, p);
    await tx
      .update(librarianProposals)
      .set({
        status: made ? "created" : "rejected",
        createdArtifactId: made?.artifactId,
        reviewedBy: input.personId,
        reviewedAt: deps.clock.now(),
      })
      .where(eq(librarianProposals.id, p.id));
    if (input.requestId && made)
      await tx.insert(librarianReceipts).values({
        orgId: input.orgId,
        runId: p.runId,
        toolKey: input.requestId,
        inputHash: reviewHash,
        result: { artifactId: made.artifactId },
      });
    return { artifactId: made?.artifactId, result: made?.result, replay: false };
  });
}
