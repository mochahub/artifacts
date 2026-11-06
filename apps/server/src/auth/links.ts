import { and, eq } from "drizzle-orm";
import type { OrgRow } from "../db/index.ts";
import { artifacts, people, projects, shareLinks } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { sha256 } from "./secrets.ts";

/** A share link that still opens: not revoked and not expired (02). Each caller adds what else it needs. */
export const isLiveLink = (link: { revokedAt: Date | null; expiresAt: Date | null }, now: Date) =>
  !link.revokedAt && (!link.expiresAt || link.expiresAt > now);

/**
 * A share link by its secret, with what it opens, while it opens anything at all: link sharing on, the
 * link live, and its artifact not deleted, which stops links at once (SPEC §5.5).
 */
export async function findLiveLink(deps: Pick<Deps, "db" | "clock">, org: OrgRow, secret: string) {
  if (!org.settings.linkSharing) return null;
  const [row] = await deps.db
    .select({ link: shareLinks, artifact: artifacts, project: projects.slug, sharedBy: people.name })
    .from(shareLinks)
    .innerJoin(artifacts, eq(artifacts.id, shareLinks.artifactId))
    .innerJoin(projects, eq(projects.id, artifacts.projectId))
    .innerJoin(people, eq(people.id, shareLinks.createdBy))
    .where(and(eq(shareLinks.orgId, org.id), eq(shareLinks.tokenHash, sha256(secret))))
    .limit(1);
  return row && isLiveLink(row.link, deps.clock.now()) && !row.artifact.deletedAt ? row : null;
}
