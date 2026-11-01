import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Every Phase 1 table in docs/implementation/02-data-model.md, which owns these names.
 * Phase 2 tables (backend_logs, artifact_usage, push_subscriptions) arrived with M9–M11.
 * Migrations only add: never edit a generated migration, never drop a column in the same release.
 */

const citext = customType<{ data: string }>({ dataType: () => "citext" });
const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });

const id = () => uuid("id").primaryKey();
const time = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => time("created_at").notNull().defaultNow();

export const role = pgEnum("role", ["owner", "admin", "member", "reviewer", "outside"]);
export const visibility = pgEnum("visibility", ["me", "org"]);
export const permission = pgEnum("permission", ["view", "comment", "publish"]);
export const projectPermission = pgEnum("project_permission", ["view", "comment", "publish", "manage"]);
export const tokenKind = pgEnum("token_kind", ["cli", "org", "oauth"]);
export const inviteKind = pgEnum("invite_kind", ["org", "artifact", "project"]);
export const pageKind = pgEnum("page_kind", ["canvas", "article", "prototype", "gallery", "deck"]);
export const threadStatus = pgEnum("thread_status", ["open", "fixed", "resolved"]);
export const anchorState = pgEnum("anchor_state", ["ok", "updated", "orphaned", "moved_version"]);
export const decisionKind = pgEnum("decision_kind", ["approved", "changes_requested"]);
export const deviceStatus = pgEnum("device_status", ["pending", "approved", "denied", "used"]);
export const teamRole = pgEnum("team_role", ["lead", "member"]);
export const activityKind = pgEnum("activity_kind", [
  "published",
  "restored",
  "commented",
  "replied",
  "fixed",
  "resolved",
  "reopened",
  "approved",
  "changes_requested",
  "archived",
  "unarchived",
  "deleted",
  "undeleted",
  "purged",
  "version_deleted",
  "version_undeleted",
  "version_named",
  "shared",
  "joined",
  "recovered",
  "team_created",
  "team_deleted",
  "team_member_added",
  "team_member_removed",
  "project_access_changed",
]);

// Organization and people

export const org = pgTable("org", {
  id: id(),
  name: text("name").notNull(),
  homeDomain: text("home_domain").notNull(),
  settings: jsonb("settings").notNull(),
  vapidPublic: text("vapid_public"),
  vapidPrivate: text("vapid_private"),
  lastDigestAt: time("last_digest_at"),
  brand: jsonb("brand"),
  pseudonymKey: bytea("pseudonym_key").notNull(),
  createdAt: createdAt(),
});

export const people = pgTable(
  "people",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    email: citext("email").notNull(),
    name: text("name").notNull(),
    role: role("role").notNull(),
    createdAt: createdAt(),
    removedAt: time("removed_at"),
  },
  (t) => [
    uniqueIndex("people_org_email_unique")
      .on(t.orgId, sql`lower(${t.email})`)
      .where(sql`${t.removedAt} is null`),
  ],
);

export const passwords = pgTable("passwords", {
  personId: uuid("person_id")
    .primaryKey()
    .references(() => people.id),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  hash: text("hash").notNull(),
  updatedAt: time("updated_at").notNull().defaultNow(),
});

export const passkeys = pgTable("passkeys", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  personId: uuid("person_id")
    .notNull()
    .references(() => people.id),
  credentialId: bytea("credential_id").notNull().unique(),
  publicKey: bytea("public_key").notNull(),
  counter: bigint("counter", { mode: "number" }).notNull(),
  transports: text("transports").array().notNull().default(sql`'{}'::text[]`),
  rpId: text("rp_id").notNull(),
  name: text("name"),
  createdAt: createdAt(),
  lastUsedAt: time("last_used_at"),
});

export const webauthnChallenges = pgTable("webauthn_challenges", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  challenge: text("challenge").notNull(),
  kind: text("kind").notNull(),
  personId: uuid("person_id").references(() => people.id),
  expiresAt: time("expires_at").notNull(),
});

export const sessions = pgTable("sessions", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  tokenHash: text("token_hash").notNull().unique(),
  personId: uuid("person_id")
    .notNull()
    .references(() => people.id),
  domain: text("domain").notNull(),
  authAt: time("auth_at").notNull(),
  createdAt: createdAt(),
  lastSeenAt: time("last_seen_at").notNull(),
  expiresAt: time("expires_at").notNull(),
  userAgent: text("user_agent"),
  ip: text("ip"),
});

export const guests = pgTable("guests", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: createdAt(),
  lastSeenAt: time("last_seen_at").notNull(),
});

// Teams

export const teams = pgTable(
  "teams",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => people.id),
    createdAt: createdAt(),
  },
  (t) => [unique("teams_org_slug_unique").on(t.orgId, t.slug)],
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    role: teamRole("role").notNull().default("member"),
    addedBy: uuid("added_by")
      .notNull()
      .references(() => people.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.personId] }), index("team_members_person_idx").on(t.personId)],
);

// Projects and artifacts (declared before the tables that reference them)

export const brandProposals = pgTable("brand_proposals", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  name: text("name").notNull(),
  brand: jsonb("brand").notNull(),
  artifactId: uuid("artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
  proposedBy: uuid("proposed_by")
    .notNull()
    .references(() => people.id),
  agent: text("agent"),
  createdAt: createdAt(),
  appliedAt: time("applied_at"),
  appliedBy: uuid("applied_by").references(() => people.id),
});

export const projects = pgTable(
  "projects",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    repo: text("repo"),
    /** Off by default: an open project is everyone's, as every project was before this column. */
    restricted: boolean("restricted").notNull().default(false),
    createdBy: uuid("created_by").references(() => people.id),
    /** The organization token that made it, which can always reach it (04). */
    createdByToken: uuid("created_by_token").references(() => tokens.id),
    createdAt: createdAt(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("projects_org_slug_unique").on(t.orgId, t.slug),
    index("projects_org_repo_idx").on(t.orgId, sql`lower(${t.repo})`),
  ],
);

/** Access to a whole project, for a person or a team. */
export const projectAccess = pgTable(
  "project_access",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    personId: uuid("person_id").references(() => people.id),
    teamId: uuid("team_id").references(() => teams.id),
    permission: projectPermission("permission").notNull(),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => people.id),
    createdAt: createdAt(),
  },
  (t) => [
    check("project_access_one_subject", sql`(${t.personId} is null) <> (${t.teamId} is null)`),
    unique("project_access_project_person_unique").on(t.projectId, t.personId),
    unique("project_access_project_team_unique").on(t.projectId, t.teamId),
    index("project_access_person_idx").on(t.personId),
    index("project_access_team_idx").on(t.teamId),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    visibility: visibility("visibility").notNull(),
    publisherId: uuid("publisher_id")
      .notNull()
      .references(() => people.id),
    latestVersion: integer("latest_version").notNull().default(0),
    hasBackend: boolean("has_backend").notNull().default(false),
    threadCounter: integer("thread_counter").notNull().default(0),
    archivedAt: time("archived_at"),
    archivedBy: uuid("archived_by").references(() => people.id),
    deletedAt: time("deleted_at"),
    deletedBy: uuid("deleted_by").references(() => people.id),
    purgeAfter: time("purge_after"),
    createdAt: createdAt(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("artifacts_project_slug_unique").on(t.projectId, t.slug),
    index("artifacts_org_updated_idx").on(t.orgId, t.updatedAt.desc()).where(sql`${t.deletedAt} is null`),
    index("artifacts_purge_after_idx").on(t.purgeAfter).where(sql`${t.deletedAt} is not null`),
  ],
);

export const artifactAccess = pgTable(
  "artifact_access",
  {
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    permission: permission("permission").notNull(),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => people.id),
    /** Granted by a token and not yet confirmed by a person: may comment, can't decide or resolve (04). */
    viaToken: boolean("via_token").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.personId] })],
);

/** A team's access to one artifact. A separate table, because `artifact_access` requires a person. */
export const artifactTeamAccess = pgTable(
  "artifact_team_access",
  {
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    permission: permission("permission").notNull(),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => people.id),
    /** As on `artifact_access`: a token made it and no person has confirmed it (04). */
    viaToken: boolean("via_token").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.teamId] }),
    index("artifact_team_access_team_idx").on(t.teamId),
  ],
);

export const shareLinks = pgTable("share_links", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  artifactId: uuid("artifact_id")
    .notNull()
    .references(() => artifacts.id),
  tokenHash: text("token_hash").notNull().unique(),
  permission: permission("permission").notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => people.id),
  createdAt: createdAt(),
  expiresAt: time("expires_at"),
  revokedAt: time("revoked_at"),
});

export const guestLinks = pgTable(
  "guest_links",
  {
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    shareLinkId: uuid("share_link_id")
      .notNull()
      .references(() => shareLinks.id),
    name: text("name").notNull(),
    createdAt: createdAt(),
    expiresAt: time("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.guestId, t.shareLinkId] })],
);

export const invites = pgTable("invites", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  kind: inviteKind("kind").notNull(),
  email: citext("email").notNull(),
  role: role("role").notNull(),
  artifactId: uuid("artifact_id").references(() => artifacts.id),
  permission: permission("permission"),
  /** Created by a token; the `artifact_access` row it becomes carries the flag over. */
  viaToken: boolean("via_token").notNull().default(false),
  /** Teams to join on accepting. Not a reference: a team deleted meanwhile is skipped. */
  teamIds: uuid("team_ids").array(),
  /** For `project` invites: the outside account gets this grant. */
  projectId: uuid("project_id").references(() => projects.id),
  projectPermission: projectPermission("project_permission"),
  tokenHash: text("token_hash").notNull().unique(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => people.id),
  createdAt: createdAt(),
  expiresAt: time("expires_at").notNull(),
  acceptedAt: time("accepted_at"),
  revokedAt: time("revoked_at"),
});

export const resetLinks = pgTable("reset_links", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  personId: uuid("person_id")
    .notNull()
    .references(() => people.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdBy: uuid("created_by").references(() => people.id),
  createdAt: createdAt(),
  expiresAt: time("expires_at").notNull(),
  usedAt: time("used_at"),
});

export const deviceCodes = pgTable("device_codes", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  deviceCodeHash: text("device_code_hash").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  clientName: text("client_name").notNull(),
  agent: text("agent"),
  status: deviceStatus("status").notNull().default("pending"),
  personId: uuid("person_id").references(() => people.id),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
  expiresAt: time("expires_at").notNull(),
});

export const tokens = pgTable("tokens", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  kind: tokenKind("kind").notNull(),
  personId: uuid("person_id").references(() => people.id),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  scopes: text("scopes").array().notNull(),
  projectIds: uuid("project_ids").array(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => people.id),
  createdAt: createdAt(),
  lastUsedAt: time("last_used_at"),
  expiresAt: time("expires_at"),
  revokedAt: time("revoked_at"),
  grantId: uuid("grant_id").references(() => oauthGrants.id),
  audience: text("audience"),
});

/** A client we've seen: registered with us, or a metadata document we fetched (`metadata_url`). */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    clientId: text("client_id").notNull(),
    name: text("name").notNull(),
    redirectUris: text("redirect_uris").array().notNull(),
    metadataUrl: boolean("metadata_url").notNull().default(false),
    createdAt: createdAt(),
    fetchedAt: time("fetched_at"),
  },
  (t) => [unique("oauth_clients_org_client_unique").on(t.orgId, t.clientId)],
);

/** One person's consent to one client for one resource. Every token from it ends with it. */
export const oauthGrants = pgTable("oauth_grants", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  personId: uuid("person_id")
    .notNull()
    .references(() => people.id),
  clientId: text("client_id").notNull(),
  clientName: text("client_name").notNull(),
  audience: text("audience").notNull(),
  scopes: text("scopes").array().notNull(),
  createdAt: createdAt(),
  lastUsedAt: time("last_used_at"),
  revokedAt: time("revoked_at"),
});

export const oauthCodes = pgTable("oauth_codes", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  codeHash: text("code_hash").notNull().unique(),
  grantId: uuid("grant_id")
    .notNull()
    .references(() => oauthGrants.id),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  createdAt: createdAt(),
  expiresAt: time("expires_at").notNull(),
  usedAt: time("used_at"),
});

export const oauthRefreshTokens = pgTable("oauth_refresh_tokens", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  grantId: uuid("grant_id")
    .notNull()
    .references(() => oauthGrants.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: createdAt(),
  expiresAt: time("expires_at").notNull(),
  usedAt: time("used_at"),
});

// Versions and content

export const blobs = pgTable(
  "blobs",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    hash: text("hash").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    verifiedAt: time("verified_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.hash] })],
);

export const versions = pgTable(
  "versions",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    n: integer("n").notNull(),
    files: jsonb("files").notNull(),
    backendHash: text("backend_hash"),
    message: text("message"),
    name: text("name"),
    notes: jsonb("notes").notNull().default({}),
    summary: text("summary"),
    tags: text("tags").array(),
    publishedBy: uuid("published_by")
      .notNull()
      .references(() => people.id),
    agent: text("agent"),
    restoredFrom: integer("restored_from"),
    publishedAt: time("published_at").notNull().defaultNow(),
    deletedAt: time("deleted_at"),
    deletedBy: uuid("deleted_by").references(() => people.id),
    purgeAfter: time("purge_after"),
  },
  (t) => [unique("versions_artifact_n_unique").on(t.artifactId, t.n)],
);

export const pages = pgTable(
  "pages",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    versionId: uuid("version_id")
      .notNull()
      .references(() => versions.id),
    pageKey: text("page_key").notNull(),
    kind: pageKind("kind").notNull(),
    title: text("title"),
    group: text("group"),
    position: integer("position").notNull(),
    meta: jsonb("meta").notNull().default({}),
  },
  (t) => [unique("pages_version_key_unique").on(t.versionId, t.pageKey)],
);

export const frames = pgTable(
  "frames",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    versionId: uuid("version_id")
      .notNull()
      .references(() => versions.id),
    pageKey: text("page_key").notNull(),
    boardKey: text("board_key").notNull(),
    frameKey: text("frame_key").notNull(),
    title: text("title"),
    device: text("device"),
    x: real("x").notNull(),
    y: real("y").notNull(),
    w: real("w").notNull(),
    h: real("h").notNull(),
    contentHash: text("content_hash").notNull(),
    renders: jsonb("renders").notNull(),
    livePath: text("live_path"),
  },
  (t) => [unique("frames_version_page_frame_unique").on(t.versionId, t.pageKey, t.frameKey)],
);

export const blocks = pgTable(
  "blocks",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    versionId: uuid("version_id")
      .notNull()
      .references(() => versions.id),
    pageKey: text("page_key").notNull(),
    blockKey: text("block_key").notNull(),
    contentHash: text("content_hash").notNull(),
    text: text("text").notNull(),
  },
  (t) => [
    unique("blocks_version_page_block_unique").on(t.versionId, t.pageKey, t.blockKey),
    index("blocks_search_idx").using("gin", sql`to_tsvector('english', ${t.text})`),
  ],
);

// Review

const oneAuthor = (person: unknown, guest: unknown) => sql`(${person} is null) <> (${guest} is null)`;

export const threads = pgTable(
  "threads",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    n: integer("n").notNull(),
    pageKey: text("page_key").notNull(),
    anchor: jsonb("anchor"),
    anchorState: anchorState("anchor_state").notNull().default("ok"),
    status: threadStatus("status").notNull().default("open"),
    createdVersion: integer("created_version").notNull(),
    fixedVersion: integer("fixed_version"),
    movedFromVersion: integer("moved_from_version"),
    authorPersonId: uuid("author_person_id").references(() => people.id),
    authorGuestId: uuid("author_guest_id").references(() => guests.id),
    authorName: text("author_name").notNull(),
    cropKey: text("crop_key"),
    createdAt: createdAt(),
    resolvedAt: time("resolved_at"),
    resolvedBy: uuid("resolved_by").references(() => people.id),
  },
  (t) => [
    unique("threads_artifact_n_unique").on(t.artifactId, t.n),
    check("threads_one_author", oneAuthor(t.authorPersonId, t.authorGuestId)),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: id(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    authorPersonId: uuid("author_person_id").references(() => people.id),
    authorGuestId: uuid("author_guest_id").references(() => guests.id),
    authorName: text("author_name").notNull(),
    agent: text("agent"),
    body: text("body").notNull(),
    version: integer("version").notNull(),
    marksFixed: boolean("marks_fixed").notNull().default(false),
    createdAt: createdAt(),
    editedAt: time("edited_at"),
  },
  (t) => [
    check("comments_one_author", oneAuthor(t.authorPersonId, t.authorGuestId)),
    check("comments_body_length", sql`char_length(${t.body}) <= 10000`),
    index("comments_search_idx").using("gin", sql`to_tsvector('english', ${t.body})`),
  ],
);

export const decisions = pgTable("decisions", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  artifactId: uuid("artifact_id")
    .notNull()
    .references(() => artifacts.id),
  version: integer("version").notNull(),
  personId: uuid("person_id")
    .notNull()
    .references(() => people.id),
  kind: decisionKind("kind").notNull(),
  note: text("note"),
  createdAt: createdAt(),
});

export const views = pgTable(
  "views",
  {
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    lastSeenVersion: integer("last_seen_version").notNull(),
    lastSeenAt: time("last_seen_at").notNull(),
    positions: jsonb("positions").notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.personId, t.artifactId] })],
);

export const guestViews = pgTable(
  "guest_views",
  {
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    lastSeenVersion: integer("last_seen_version").notNull(),
    lastSeenAt: time("last_seen_at").notNull(),
    positions: jsonb("positions").notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.guestId, t.artifactId] })],
);

// Micro apps

export const artifactUsage = pgTable(
  "artifact_usage",
  {
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    scope: text("scope").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    keys: integer("keys").notNull().default(0),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.scope] })],
);

export const backendLogs = pgTable(
  "backend_logs",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    version: integer("version").notNull(),
    level: text("level").notNull(),
    message: text("message").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("backend_logs_artifact_created_idx").on(t.artifactId, t.createdAt)],
);

// Activity and lifecycle

export const activity = pgTable(
  "activity",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    artifactId: uuid("artifact_id").references(() => artifacts.id),
    projectId: uuid("project_id").references(() => projects.id),
    actorPersonId: uuid("actor_person_id").references(() => people.id),
    actorGuestId: uuid("actor_guest_id").references(() => guests.id),
    agent: text("agent"),
    kind: activityKind("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("activity_org_created_idx").on(t.orgId, t.createdAt.desc())],
);

export const tombstones = pgTable("tombstones", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  kind: text("kind").notNull(),
  projectSlug: text("project_slug").notNull(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  version: integer("version"),
  deletedBy: uuid("deleted_by").references(() => people.id),
  purgedAt: time("purged_at").notNull().defaultNow(),
});

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    keys: jsonb("keys").notNull(),
    createdAt: createdAt(),
    lastOkAt: time("last_ok_at"),
  },
  (t) => [index("push_subscriptions_person_idx").on(t.personId)],
);
