import { createHash, randomUUID } from "node:crypto";
import { SourceInput } from "@artifacts/schema";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { findArtifact, toProject } from "../../auth/access.ts";
import type { Caller } from "../../auth/caller.ts";
import { can } from "../../auth/can.ts";
import type { Tx } from "../../db/index.ts";
import {
  librarianConfig,
  librarianInbox,
  librarianWikis,
  people,
  projects,
  tokens,
} from "../../db/schema.ts";
import type { Deps } from "../../deps.ts";
import { ApiError } from "../../http/errors.ts";
import { createImmutableSource } from "../creation.ts";
import { type RunFence, withRunFence } from "../index.ts";
import { locked } from "../leases.ts";
import { canReadPromotedSource } from "../source-access.ts";
import {
  EXTRACTION_VERSION,
  extractBytes,
  MIME_TYPES,
  type SandboxedExtractor,
  safeFilename,
} from "./extractor.ts";
import { fetchPublicSource } from "./transport.ts";

export const EnqueueRequest = z
  .object({ idempotencyKey: z.uuid(), source: SourceInput, note: z.string().max(2000).optional() })
  .strict();
export const UploadRequest = z
  .object({
    name: z.string().refine(safeFilename),
    size: z.number().int().positive().max(10485760),
    contentType: z.enum(MIME_TYPES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Submission = { orgId: string; wikiId: string; caller: Caller };
type Row = typeof librarianInbox.$inferSelect;
const missing = () => new ApiError("not_found", "Not found.");
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export function submitter(caller: Caller): string {
  if (caller.kind === "person" || caller.kind === "cliToken") return caller.person.id;
  if (caller.kind === "orgToken") return caller.tokenId;
  throw missing();
}
export async function authorize(deps: Deps, input: Submission): Promise<void> {
  const [wiki] = await deps.db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, input.orgId), eq(projects.id, input.wikiId)));
  if (wiki?.kind !== "wiki" || !can(input.caller, "project.publish", await toProject(deps, wiki)))
    throw missing();
  const [selected] = await deps.db
    .select()
    .from(librarianWikis)
    .where(and(eq(librarianWikis.orgId, input.orgId), eq(librarianWikis.projectId, input.wikiId)));
  if (!selected) throw missing();
}
const prefix = (orgId: string, id: string) => `librarian/${orgId}/${id}/`;
async function boundedObject(deps: Deps, key: string, max: number) {
  const head = await deps.bucket.head(key);
  if (!head || head.size < 1 || head.size > max)
    throw new ApiError("invalid", "Upload is incomplete or invalid.");
  const bytes = await deps.bucket.getRange(key, 0, max);
  if (!bytes || bytes.length !== head.size || bytes.length > max)
    throw new ApiError("invalid", "Upload is incomplete or invalid.");
  return bytes;
}
const Ticket = UploadRequest.extend({ owner: z.uuid(), wikiId: z.uuid(), expires: z.number() });
export async function createUpload(deps: Deps, input: Submission, raw: unknown) {
  await authorize(deps, input);
  const request = UploadRequest.parse(raw);
  const id = randomUUID();
  const key = prefix(input.orgId, id);
  const expires = deps.clock.now().getTime() + 15 * 60_000;
  await deps.bucket.put(
    `${key}ticket.json`,
    JSON.stringify({ ...request, owner: submitter(input.caller), wikiId: input.wikiId, expires }),
    { ifNoneMatch: "*", contentType: "application/json" },
  );
  return {
    uploadId: id,
    expiresAt: new Date(expires).toISOString(),
    ...(await deps.bucket.presignPut(`${key}original`, {
      contentType: request.contentType,
      contentLength: request.size,
      cacheControl: "no-store",
    })),
  };
}
async function completedUpload(deps: Deps, input: Submission, id: string, accepted = false) {
  const key = prefix(input.orgId, id);
  const ticket = Ticket.parse(
    JSON.parse(Buffer.from(await boundedObject(deps, `${key}ticket.json`, 4096)).toString()),
  );
  if (
    ticket.owner !== submitter(input.caller) ||
    ticket.wikiId !== input.wikiId ||
    (!accepted && ticket.expires <= deps.clock.now().getTime())
  )
    throw missing();
  const bytes = await boundedObject(deps, `${key}original`, ticket.size);
  if (bytes.length !== ticket.size || sha256(bytes) !== ticket.sha256)
    throw new ApiError("invalid", "Upload verification failed.");
  return { bytes, mime: ticket.contentType, key: `${key}original` };
}
export function payloadDigest(wikiId: string, request: z.infer<typeof EnqueueRequest>): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, val]) => [k, sort(val)]),
          )
        : v;
  return sha256(JSON.stringify(sort({ wikiId, source: request.source, note: request.note ?? null })));
}
export async function enqueueSource(deps: Deps, input: Submission, raw: unknown) {
  const request = EnqueueRequest.parse(raw);
  await authorize(deps, input);
  const owner = submitter(input.caller);
  // Explicit property order makes omitted/undefined optional fields canonical across JSON clients.
  const payloadHash = payloadDigest(input.wikiId, request);
  const [existing] = await deps.db
    .select()
    .from(librarianInbox)
    .where(
      and(
        eq(librarianInbox.orgId, input.orgId),
        eq(librarianInbox.submittedBy, owner),
        eq(librarianInbox.idempotencyKey, request.idempotencyKey),
      ),
    );
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new ApiError("conflict", "Idempotency key already used.");
    return { item: safeInbox(existing), replay: true };
  }
  const upload =
    request.source.kind === "file" ? await completedUpload(deps, input, request.source.uploadId) : null;
  return locked(deps, input.orgId, async (tx) => {
    const scoped = { ...deps, db: tx } as unknown as Deps;
    await authorize(scoped, input);
    const [prior] = await tx
      .select()
      .from(librarianInbox)
      .where(
        and(
          eq(librarianInbox.orgId, input.orgId),
          eq(librarianInbox.submittedBy, owner),
          eq(librarianInbox.idempotencyKey, request.idempotencyKey),
        ),
      );
    if (prior) {
      if (prior.payloadHash !== payloadHash) throw new ApiError("conflict", "Idempotency key already used.");
      return { item: safeInbox(prior), replay: true };
    }

    const now = deps.clock.now();
    const [row] = await tx
      .insert(librarianInbox)
      .values({
        id: request.source.kind === "file" ? request.source.uploadId : randomUUID(),
        quarantineKey: upload?.key,
        orgId: input.orgId,
        wikiId: input.wikiId,
        submittedBy: owner,
        kind: request.source.kind,
        title: request.source.title || "Source",
        input: {
          ...request.source,
          ...(input.caller.kind === "cliToken" ? { submittedTokenId: input.caller.tokenId } : {}),
        },
        note: request.note,
        payloadHash,
        idempotencyKey: request.idempotencyKey,
        submittedAt: now,
        updatedAt: now,
        rawExpiresAt: new Date(now.getTime() + 7 * 86400000),
      })
      .returning();
    if (!row) throw new Error("inbox_insert_failed");
    return { item: safeInbox(row), replay: false };
  });
}
export function safeInbox(row: Row) {
  return {
    id: row.id,
    wikiId: row.wikiId,
    kind: row.kind,
    title: row.title,
    status: row.status,
    submittedAt: row.submittedAt.toISOString(),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
  };
}
export async function ownedInbox(deps: Deps, input: Submission, id: string) {
  await authorize(deps, input);
  if (!z.uuid().safeParse(id).success) throw missing();
  const [row] = await deps.db
    .select()
    .from(librarianInbox)
    .where(
      and(
        eq(librarianInbox.orgId, input.orgId),
        eq(librarianInbox.wikiId, input.wikiId),
        eq(librarianInbox.id, id),
      ),
    );
  if (
    !row ||
    (row.submittedBy !== submitter(input.caller) &&
      !(
        input.caller.kind === "person" &&
        (input.caller.person.role === "admin" || input.caller.person.role === "owner")
      ))
  )
    throw missing();
  return row;
}
export type ExtractedSource = {
  bytes: Uint8Array;
  mime: string;
  text: string;
  hash: string;
  extractionVersion: string;
  untrusted: true;
};
const extracted = new WeakMap<ExtractedSource, { id: string; orgId: string; wikiId: string }>();
export async function extractSource(
  deps: Deps,
  input: Submission,
  id: string,
  fence: RunFence,
  sandbox?: SandboxedExtractor,
): Promise<ExtractedSource> {
  const row = await ownedInbox(deps, input, id);
  if (
    fence.orgId !== input.orgId ||
    row.runId !== fence.runId ||
    row.status === "cancelled" ||
    !row.input ||
    row.rawExpiresAt <= deps.clock.now()
  )
    throw missing();
  await withRunFence(deps, fence, async (tx) => {
    await authorize({ ...deps, db: tx } as unknown as Deps, input);
  });
  let source: { bytes: Uint8Array; mime: string };
  if (row.input.kind === "text") source = { bytes: Buffer.from(row.input.text), mime: "text/plain" };
  else if (row.input.kind === "url") source = await fetchPublicSource(row.input.url);
  else source = await completedUpload(deps, input, row.input.uploadId, true);
  const text = await extractBytes(source.bytes, source.mime, sandbox);
  const result: ExtractedSource = {
    ...source,
    text,
    hash: sha256(source.bytes),
    extractionVersion: EXTRACTION_VERSION,
    untrusted: true,
  };
  extracted.set(result, { id, orgId: input.orgId, wikiId: input.wikiId });
  return result;
}
/** Adapter must create an immutable untrusted source through the existing trusted publish pipeline in this transaction.
 * It receives original bytes, provenance and plain extracted text; never a model-generated page. */
export type TrustedSourceCreator = (tx: Tx, source: ExtractedSource, inbox: Readonly<Row>) => Promise<string>;
export async function promoteSource(
  deps: Deps,
  input: Submission,
  id: string,
  fence: RunFence,
  source: ExtractedSource,
  create?: TrustedSourceCreator,
): Promise<string> {
  const provenance = extracted.get(source);
  if (
    !provenance ||
    provenance.id !== id ||
    provenance.orgId !== input.orgId ||
    provenance.wikiId !== input.wikiId
  )
    throw new Error("source_provenance_failed");
  if (sha256(source.bytes) !== source.hash || source.untrusted !== true)
    throw new Error("source_integrity_failed");
  await withRunFence(deps, fence, async (tx) => {
    await authorize({ ...deps, db: tx } as unknown as Deps, input);
  });
  const creator = create ?? (await createImmutableSource(deps, input, source, id));
  const artifactId = await withRunFence(deps, fence, async (tx) => {
    const scoped = { ...deps, db: tx } as unknown as Deps;
    const row = await ownedInbox(scoped, input, id);
    input = { ...input, caller: await currentSubmitter(scoped, input, row) };
    await authorize(scoped, input);
    if (row.runId !== fence.runId || row.status === "cancelled" || row.rawExpiresAt <= deps.clock.now())
      throw missing();
    const visibleSource = async (artifactId: string) => {
      const artifact = await findArtifact(scoped, input.orgId, artifactId);
      return artifact?.project.id === input.wikiId && can(input.caller, "artifact.read", artifact);
    };
    if (row.sourceArtifactId) {
      if (!(await visibleSource(row.sourceArtifactId))) throw missing();
      return row.sourceArtifactId;
    }
    const duplicates = await tx
      .select()
      .from(librarianInbox)
      .where(
        and(
          eq(librarianInbox.orgId, input.orgId),
          eq(librarianInbox.wikiId, input.wikiId),
          eq(librarianInbox.sourceHash, source.hash),
        ),
      );
    // A matching hash is not a grant. Hidden sources must never be reused or disclosed.
    let reusable: string | undefined;
    for (const duplicate of duplicates) {
      if (duplicate.sourceArtifactId && (await visibleSource(duplicate.sourceArtifactId))) {
        reusable = duplicate.sourceArtifactId;
        break;
      }
    }
    const created = reusable ?? (await creator(tx, source, row));
    await tx
      .update(librarianInbox)
      .set({
        sourceArtifactId: created,
        sourceHash: source.hash,
        extractionVersion: source.extractionVersion,
        input: null,
        status: "ready",
        updatedAt: deps.clock.now(),
      })
      .where(eq(librarianInbox.id, id));
    const [config] = await tx.select().from(librarianConfig).where(eq(librarianConfig.orgId, input.orgId));
    const [service] = config?.tokenId
      ? await tx.select().from(tokens).where(eq(tokens.id, config.tokenId))
      : [];
    const resource = await findArtifact(scoped, input.orgId, created);
    if (
      !service ||
      !resource ||
      !(await canReadPromotedSource(
        scoped,
        {
          kind: "orgToken",
          tokenId: service.id,
          createdBy: service.createdBy,
          scopes: service.scopes,
          projectIds: service.projectIds,
        },
        resource,
      ))
    )
      throw missing();
    return created;
  });
  await deps.bucket.deletePrefix(prefix(input.orgId, id));
  return artifactId;
}
export async function cleanupExpiredSources(deps: Deps, orgId: string) {
  const rows = await deps.db
    .select()
    .from(librarianInbox)
    .where(and(eq(librarianInbox.orgId, orgId), lt(librarianInbox.rawExpiresAt, deps.clock.now())))
    .limit(100);
  for (const row of rows) {
    await deps.bucket.deletePrefix(prefix(orgId, row.id));
    await deps.db
      .update(librarianInbox)
      .set({ input: null, quarantineKey: null, note: null })
      .where(eq(librarianInbox.id, row.id));
  }
}

/** Root retention job calls this for orphan tickets too. Never exposes quarantine URLs. */
export async function cleanupQuarantine(deps: Deps, orgId: string): Promise<void> {
  const cutoff = deps.clock.now().getTime() - 7 * 86400000;
  for await (const page of deps.bucket.listAll(`librarian/${orgId}/`)) {
    for (const object of page) if (object.updatedAt.getTime() < cutoff) await deps.bucket.delete(object.key);
  }
  await cleanupExpiredSources(deps, orgId);
}
/** Call before deleting inbox/account rows, so no orphan survives account purge. */
export async function deleteSourceQuarantine(deps: Deps, orgId: string, inboxId?: string): Promise<void> {
  if (!z.uuid().safeParse(orgId).success || (inboxId && !z.uuid().safeParse(inboxId).success))
    throw missing();
  await deps.bucket.deletePrefix(inboxId ? prefix(orgId, inboxId) : `librarian/${orgId}/`);
}

/** Reload the actual principal and originating CLI credential after extraction I/O. */
export async function currentSubmitter(deps: Deps, input: Submission, row: Row): Promise<Caller> {
  const tokenId =
    (row.input as { submittedTokenId?: string } | null)?.submittedTokenId ??
    (input.caller.kind === "cliToken" || input.caller.kind === "orgToken" ? input.caller.tokenId : undefined);
  if (tokenId) {
    const [token] = await deps.db
      .select()
      .from(tokens)
      .where(and(eq(tokens.id, tokenId), eq(tokens.orgId, input.orgId)));
    if (!token || token.revokedAt || (token.expiresAt && token.expiresAt <= deps.clock.now()))
      throw missing();
    if (token.kind === "org") {
      if (row.submittedBy !== token.id) throw missing();
      return {
        kind: "orgToken",
        tokenId,
        createdBy: token.createdBy,
        scopes: token.scopes,
        projectIds: token.projectIds,
      };
    }
    if (token.personId !== row.submittedBy) throw missing();
    const [person] = await deps.db
      .select()
      .from(people)
      .where(and(eq(people.id, row.submittedBy), eq(people.orgId, input.orgId)));
    if (!person || person.removedAt) throw missing();
    return { kind: "cliToken", tokenId, scopes: token.scopes, person };
  }
  const [person] = await deps.db
    .select()
    .from(people)
    .where(and(eq(people.id, row.submittedBy), eq(people.orgId, input.orgId)));
  if (!person || person.removedAt) throw missing();
  return { kind: "person", person, sessionId: "librarian-ingestion", recentAuth: false };
}
