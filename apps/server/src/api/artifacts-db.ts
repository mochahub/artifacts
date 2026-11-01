import { and, eq, inArray } from "drizzle-orm";
import { type ArtifactResource, type Grant, type Inherited, inherit } from "../auth/can.ts";
import { artifactAccess, artifacts, artifactTeamAccess, teamMembers, teams } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import type { Deps } from "./deps.ts";
import type { ApiContext } from "./routes.ts";

export type ArtifactRow = typeof artifacts.$inferSelect;
export type LoadedArtifact = ArtifactResource & { row: ArtifactRow };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (value: string | undefined): value is string => !!value && UUID.test(value);

/**
 * Who holds each artifact through a team. Lists pass `personId`, which needs only that person's rows;
 * one artifact, or a push to many people, needs everyone's. Either way it's one query per concern.
 */
export async function inheritedAccess(
  deps: Deps,
  orgId: string,
  scope: { artifactIds: string[] } | { personId: string },
): Promise<Map<string, Inherited[]>> {
  const rows = await deps.db
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
        "personId" in scope
          ? eq(teamMembers.personId, scope.personId)
          : inArray(artifactTeamAccess.artifactId, scope.artifactIds),
      ),
    );
  const grants = new Map<string, Grant[]>();
  for (const { artifactId, ...grant } of rows) {
    grants.set(artifactId, [...(grants.get(artifactId) ?? []), { kind: "team", ...grant }]);
  }
  return new Map([...grants].map(([id, list]) => [id, inherit(list)]));
}

/** A row and its grants as can() reads them. The only place that shape is made. */
export const artifactResource = (
  row: ArtifactRow,
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
  inherited,
});

export async function toResources(deps: Deps, rows: ArtifactRow[]): Promise<LoadedArtifact[]> {
  const [first] = rows;
  if (!first) return [];
  const artifactIds = rows.map((row) => row.id);
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
    inheritedAccess(deps, first.orgId, { artifactIds }),
  ]);
  return rows.map((row) => ({
    ...artifactResource(
      row,
      access.filter((entry) => entry.artifactId === row.id),
      inherited.get(row.id) ?? [],
    ),
    row,
  }));
}

export async function toResource(deps: Deps, row: ArtifactRow): Promise<LoadedArtifact> {
  const [resource] = await toResources(deps, [row]);
  return resource as LoadedArtifact;
}

export async function findArtifact(deps: Deps, orgId: string, id: string): Promise<LoadedArtifact | null> {
  const [row] = await deps.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.orgId, orgId), eq(artifacts.id, id)))
    .limit(1);
  return row ? toResource(deps, row) : null;
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

/** The `:id` artifact, for a route guard. Unknown ids are the same 404 as ones you can't see. */
export const artifactParam = (deps: Deps, name = "id") =>
  async function load(c: ApiContext): Promise<LoadedArtifact> {
    const id = c.req.param(name);
    const found = isUuid(id) ? await findArtifact(deps, c.get("org").id, id) : null;
    if (!found) throw new ApiError("not_found", "Not found.");
    return found;
  };
