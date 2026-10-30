import type { Caller, CallerPerson } from "./caller.ts";

export const ACTIONS = [
  "account.read",
  "account.manage",
  "home.read",
  "project.list",
  "project.read",
  "project.create",
  "artifact.read",
  "artifact.comment",
  "thread.resolve",
  "artifact.decide",
  "artifact.publish",
  "artifact.manage",
  "artifact.share",
  "artifact.archive",
  "artifact.delete",
  "artifact.purge",
  "deleted.read",
  "data.read",
  "data.write",
  "data.export",
  "org.read",
  "org.manage",
  "people.read",
  "people.manage",
  "people.invite",
  "tokens.manage",
] as const;
export type Action = (typeof ACTIONS)[number];

export type ArtifactResource = {
  type: "artifact";
  id: string;
  projectId: string;
  visibility: "me" | "org";
  publisherId: string;
  archivedAt: Date | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  /** artifact_access rows for this artifact. */
  access: { personId: string; permission: "view" | "comment" | "publish" }[];
};
export type Resource = ArtifactResource | { type: "org" };

const isAdmin = (person: CallerPerson) => person.role === "owner" || person.role === "admin";

/** The person a session or CLI token acts as. */
const personOf = (caller: Caller): CallerPerson | null =>
  caller.kind === "person" || caller.kind === "cliToken" ? caller.person : null;

/** Sessions have no scopes; tokens have only theirs. */
const hasScope = (caller: Caller, scope: string) =>
  caller.kind === "person" ||
  ((caller.kind === "cliToken" || caller.kind === "orgToken") && caller.scopes.includes(scope));

const activeLink = (caller: Caller, artifactId: string) =>
  caller.kind === "guest"
    ? caller.links.find((link) => link.artifactId === artifactId && link.active)
    : undefined;

/** "Visibility first" in 04, ignoring deletion. Also decides who is told an artifact was deleted. */
export function seesArtifact(caller: Caller, artifact: ArtifactResource): boolean {
  if (!hasScope(caller, "read") && caller.kind !== "guest" && caller.kind !== "content") return false;
  switch (caller.kind) {
    case "person":
    case "cliToken": {
      const { person } = caller;
      if (isAdmin(person)) return true;
      const added = artifact.access.some((row) => row.personId === person.id);
      if (person.role === "outside") return added;
      return artifact.visibility === "org" || artifact.publisherId === person.id || added;
    }
    case "orgToken":
      return (
        artifact.visibility === "org" &&
        (caller.projectIds === null || caller.projectIds.includes(artifact.projectId))
      );
    case "guest":
      return activeLink(caller, artifact.id) !== undefined;
    case "content":
      return caller.artifactId === artifact.id;
    case "anonymous":
      return false;
  }
}

function mayComment(caller: Caller, artifact: ArtifactResource): boolean {
  if (caller.kind === "guest") return activeLink(caller, artifact.id)?.permission === "comment";
  if (caller.kind === "content") return caller.caller.canComment;
  const person = personOf(caller);
  if (!person || !hasScope(caller, "comment")) return false;
  if (isAdmin(person) || artifact.publisherId === person.id) return true;
  const added = artifact.access.find((row) => row.personId === person.id);
  if (added) return added.permission !== "view";
  return person.role !== "outside" && artifact.visibility === "org";
}

function mayPublish(caller: Caller, artifact: ArtifactResource): boolean {
  if (!hasScope(caller, "publish")) return false;
  if (caller.kind === "orgToken") return true; // seesArtifact already checked its projects.
  const person = personOf(caller);
  if (!person) return false;
  if (isAdmin(person)) return true;
  if (person.role !== "member") return false;
  return (
    artifact.publisherId === person.id ||
    artifact.access.some((row) => row.personId === person.id && row.permission === "publish")
  );
}

/** Publisher, admins and owner; a CLI token only as the publisher (04). */
function mayManage(caller: Caller, artifact: ArtifactResource): boolean {
  if (caller.kind === "person") return isAdmin(caller.person) || artifact.publisherId === caller.person.id;
  return (
    caller.kind === "cliToken" &&
    caller.scopes.includes("manage") &&
    artifact.publisherId === caller.person.id
  );
}

const ARTIFACT_ACTIONS = new Set<Action>(
  ACTIONS.filter((a) => a.startsWith("artifact.") || a.startsWith("data.")),
);
ARTIFACT_ACTIONS.add("thread.resolve");

function canOnArtifact(caller: Caller, action: Action, artifact: ArtifactResource): boolean {
  if (!ARTIFACT_ACTIONS.has(action)) return canOnOrg(caller, action);
  if (!seesArtifact(caller, artifact)) return false;
  const person = personOf(caller);

  if (artifact.deletedAt) {
    // Invisible to everyone, except that its deleter and admins can bring it back or purge it (04).
    const mine = person !== null && (isAdmin(person) || artifact.deletedBy === person.id);
    if (action === "artifact.delete") return mine && mayManage(caller, artifact);
    // Like undelete, purge needs the role today, not just having deleted it as an admin once.
    if (action === "artifact.purge") {
      return mine && caller.kind === "person" && caller.recentAuth && mayManage(caller, artifact);
    }
    return false;
  }

  const writable = artifact.archivedAt === null;
  switch (action) {
    case "artifact.read":
      return true;
    case "artifact.comment":
      return writable && mayComment(caller, artifact);
    case "thread.resolve":
    case "artifact.decide":
      return writable && caller.kind === "person" && mayComment(caller, artifact);
    case "artifact.publish":
      return writable && mayPublish(caller, artifact);
    case "artifact.manage":
    case "artifact.share":
    case "artifact.archive":
    case "artifact.delete":
      return mayManage(caller, artifact);
    case "artifact.purge":
      return caller.kind === "person" && caller.recentAuth && mayManage(caller, artifact);
    case "data.read":
      return hasScope(caller, "data") || caller.kind === "guest" || caller.kind === "content";
    case "data.write":
      return (
        writable &&
        (hasScope(caller, "data") || caller.kind === "guest" || caller.kind === "content") &&
        mayComment(caller, artifact)
      );
    case "data.export":
      return (
        hasScope(caller, "data") && person !== null && (isAdmin(person) || artifact.publisherId === person.id)
      );
    default:
      return false;
  }
}

function canOnOrg(caller: Caller, action: Action): boolean {
  const person = personOf(caller);
  const admin = person !== null && isAdmin(person);
  const session = caller.kind === "person";
  switch (action) {
    case "account.read":
      return person !== null;
    case "account.manage":
      return session;
    case "deleted.read":
      return session || (caller.kind === "cliToken" && caller.scopes.includes("manage"));
    case "home.read":
    case "project.list":
    case "project.read":
      return (person !== null || caller.kind === "orgToken") && hasScope(caller, "read");
    case "project.create":
      if (caller.kind === "orgToken") return caller.scopes.includes("org");
      return (
        person !== null && ["owner", "admin", "member"].includes(person.role) && hasScope(caller, "publish")
      );
    case "org.read":
    case "people.read":
      return admin && hasScope(caller, "read");
    case "people.invite":
      return admin && hasScope(caller, "manage");
    case "org.manage":
    case "people.manage":
    case "tokens.manage":
      return session && admin;
    default:
      return false;
  }
}

/** The one permission check (04). Pure and total: every route uses it, and it never throws. */
export function can(caller: Caller, action: Action, resource: Resource): boolean {
  return resource.type === "artifact" ? canOnArtifact(caller, action, resource) : canOnOrg(caller, action);
}
