import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { LoadedArtifact } from "../api/artifacts-db.ts";
import type { Deps } from "../api/deps.ts";
import { artifactAccess, artifactTeamAccess, people, projectAccess, teams } from "../db/schema.ts";

const list = (parts: string[]) =>
  parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/** Who can see an artifact, in words: "Everyone in Acme", or "Design team and 2 people". */
export async function audienceOf(deps: Deps, orgName: string, resource: LoadedArtifact, projectName: string) {
  if (resource.visibility === "org" && !resource.restricted) return `Everyone in ${orgName}`;
  const onProject = resource.visibility === "org";
  const [teamRows, added, granted] = await Promise.all([
    deps.db
      .select({ name: teams.name })
      .from(artifactTeamAccess)
      .innerJoin(teams, eq(teams.id, artifactTeamAccess.teamId))
      .where(eq(artifactTeamAccess.artifactId, resource.id)),
    deps.db
      .select({ id: artifactAccess.personId })
      .from(artifactAccess)
      .where(eq(artifactAccess.artifactId, resource.id)),
    onProject
      ? deps.db
          .select({ personId: projectAccess.personId, team: teams.name })
          .from(projectAccess)
          .leftJoin(teams, eq(teams.id, projectAccess.teamId))
          .where(eq(projectAccess.projectId, resource.projectId))
      : [],
  ]);
  const ids = [...new Set([...added.map((row) => row.id), ...granted.flatMap((row) => row.personId ?? [])])];
  const others = ids.length
    ? await deps.db
        .select({ id: people.id })
        .from(people)
        .where(and(inArray(people.id, ids), isNull(people.removedAt), ne(people.id, resource.publisherId)))
    : [];
  const names = [
    ...new Set([...teamRows.map((row) => row.name), ...granted.flatMap((row) => row.team ?? [])]),
  ];
  const parts = [
    ...names,
    ...(others.length ? [`${others.length} ${others.length === 1 ? "person" : "people"}`] : []),
  ];
  if (parts.length > 0) return list(parts);
  return onProject ? `Only people added to ${projectName}` : "Only the publisher";
}
