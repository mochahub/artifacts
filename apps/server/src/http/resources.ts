import { and, eq } from "drizzle-orm";
import { findArtifact, type LoadedArtifact, type LoadedProject, toProject } from "../auth/access.ts";
import { projects } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "./errors.ts";
import { isUuid } from "./params.ts";
import type { ApiContext } from "./routes.ts";

/** The `:slug` project, for a route guard. */
export const projectParam = (deps: Deps, name = "slug") =>
  async function load(c: ApiContext): Promise<LoadedProject> {
    const [row] = await deps.db
      .select()
      .from(projects)
      .where(and(eq(projects.orgId, c.get("org").id), eq(projects.slug, c.req.param(name) as string)))
      .limit(1);
    if (!row) throw new ApiError("not_found", "Not found.");
    return toProject(deps, row);
  };

/** The `:id` artifact, for a route guard. Unknown ids are the same 404 as ones you can't see. */
export const artifactParam = (deps: Deps, name = "id") =>
  async function load(c: ApiContext): Promise<LoadedArtifact> {
    const id = c.req.param(name);
    const found = isUuid(id) ? await findArtifact(deps, c.get("org").id, id) : null;
    if (!found) throw new ApiError("not_found", "Not found.");
    return found;
  };
