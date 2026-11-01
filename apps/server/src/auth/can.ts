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
  "brand.read",
  "brand.propose",
  "brand.apply",
  "people.search",
  "team.read",
  "team.manage",
  "team.members",
] as const;
export type Action = (typeof ACTIONS)[number];

/** What a person can do, from least to most. `manage` only ever comes from a project (M18). */
export type Level = "view" | "comment" | "publish" | "manage";
type Standing = Level | "none";
const ORDER: Standing[] = ["none", "view", "comment", "publish", "manage"];
const atLeast = (level: Standing, wanted: Standing) => ORDER.indexOf(level) >= ORDER.indexOf(wanted);
const higher = (a: Standing, b: Standing) => (atLeast(a, b) ? a : b);

/** One way a person holds access to an artifact. A token-made grant keeps `viaToken` (04). */
export type GrantSource = {
  kind: "team";
  teamId: string;
  slug: string;
  name: string;
  level: Exclude<Level, "manage">;
  viaToken: boolean;
};
export type Grant = GrantSource & { personId: string };

/** One row per person. `confirmed` is the best level a person granted, so a token-made tie can't block them. */
export type Inherited = {
  personId: string;
  level: Level;
  confirmed: Level | null;
  sources: GrantSource[];
};

/** What the grants below an artifact add up to. Both loaders call this, so every rule stays in this file. */
export function inherit(grants: Grant[]): Inherited[] {
  const rows = new Map<string, Inherited>();
  for (const { personId, ...source } of grants) {
    const row = rows.get(personId) ?? { personId, level: source.level, confirmed: null, sources: [] };
    row.level = higher(row.level, source.level) as Level;
    if (!source.viaToken) row.confirmed = higher(row.confirmed ?? "none", source.level) as Level;
    row.sources.push(source);
    rows.set(personId, row);
  }
  return [...rows.values()];
}

export type ArtifactResource = {
  type: "artifact";
  id: string;
  projectId: string;
  visibility: "me" | "org";
  publisherId: string;
  archivedAt: Date | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  /** artifact_access rows for this artifact. `viaToken`: a token granted it and no person has confirmed it. */
  access: { personId: string; permission: "view" | "comment" | "publish"; viaToken: boolean }[];
  /** One row per person with access through a team. */
  inherited: Inherited[];
};
export type TeamResource = { type: "team"; id: string; leadIds: string[] };
export type Resource = ArtifactResource | TeamResource | { type: "org" };

const isAdmin = (person: CallerPerson) => person.role === "owner" || person.role === "admin";
const isMemberOrUp = (person: CallerPerson) => isAdmin(person) || person.role === "member";

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

/**
 * What a person can do with an artifact, the rules in 04 in order. Everything below reads this, so they
 * can't drift apart. The role cap comes last, so a grant can't lift a reviewer or an outside person
 * past commenting. It doesn't touch the publisher: someone who published and was then made a reviewer
 * keeps managing their own work, as they always have.
 */
export function effective(person: CallerPerson, artifact: ArtifactResource): Standing {
  if (isAdmin(person)) return "manage";
  const capped = (level: Standing) =>
    person.role === "member" || !atLeast(level, "publish") ? level : "comment";
  if (person.role !== "outside" && artifact.publisherId === person.id) return "manage";
  const direct = artifact.access.find((row) => row.personId === person.id);
  if (direct) return capped(direct.permission);
  const inherited = artifact.inherited.find((row) => row.personId === person.id)?.level ?? "none";
  const role = person.role !== "outside" && artifact.visibility === "org" ? "comment" : "none";
  return higher(role, capped(inherited));
}

/** "Visibility first" in 04, ignoring deletion. Also decides who is told an artifact was deleted. */
export function seesArtifact(caller: Caller, artifact: ArtifactResource): boolean {
  if (!hasScope(caller, "read") && caller.kind !== "guest" && caller.kind !== "content") return false;
  switch (caller.kind) {
    case "person":
    case "cliToken":
      return effective(caller.person, artifact) !== "none";
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
  return atLeast(effective(person, artifact), "comment");
}

/**
 * Deciding and resolving are for people, so access an agent's token handed out (`share --invite`,
 * `--add`, `--team`) doesn't carry them until a person grants it (04). Any right to comment that a
 * person gave settles it: a role on an org-visible artifact, a direct row, or a team's.
 */
function commentOnlyFromTokenGrant(caller: Caller, artifact: ArtifactResource): boolean {
  const person = personOf(caller);
  if (!person || isAdmin(person) || artifact.publisherId === person.id) return false;
  if (person.role !== "outside" && artifact.visibility === "org") return false;
  const direct = artifact.access.find((row) => row.personId === person.id);
  if (direct && !direct.viaToken && atLeast(direct.permission, "comment")) return false;
  const inherited = artifact.inherited.find((row) => row.personId === person.id);
  return !atLeast(inherited?.confirmed ?? "none", "comment");
}

function mayPublish(caller: Caller, artifact: ArtifactResource): boolean {
  if (!hasScope(caller, "publish")) return false;
  if (caller.kind === "orgToken") return true; // seesArtifact already checked its projects.
  const person = personOf(caller);
  if (!person) return false;
  if (isAdmin(person)) return true;
  return person.role === "member" && atLeast(effective(person, artifact), "publish");
}

/** Publisher, admins and owner; a CLI token only as the publisher (04). */
function mayManage(caller: Caller, artifact: ArtifactResource): boolean {
  if (caller.kind === "person") return effective(caller.person, artifact) === "manage";
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
      return (
        writable &&
        caller.kind === "person" &&
        mayComment(caller, artifact) &&
        !commentOnlyFromTokenGrant(caller, artifact)
      );
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

/** Leads run their own team's membership, in a browser, and only while they're members and up. */
function canOnTeam(caller: Caller, action: Action, team: TeamResource): boolean {
  if (action !== "team.members") return canOnOrg(caller, action);
  if (caller.kind !== "person") return false;
  const { person } = caller;
  return isAdmin(person) || (isMemberOrUp(person) && team.leadIds.includes(person.id));
}

function canOnOrg(caller: Caller, action: Action): boolean {
  const person = personOf(caller);
  const admin = person !== null && isAdmin(person);
  const session = caller.kind === "person";
  switch (action) {
    case "team.read":
      return person !== null && isMemberOrUp(person) && hasScope(caller, "read");
    case "people.search":
      return session && isMemberOrUp(caller.person);
    case "team.manage":
      return session && admin;
    case "account.read":
      return person !== null;
    case "account.manage":
      return session;
    case "deleted.read":
      return session || (caller.kind === "cliToken" && caller.scopes.includes("manage"));
    case "home.read":
    case "project.list":
    case "project.read":
    case "brand.read":
      return (person !== null || caller.kind === "orgToken") && hasScope(caller, "read");
    case "brand.propose":
      // Proposing changes nothing, and an agent is who usually does it (SPEC 8).
      return (
        person !== null && ["owner", "admin", "member"].includes(person.role) && hasScope(caller, "publish")
      );
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
    case "brand.apply":
      return session && admin;
    default:
      return false;
  }
}

/** The one permission check (04). Pure and total: every route uses it, and it never throws. */
export function can(caller: Caller, action: Action, resource: Resource): boolean {
  if (resource.type === "artifact") return canOnArtifact(caller, action, resource);
  if (resource.type === "team") return canOnTeam(caller, action, resource);
  return canOnOrg(caller, action);
}
