import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { ArtifactRow } from "../api/artifacts-db.ts";
import type { Deps } from "../api/deps.ts";
import type { Caller } from "../auth/caller.ts";
import { type ArtifactResource, can } from "../auth/can.ts";
import { artifactAccess, artifacts, projects } from "../db/schema.ts";

export type Loaded = { row: ArtifactRow; resource: ArtifactResource; projectSlug: string };

/**
 * Everything this caller can see, filtered by can() and nothing else. Lists and search start here, so
 * a hidden artifact can't reach a count, a snippet or a summary. It reads one row per artifact on every
 * call, which is about 15 ms per thousand artifacts (load-notes.md).
 */
export async function visibleTo(
  deps: Deps,
  orgId: string,
  caller: Caller,
  options: { projectId?: string; projectIds?: string[] } = {},
): Promise<Loaded[]> {
  const { projectId, projectIds } = options;
  const rows = await deps.db
    .select({ row: artifacts, projectSlug: projects.slug })
    .from(artifacts)
    .innerJoin(projects, eq(projects.id, artifacts.projectId))
    .where(
      and(
        eq(artifacts.orgId, orgId),
        isNull(artifacts.deletedAt),
        projectId ? eq(artifacts.projectId, projectId) : undefined,
        projectIds ? inArray(artifacts.projectId, projectIds) : undefined,
      ),
    )
    .orderBy(desc(artifacts.updatedAt));
  if (rows.length === 0) return [];
  // can() only ever reads the caller's own row, so nobody else's are loaded.
  const person = caller.kind === "person" || caller.kind === "cliToken" ? caller.person.id : null;
  const access = person
    ? await deps.db
        .select({
          artifactId: artifactAccess.artifactId,
          personId: artifactAccess.personId,
          permission: artifactAccess.permission,
          viaToken: artifactAccess.viaToken,
        })
        .from(artifactAccess)
        .where(and(eq(artifactAccess.orgId, orgId), eq(artifactAccess.personId, person)))
    : [];
  const byArtifact = new Map<string, typeof access>();
  for (const entry of access) {
    byArtifact.set(entry.artifactId, [...(byArtifact.get(entry.artifactId) ?? []), entry]);
  }
  const loaded: Loaded[] = [];
  for (const { row, projectSlug } of rows) {
    const resource: ArtifactResource = {
      type: "artifact",
      id: row.id,
      projectId: row.projectId,
      visibility: row.visibility,
      publisherId: row.publisherId,
      archivedAt: row.archivedAt,
      deletedAt: row.deletedAt,
      deletedBy: row.deletedBy,
      access: byArtifact.get(row.id) ?? [],
    };
    if (can(caller, "artifact.read", resource)) loaded.push({ row, resource, projectSlug });
  }
  return loaded;
}
