import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { artifactResource, inheritedAccess, type LoadedArtifact } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { can, type Inherited } from "../auth/can.ts";
import { artifactAccess, artifacts, projects } from "../db/schema.ts";
import type { Deps } from "../deps.ts";

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
): Promise<LoadedArtifact[]> {
  const { projectId, projectIds } = options;
  const rows = await deps.db
    .select({ row: artifacts, project: projects })
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
  const list = rows.map(({ row }) => row);
  // can() only ever reads the caller's own rows, so nobody else's are loaded.
  const person = caller.kind === "person" || caller.kind === "cliToken" ? caller.person.id : null;
  const [access, inherited] = await Promise.all([
    person
      ? deps.db
          .select({
            artifactId: artifactAccess.artifactId,
            personId: artifactAccess.personId,
            permission: artifactAccess.permission,
            viaToken: artifactAccess.viaToken,
          })
          .from(artifactAccess)
          .where(and(eq(artifactAccess.orgId, orgId), eq(artifactAccess.personId, person)))
      : [],
    person
      ? inheritedAccess(
          deps,
          orgId,
          list,
          new Set(rows.filter(({ project }) => project.kind === "wiki").map(({ project }) => project.id)),
          person,
        )
      : new Map<string, Inherited[]>(),
  ]);
  const byArtifact = new Map<string, typeof access>();
  for (const entry of access) {
    byArtifact.set(entry.artifactId, [...(byArtifact.get(entry.artifactId) ?? []), entry]);
  }
  const loaded: LoadedArtifact[] = [];
  for (const { row, project } of rows) {
    const resource = artifactResource(
      row,
      project,
      byArtifact.get(row.id) ?? [],
      inherited.get(row.id) ?? [],
    );
    if (can(caller, "artifact.read", resource)) loaded.push({ ...resource, row, project });
  }
  return loaded;
}
