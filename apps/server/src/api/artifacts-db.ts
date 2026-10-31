import { and, eq } from "drizzle-orm";
import type { ArtifactResource } from "../auth/can.ts";
import { artifactAccess, artifacts } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import type { Deps } from "./deps.ts";
import type { ApiContext } from "./routes.ts";

export type ArtifactRow = typeof artifacts.$inferSelect;
export type LoadedArtifact = ArtifactResource & { row: ArtifactRow };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (value: string | undefined): value is string => !!value && UUID.test(value);

export async function toResource(deps: Deps, row: ArtifactRow): Promise<LoadedArtifact> {
  const access = await deps.db
    .select({
      personId: artifactAccess.personId,
      permission: artifactAccess.permission,
      viaToken: artifactAccess.viaToken,
    })
    .from(artifactAccess)
    .where(and(eq(artifactAccess.orgId, row.orgId), eq(artifactAccess.artifactId, row.id)));
  return {
    type: "artifact",
    id: row.id,
    projectId: row.projectId,
    visibility: row.visibility,
    publisherId: row.publisherId,
    archivedAt: row.archivedAt,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    access,
    row,
  };
}

export async function findArtifact(deps: Deps, orgId: string, id: string): Promise<LoadedArtifact | null> {
  const [row] = await deps.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.orgId, orgId), eq(artifacts.id, id)))
    .limit(1);
  return row ? toResource(deps, row) : null;
}

/** The `:id` artifact, for a route guard. Unknown ids are the same 404 as ones you can't see. */
export const artifactParam = (deps: Deps, name = "id") =>
  async function load(c: ApiContext): Promise<LoadedArtifact> {
    const id = c.req.param(name);
    const found = isUuid(id) ? await findArtifact(deps, c.get("org").id, id) : null;
    if (!found) throw new ApiError("not_found", "Not found.");
    return found;
  };
