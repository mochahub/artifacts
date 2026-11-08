import { z } from "zod";

export const Microusd = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const LibrarianRunState = z.enum([
  "queued",
  "running",
  "waiting_human",
  "succeeded",
  "failed",
  "cancelled",
  "budget_exhausted",
  "interrupted",
]);
export const LibrarianConfigEdit = z
  .object({
    expectedGeneration: z.number().int().nonnegative(),
    enabled: z.boolean(),
    wikiIds: z.array(z.uuid()).max(100),
    model: z.string().min(1).max(128),
    monthlyLimitMicrousd: Microusd,
    runLimitMicrousd: Microusd,
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.wikiIds).size === v.wikiIds.length &&
      v.runLimitMicrousd <= v.monthlyLimitMicrousd &&
      (!v.enabled || (v.wikiIds.length > 0 && v.runLimitMicrousd > 0)),
    "Invalid limits or selection",
  );
export const LibrarianConfig = z
  .object({
    enabled: z.boolean(),
    generation: z.number().int().nonnegative(),
    wikiIds: z.array(z.uuid()).max(100),
    model: z.string(),
    monthlyLimitMicrousd: Microusd,
    runLimitMicrousd: Microusd,
    keyConfigured: z.boolean(),
    keyGeneration: z.number().int().nonnegative(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type LibrarianConfig = z.infer<typeof LibrarianConfig>;
export const LibrarianKeyWrite = z
  .object({ key: z.string().min(1).max(4096), expectedGeneration: z.number().int().nonnegative() })
  .strict();
export const LibrarianGeneration = z.object({ expectedGeneration: z.number().int().nonnegative() }).strict();
export const SourceInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      text: z.string().refine((v) => new TextEncoder().encode(v).byteLength <= 1048576),
      title: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("url"),
      url: z
        .string()
        .max(2048)
        .url()
        .refine((value) => {
          try {
            const u = new URL(value);
            return (
              u.protocol === "https:" &&
              !u.port &&
              !u.username &&
              !u.password &&
              !u.hostname.includes(":") &&
              !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) &&
              !u.hash
            );
          } catch {
            return false;
          }
        }, "A public HTTPS hostname without credentials or fragment is required"),
      title: z.string().max(256).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("file"), uploadId: z.uuid(), title: z.string().max(256).optional() }).strict(),
]);
export type SourceInput = z.infer<typeof SourceInput>;
export const LibrarianUsage = z
  .object({ settledMicrousd: Microusd, uncertainMicrousd: Microusd, reservedMicrousd: Microusd })
  .strict();
export const LibrarianRun = z
  .object({
    id: z.uuid(),
    wikiId: z.uuid(),
    inboxId: z.uuid().optional(),
    state: LibrarianRunState,
    model: z.string(),
    configGeneration: z.number().int(),
    startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
    usage: LibrarianUsage,
    result: z
      .object({
        editRunIds: z.array(z.uuid()),
        proposalIds: z.array(z.uuid()),
        questionIds: z.array(z.uuid()),
      })
      .strict(),
    errorCode: z.string().optional(),
  })
  .strict();

export const LibrarianInbox = z
  .object({
    id: z.uuid(),
    wikiId: z.uuid(),
    kind: z.enum(["text", "url", "file"]),
    title: z.string(),
    status: z.enum([
      "queued",
      "extracting",
      "ready",
      "running",
      "waiting_human",
      "done",
      "failed",
      "cancelled",
    ]),
    submittedAt: z.iso.datetime(),
    sourceArtifactId: z.uuid().optional(),
    runId: z.uuid().optional(),
    errorCode: z.string().optional(),
  })
  .strict();
export type LibrarianInbox = z.infer<typeof LibrarianInbox>;
export const LibrarianProposal = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    wikiId: z.uuid(),
    title: z.string().min(1).max(256),
    summary: z.string().max(2000),
    markdown: z.string().refine((v) => new TextEncoder().encode(v).byteLength <= 1048576),
    sources: z.array(z.uuid()).max(100),
    untrusted: z.literal(true),
    status: z.enum(["open", "created", "rejected"]),
    createdArtifactId: z.uuid().optional(),
  })
  .strict();
export type LibrarianProposal = z.infer<typeof LibrarianProposal>;
export type LibrarianRun = z.infer<typeof LibrarianRun>;
export type LibrarianRunState = z.infer<typeof LibrarianRunState>;
export type LibrarianUsage = z.infer<typeof LibrarianUsage>;
export type LibrarianConfigEdit = z.infer<typeof LibrarianConfigEdit>;

/** Reviewed microdollars per million tokens; no pricing discovery or implicit approval. */
export const LibrarianProvision = z
  .object({
    expectedGeneration: z.number().int().nonnegative(),
    model: z.string().min(1).max(128),
    rateCard: z
      .object({
        input: z.string().regex(/^[1-9][0-9]{0,11}$/),
        output: z.string().regex(/^[1-9][0-9]{0,11}$/),
      })
      .strict(),
  })
  .strict();
