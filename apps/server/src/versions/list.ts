import { and, desc, eq, isNull } from "drizzle-orm";
import { people, versions } from "../db/schema.ts";
import type { Deps } from "../deps.ts";

export const listVersions = (deps: Pick<Deps, "db">, artifactId: string, limit?: number) => {
  const query = deps.db
    .select({ version: versions, by: people.name })
    .from(versions)
    .innerJoin(people, eq(people.id, versions.publishedBy))
    .where(and(eq(versions.artifactId, artifactId), isNull(versions.deletedAt)))
    .orderBy(desc(versions.n));
  return limit === undefined ? query : query.limit(limit);
};
