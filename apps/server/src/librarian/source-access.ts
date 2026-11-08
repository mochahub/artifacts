import { and, eq } from "drizzle-orm";
import type { LoadedArtifact } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { librarianConfig, librarianInbox, librarianWikis, tokens, versions } from "../db/schema.ts";
import type { Deps } from "../deps.ts";

/** Explicit read-only service grant for trusted promoted sources. Human audiences stay unchanged.
 * Only the currently configured, live, wiki-scoped Librarian credential can exercise this grant. */
export async function canReadPromotedSource(
  deps: Deps,
  caller: Caller,
  resource: LoadedArtifact,
): Promise<boolean> {
  if (
    caller.kind !== "orgToken" ||
    resource.row.deletedAt ||
    !caller.projectIds?.includes(resource.projectId)
  )
    return false;
  const [config] = await deps.db
    .select()
    .from(librarianConfig)
    .where(eq(librarianConfig.orgId, resource.row.orgId));
  const [token] = await deps.db
    .select()
    .from(tokens)
    .where(and(eq(tokens.id, caller.tokenId), eq(tokens.orgId, resource.row.orgId)));
  const [selected] = await deps.db
    .select()
    .from(librarianWikis)
    .where(
      and(eq(librarianWikis.orgId, resource.row.orgId), eq(librarianWikis.projectId, resource.projectId)),
    );
  if (
    !selected ||
    config?.tokenId !== caller.tokenId ||
    !token ||
    token.kind !== "org" ||
    token.revokedAt ||
    (token.expiresAt && token.expiresAt <= deps.clock.now()) ||
    !token.scopes.includes("read") ||
    !token.projectIds?.includes(resource.projectId)
  )
    return false;
  const [inbox] = await deps.db
    .select()
    .from(librarianInbox)
    .where(
      and(
        eq(librarianInbox.orgId, resource.row.orgId),
        eq(librarianInbox.wikiId, resource.projectId),
        eq(librarianInbox.sourceArtifactId, resource.id),
      ),
    );
  const [version] = await deps.db
    .select()
    .from(versions)
    .where(and(eq(versions.artifactId, resource.id), eq(versions.n, resource.row.latestVersion)));
  return !!(
    inbox &&
    version?.wiki?.role === "source" &&
    version.wiki.untrusted &&
    version.files.original &&
    version.files["__librarian_source.json"] &&
    can(caller, "artifact.read", { ...resource, visibility: "org" })
  );
}
