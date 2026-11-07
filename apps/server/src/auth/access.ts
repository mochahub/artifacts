import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  artifactAccess,
  artifacts,
  artifactTeamAccess,
  projectAccess,
  projects,
  teamMembers,
  teams,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import type { Caller } from "./caller.ts";
import {
  type ArtifactResource,
  can,
  type Grant,
  type Inherited,
  inherit,
  type ProjectResource,
  projectLevels,
} from "./can.ts";

export type ArtifactRow = typeof artifacts.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
/** What can() reads, with the rows it came from, so nothing needs looking up again. */
export type LoadedArtifact = ArtifactResource & { row: ArtifactRow; project: ProjectRow };
export type LoadedProject = ProjectResource & { row: ProjectRow };

/**
 * Who holds what on each project, directly or through a team. Lists pass `personId`, which needs only
 * that person's rows.
 */
export async function projectGrants(
  deps: Deps,
  orgId: string,
  scope: { projectIds: string[] } | { personId: string },
): Promise<Map<string, Grant[]>> {
  const grants = new Map<string, Grant[]>();
  const add = (projectId: string, grant: Grant) =>
    grants.set(projectId, [...(grants.get(projectId) ?? []), grant]);
  const held = (column: typeof projectAccess.personId | typeof teamMembers.personId) =>
    and(
      eq(projectAccess.orgId, orgId),
      "personId" in scope ? eq(column, scope.personId) : inArray(projectAccess.projectId, scope.projectIds),
    );
  const [own, viaTeam] = await Promise.all([
    deps.db
      .select({
        projectId: projectAccess.projectId,
        personId: projectAccess.personId,
        level: projectAccess.permission,
      })
      .from(projectAccess)
      .where(and(held(projectAccess.personId), isNotNull(projectAccess.personId))),
    deps.db
      .select({
        projectId: projectAccess.projectId,
        personId: teamMembers.personId,
        level: projectAccess.permission,
        team: { id: teams.id, slug: teams.slug, name: teams.name },
      })
      .from(projectAccess)
      .innerJoin(teams, eq(teams.id, projectAccess.teamId))
      .innerJoin(teamMembers, eq(teamMembers.teamId, projectAccess.teamId))
      .where(held(teamMembers.personId)),
  ]);
  for (const { projectId, personId, level } of own) {
    add(projectId, { personId: personId as string, kind: "project", team: null, level, viaToken: false });
  }
  for (const { projectId, personId, level, team } of viaTeam) {
    add(projectId, { personId, kind: "project", team, level, viaToken: false });
  }
  return grants;
}

/**
 * Who holds each artifact through a team or its project. Lists pass `personId`, which needs only that
 * person's rows; one artifact, or a push to many people, needs everyone's. Either way it's one query
 * per concern. `wikis` holds the ids of the rows' projects that are wikis, where project grants can edit.
 */
export async function inheritedAccess(
  deps: Deps,
  orgId: string,
  rows: ArtifactRow[],
  wikis: ReadonlySet<string>,
  personId?: string,
): Promise<Map<string, Inherited[]>> {
  const artifactIds = rows.map((row) => row.id);
  const [shared, onProjects] = await Promise.all([
    deps.db
      .select({
        artifactId: artifactTeamAccess.artifactId,
        personId: teamMembers.personId,
        teamId: teams.id,
        slug: teams.slug,
        name: teams.name,
        level: artifactTeamAccess.permission,
        viaToken: artifactTeamAccess.viaToken,
      })
      .from(artifactTeamAccess)
      .innerJoin(teams, eq(teams.id, artifactTeamAccess.teamId))
      .innerJoin(teamMembers, eq(teamMembers.teamId, artifactTeamAccess.teamId))
      .where(
        and(
          eq(artifactTeamAccess.orgId, orgId),
          personId ? eq(teamMembers.personId, personId) : inArray(artifactTeamAccess.artifactId, artifactIds),
        ),
      ),
    projectGrants(
      deps,
      orgId,
      personId ? { personId } : { projectIds: [...new Set(rows.map((row) => row.projectId))] },
    ),
  ]);
  const onArtifacts = new Map<string, Grant[]>();
  for (const { artifactId, ...grant } of shared) {
    onArtifacts.set(artifactId, [...(onArtifacts.get(artifactId) ?? []), { kind: "team", ...grant }]);
  }
  return new Map(
    rows.map((row) => [
      row.id,
      inherit(
        [...(onArtifacts.get(row.id) ?? []), ...(onProjects.get(row.projectId) ?? [])],
        row.visibility,
        wikis.has(row.projectId),
      ),
    ]),
  );
}

/** A row and its grants as can() reads them. The only place that shape is made. */
export const artifactResource = (
  row: ArtifactRow,
  project: Pick<ProjectRow, "restricted" | "createdByToken" | "kind">,
  access: ArtifactResource["access"],
  inherited: Inherited[],
): ArtifactResource => ({
  type: "artifact",
  id: row.id,
  projectId: row.projectId,
  visibility: row.visibility,
  publisherId: row.publisherId,
  archivedAt: row.archivedAt,
  deletedAt: row.deletedAt,
  deletedBy: row.deletedBy,
  access,
  restricted: project.restricted,
  projectTokenId: project.createdByToken,
  inWiki: project.kind === "wiki",
  inherited,
});

export async function toResources(deps: Deps, rows: ArtifactRow[]): Promise<LoadedArtifact[]> {
  const [first] = rows;
  if (!first) return [];
  const artifactIds = rows.map((row) => row.id);
  const places = await deps.db
    .select()
    .from(projects)
    .where(inArray(projects.id, [...new Set(rows.map((row) => row.projectId))]));
  const wikis = new Set(places.filter((place) => place.kind === "wiki").map((place) => place.id));
  const [access, inherited] = await Promise.all([
    deps.db
      .select({
        artifactId: artifactAccess.artifactId,
        personId: artifactAccess.personId,
        permission: artifactAccess.permission,
        viaToken: artifactAccess.viaToken,
      })
      .from(artifactAccess)
      .where(and(eq(artifactAccess.orgId, first.orgId), inArray(artifactAccess.artifactId, artifactIds))),
    inheritedAccess(deps, first.orgId, rows, wikis),
  ]);
  return rows.map((row) => {
    const project = places.find((place) => place.id === row.projectId) as ProjectRow;
    return {
      ...artifactResource(
        row,
        project,
        access.filter((entry) => entry.artifactId === row.id),
        inherited.get(row.id) ?? [],
      ),
      row,
      project,
    };
  });
}

export async function toResource(deps: Deps, row: ArtifactRow): Promise<LoadedArtifact> {
  const [resource] = await toResources(deps, [row]);
  return resource as LoadedArtifact;
}

export async function toProject(deps: Deps, row: ProjectRow): Promise<LoadedProject> {
  const grants = await projectGrants(deps, row.orgId, { projectIds: [row.id] });
  return {
    type: "project",
    id: row.id,
    restricted: row.restricted,
    tokenId: row.createdByToken,
    grants: projectLevels(grants.get(row.id) ?? []),
    row,
  };
}

/** Projects a person holds a grant on, seen or not through any artifact, as can() allows. */
export async function heldProjects(deps: Deps, orgId: string, caller: Caller): Promise<ProjectRow[]> {
  if (caller.kind !== "person" && caller.kind !== "cliToken") return [];
  const grants = await projectGrants(deps, orgId, { personId: caller.person.id });
  if (grants.size === 0) return [];
  const rows = await deps.db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), inArray(projects.id, [...grants.keys()])));
  return rows.filter((row) =>
    can(caller, "project.read", {
      type: "project",
      id: row.id,
      restricted: row.restricted,
      tokenId: row.createdByToken,
      grants: projectLevels(grants.get(row.id) ?? []),
    }),
  );
}

export async function findArtifact(deps: Deps, orgId: string, id: string): Promise<LoadedArtifact | null> {
  const [row] = await deps.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.orgId, orgId), eq(artifacts.id, id)))
    .limit(1);
  return row ? toResource(deps, row) : null;
}

export async function findArtifactBySlug(
  deps: Deps,
  orgId: string,
  project: string,
  slug: string,
): Promise<LoadedArtifact | null> {
  const [found] = await deps.db
    .select({ row: artifacts })
    .from(artifacts)
    .innerJoin(projects, eq(projects.id, artifacts.projectId))
    .where(and(eq(artifacts.orgId, orgId), eq(projects.slug, project), eq(artifacts.slug, slug)))
    .limit(1);
  return found ? toResource(deps, found.row) : null;
}

/** Many at once, for feeds that would otherwise ask per artifact. */
export async function findArtifacts(deps: Deps, orgId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, LoadedArtifact>();
  const rows = await deps.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.orgId, orgId), inArray(artifacts.id, ids)));
  return new Map((await toResources(deps, rows)).map((resource) => [resource.id, resource]));
}
