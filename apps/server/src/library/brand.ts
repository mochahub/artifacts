import {
  type BrandProposal,
  Brand as BrandSchema,
  type OrgBrand,
  ProposeBrand,
  SaveBrand,
} from "@artifacts/schema";
import { FONT_STACKS } from "@artifacts/schema/theme-css";
import { and, desc, eq, isNull } from "drizzle-orm";
import { toResource } from "../api/artifacts-db.ts";
import type { Deps } from "../api/deps.ts";
import { type ApiContext, parseBody, type Routes, requireCan } from "../api/routes.ts";
import { artifacts, brandProposals, org, people, projects, versions } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { blobKey } from "../publish/blobs.ts";

/** The brand everyone renders with. One link per font, so the CLI needs no route of its own for them. */
export async function orgBrand(deps: Deps, stored: unknown): Promise<OrgBrand> {
  const parsed = BrandSchema.nullable().safeParse(stored ?? null);
  const brand = parsed.success ? parsed.data : null;
  return {
    brand,
    fonts: await Promise.all(
      (brand?.fonts ?? []).map(async (font) => ({
        hash: font.hash,
        url: await deps.bucket.presignGet(blobKey(font.hash)),
      })),
    ),
  };
}

export function brandRoutes(routes: Routes, deps: Deps) {
  const { db, clock } = deps;

  routes.get("/api/brand", { action: "brand.read" }, async (c) =>
    c.json(await orgBrand(deps, c.get("org").brand)),
  );

  routes.get("/api/brand/proposals", { action: "brand.read" }, async (c) => {
    const rows = await db
      .select({
        row: brandProposals,
        by: people.name,
        slug: artifacts.slug,
        project: projects.slug,
        artifact: artifacts,
      })
      .from(brandProposals)
      .innerJoin(people, eq(people.id, brandProposals.proposedBy))
      .leftJoin(artifacts, eq(artifacts.id, brandProposals.artifactId))
      .leftJoin(projects, eq(projects.id, artifacts.projectId))
      .where(eq(brandProposals.orgId, c.get("org").id))
      .orderBy(desc(brandProposals.createdAt))
      .limit(50);
    const applied = c.get("org").brand;
    const list: BrandProposal[] = rows.map(({ row, by, slug, project }) => ({
      id: row.id,
      name: row.name,
      brand: BrandSchema.parse(row.brand),
      sample: slug && project ? { project, slug } : null,
      proposedBy: by,
      agent: row.agent,
      createdAt: row.createdAt.toISOString(),
      appliedAt: row.appliedAt?.toISOString() ?? null,
      current: Bun.deepEquals(row.brand, applied),
    }));
    return c.json(list);
  });

  routes.post("/api/brand/proposals", { action: "brand.propose" }, async (c) => {
    const body = await parseBody(c, ProposeBrand);
    const orgId = c.get("org").id;
    const caller = c.get("caller");
    if (caller.kind !== "person" && caller.kind !== "cliToken") {
      throw new ApiError("forbidden", "You can't propose a brand.");
    }
    const [sample] = await db
      .select({ row: artifacts })
      .from(artifacts)
      .innerJoin(projects, eq(projects.id, artifacts.projectId))
      .where(and(eq(artifacts.orgId, orgId), eq(projects.slug, body.project), eq(artifacts.slug, body.slug)))
      .limit(1);
    if (!sample) throw new ApiError("not_found", "Publish the sample first.");
    const resource = await toResource(deps, sample.row);
    requireCan(c as ApiContext, "artifact.publish", resource);
    // Fonts are named by hash, so each must be a file the proposer really published, not any blob here.
    const [version] = await db
      .select({ files: versions.files })
      .from(versions)
      .where(and(eq(versions.artifactId, sample.row.id), eq(versions.n, sample.row.latestVersion)))
      .limit(1);
    const hashes = new Set(
      Object.values((version?.files ?? {}) as Record<string, { hash: string }>).map((file) => file.hash),
    );
    if (!body.brand.fonts.every((font) => hashes.has(font.hash))) {
      throw new ApiError("invalid", "A font isn't in the sample.");
    }
    const id = Bun.randomUUIDv7();
    await db.insert(brandProposals).values({
      id,
      orgId,
      name: body.brand.name,
      brand: body.brand,
      artifactId: sample.row.id,
      proposedBy: caller.person.id,
      agent: caller.kind === "cliToken" ? (body.agent ?? null) : null,
      createdAt: clock.now(),
    });
    return c.json({ id });
  });

  /**
   * A brand a person sets by hand, in Settings. It's kept as a proposal with no sample, so it can be
   * applied again later, and saving a name again replaces that one. No token can reach this (04).
   */
  routes.put("/api/brand", { action: "brand.apply" }, async (c) => {
    const body = await parseBody(c, SaveBrand);
    const orgId = c.get("org").id;
    const caller = c.get("caller");
    if (caller.kind !== "person") throw new ApiError("forbidden", "This needs a signed-in browser.");
    // Only fonts someone already published can stay: a hash sent here would presign any blob.
    const kept = BrandSchema.nullable().safeParse(c.get("org").brand ?? null).data?.fonts ?? [];
    const named = [body.theme.font, body.theme.display].filter((name) => name !== undefined);
    const fonts = kept.filter((font) => named.includes(font.family));
    for (const name of named) {
      if (!Object.hasOwn(FONT_STACKS, name) && !fonts.some((font) => font.family === name)) {
        throw new ApiError("invalid", `${name} isn't a font here. An agent can add your own.`);
      }
    }
    const brand = { ...body, fonts };
    await db.transaction(async (tx) => {
      await tx
        .delete(brandProposals)
        .where(
          and(
            eq(brandProposals.orgId, orgId),
            eq(brandProposals.name, brand.name),
            isNull(brandProposals.artifactId),
            isNull(brandProposals.agent),
          ),
        );
      await tx.insert(brandProposals).values({
        id: Bun.randomUUIDv7(),
        orgId,
        name: brand.name,
        brand,
        proposedBy: caller.person.id,
        createdAt: clock.now(),
        appliedAt: clock.now(),
        appliedBy: caller.person.id,
      });
      await tx.update(org).set({ brand }).where(eq(org.id, orgId));
    });
    return c.json({ ok: true });
  });

  /** A person's decision, in Settings. No token can reach this (04). */
  routes.post("/api/brand/proposals/:id/apply", { action: "brand.apply" }, async (c) => {
    const orgId = c.get("org").id;
    const caller = c.get("caller");
    if (caller.kind !== "person") throw new ApiError("forbidden", "This needs a signed-in browser.");
    const id = c.req.param("id") as string;
    const [row] = /^[0-9a-f-]{36}$/.test(id)
      ? await db
          .select()
          .from(brandProposals)
          .where(and(eq(brandProposals.orgId, orgId), eq(brandProposals.id, id)))
          .limit(1)
      : [];
    if (!row) throw new ApiError("not_found", "Not found.");
    await db.transaction(async (tx) => {
      await tx.update(org).set({ brand: row.brand }).where(eq(org.id, orgId));
      await tx
        .update(brandProposals)
        .set({ appliedAt: clock.now(), appliedBy: caller.person.id })
        .where(eq(brandProposals.id, row.id));
    });
    return c.json({ ok: true });
  });

  /** Back to the default. Applying an earlier proposal is how to go back to another brand. */
  routes.delete("/api/brand", { action: "brand.apply" }, async (c) => {
    await db
      .update(org)
      .set({ brand: null })
      .where(eq(org.id, c.get("org").id));
    return c.json({ ok: true });
  });
}
