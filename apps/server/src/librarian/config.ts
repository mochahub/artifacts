import { createHash, randomBytes } from "node:crypto";
import { LibrarianConfig, type LibrarianConfigEdit } from "@artifacts/schema";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { Tx } from "../db/index.ts";
import {
  librarianConfig,
  librarianKeys,
  librarianRuns,
  librarianWikis,
  projects,
  tokens,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { decryptProviderKey, keyring } from "./keys.ts";
import { finishLocked, locked } from "./leases.ts";

export async function ensureConfig(tx: Tx, orgId: string) {
  await tx.insert(librarianConfig).values({ orgId }).onConflictDoNothing();
  const [row] = await tx.select().from(librarianConfig).where(eq(librarianConfig.orgId, orgId));
  if (!row) throw new Error("Missing librarian config");
  return row;
}
export function expectGeneration(actual: number, expected: number) {
  if (actual !== expected) throw new ApiError("conflict", "Librarian settings changed. Reload and retry.");
}
export async function fenceAll(deps: Deps, tx: Tx, orgId: string) {
  const rows = await tx.select().from(librarianRuns).where(eq(librarianRuns.orgId, orgId));
  for (const run of rows) await finishLocked(deps, tx, run, "cancelled");
}
export async function loadSafeConfig(deps: Deps, orgId: string): Promise<LibrarianConfig> {
  return locked(deps, orgId, async (tx) => {
    const c = await ensureConfig(tx, orgId);
    const [key] = await tx.select().from(librarianKeys).where(eq(librarianKeys.orgId, orgId));
    const wikis = await tx.select().from(librarianWikis).where(eq(librarianWikis.orgId, orgId));
    return LibrarianConfig.parse({
      enabled: c.enabled,
      generation: c.generation,
      wikiIds: wikis.map((w) => w.projectId),
      model: c.model,
      monthlyLimitMicrousd: Number(c.monthlyLimit),
      runLimitMicrousd: Number(c.runLimit),
      keyConfigured: !!key,
      keyGeneration: key?.generation ?? 0,
      updatedAt: c.updatedAt.toISOString(),
    });
  });
}
export async function saveConfig(
  deps: Deps,
  orgId: string,
  personId: string,
  input: z.infer<typeof LibrarianConfigEdit>,
): Promise<void> {
  await locked(deps, orgId, async (tx) => {
    const c = await ensureConfig(tx, orgId);
    expectGeneration(c.generation, input.expectedGeneration);
    const available = await tx.select().from(projects).where(eq(projects.orgId, orgId));
    if (input.wikiIds.some((id) => !available.some((p) => p.id === id && p.kind === "wiki")))
      throw new ApiError("invalid", "Invalid wiki selection.");
    if (input.enabled) {
      // No implicit pricing approval or identity creation. Runner integration must provision these explicitly.
      if (!deps.env.librarianAllowed || !c.rateCard || c.model !== input.model || !c.tokenId)
        throw new ApiError("invalid", "Librarian dispatch prerequisites unavailable.");
      const [key] = await tx.select().from(librarianKeys).where(eq(librarianKeys.orgId, orgId));
      if (!key) throw new ApiError("invalid", "Provider key required.");
      const plaintext = decryptProviderKey(key.envelope, orgId, key.generation, keyring(deps));
      plaintext.fill(0);
    }
    await fenceAll(deps, tx, orgId);
    if (c.tokenId) await tx.update(tokens).set({ projectIds: input.wikiIds }).where(eq(tokens.id, c.tokenId));
    await tx.delete(librarianWikis).where(eq(librarianWikis.orgId, orgId));
    if (input.wikiIds.length)
      await tx
        .insert(librarianWikis)
        .values(input.wikiIds.map((projectId) => ({ orgId, projectId, selectedBy: personId })));
    await tx
      .update(librarianConfig)
      .set({
        enabled: input.enabled,
        generation: c.generation + 1,
        model: input.model,
        rateCard: input.model === c.model ? c.rateCard : null,
        monthlyLimit: BigInt(input.monthlyLimitMicrousd),
        runLimit: BigInt(input.runLimitMicrousd),
        updatedBy: personId,
        updatedAt: deps.clock.now(),
      })
      .where(eq(librarianConfig.orgId, orgId));
  });
}

/** Admin-only entry point; provisioning never enables dispatch or returns a bearer. */
export async function provisionIdentity(
  deps: Deps,
  orgId: string,
  personId: string,
  input: { expectedGeneration: number; model: string; rateCard: { input: string; output: string } },
): Promise<void> {
  if (
    !input.model ||
    input.model.length > 128 ||
    ![input.rateCard.input, input.rateCard.output].every((v) => /^[1-9][0-9]{0,11}$/.test(v))
  )
    throw new ApiError("invalid", "Reviewed integer microdollar rates per million tokens required.");
  await locked(deps, orgId, async (tx) => {
    const c = await ensureConfig(tx, orgId);
    expectGeneration(c.generation, input.expectedGeneration);
    await fenceAll(deps, tx, orgId);
    const selected = await tx.select().from(librarianWikis).where(eq(librarianWikis.orgId, orgId));
    if (c.tokenId)
      await tx.update(tokens).set({ revokedAt: deps.clock.now() }).where(eq(tokens.id, c.tokenId));
    const tokenId = crypto.randomUUID();
    // An unguessable discarded preimage prevents this service identity being used as a bearer.
    const entropy = randomBytes(32);
    let tokenHash: string;
    try {
      tokenHash = createHash("sha256").update(entropy).digest("hex");
    } finally {
      entropy.fill(0);
    }
    await tx.insert(tokens).values({
      id: tokenId,
      orgId,
      kind: "org",
      name: "Librarian",
      tokenHash,
      createdBy: personId,
      scopes: ["read", "comment", "edit", "publish"],
      projectIds: selected.map((w) => w.projectId),
    });
    await tx
      .update(librarianConfig)
      .set({
        enabled: false,
        generation: c.generation + 1,
        tokenId,
        model: input.model,
        rateCard: input.rateCard,
        updatedBy: personId,
        updatedAt: deps.clock.now(),
      })
      .where(eq(librarianConfig.orgId, orgId));
  });
}
