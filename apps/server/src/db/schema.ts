import {
  ACTIVITY_KINDS,
  ANCHOR_STATES,
  type Anchor,
  ATOM_KINDS,
  type BoardCaptureThread,
  type BoardEditRequest,
  type BoardEditResult,
  type BoardImage,
  type BoardRenders,
  type BoardSnapshot,
  type Brand,
  CHECKPOINT_KINDS,
  COMMENT_MAX,
  DECISION_KINDS,
  EDIT_MODES,
  type OAuthScope,
  type OrgSettings,
  PAGE_KINDS,
  type PageMeta,
  PERMISSIONS,
  PROJECT_KINDS,
  PROJECT_PERMISSIONS,
  type Renders,
  ROLES,
  RUN_STATUSES,
  SUGGESTION_OPS,
  SUGGESTION_STATUSES,
  TEAM_ROLES,
  THREAD_STATUSES,
  type TokenScope,
  type VersionFiles,
  VISIBILITIES,
  type WikiMeta,
} from "@artifacts/schema";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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

export const role = pgEnum("role", ROLES);
export const visibility = pgEnum("visibility", VISIBILITIES);
export const permission = pgEnum("permission", PERMISSIONS);
export const projectPermission = pgEnum("project_permission", PROJECT_PERMISSIONS);
export const tokenKind = pgEnum("token_kind", ["cli", "org", "oauth"]);
export const inviteKind = pgEnum("invite_kind", ["org", "artifact", "project"]);
export const pageKind = pgEnum("page_kind", PAGE_KINDS);
export const threadStatus = pgEnum("thread_status", THREAD_STATUSES);
export const anchorState = pgEnum("anchor_state", ANCHOR_STATES);
export const decisionKind = pgEnum("decision_kind", DECISION_KINDS);
export const deviceStatus = pgEnum("device_status", ["pending", "approved", "denied", "used"]);
export const teamRole = pgEnum("team_role", TEAM_ROLES);
export const activityKind = pgEnum("activity_kind", ACTIVITY_KINDS);
export const projectKind = pgEnum("project_kind", PROJECT_KINDS);
export const checkpointKind = pgEnum("checkpoint_kind", CHECKPOINT_KINDS);
export const editMode = pgEnum("edit_mode", EDIT_MODES);
export const atomKind = pgEnum("atom_kind", ATOM_KINDS);
export const suggestionStatus = pgEnum("suggestion_status", SUGGESTION_STATUSES);
export const suggestionOp = pgEnum("suggestion_op", SUGGESTION_OPS);
export const runStatus = pgEnum("run_status", RUN_STATUSES);

// Organization and people

export const org = pgTable("org", {
  id: id(),
  name: text("name").notNull(),
  homeDomain: text("home_domain").notNull(),
  /** Stored before a setting existed, a row lacks it: findOrg fills in the defaults. */
  settings: jsonb("settings").$type<Partial<OrgSettings>>().notNull(),
  vapidPublic: text("vapid_public"),
  vapidPrivate: text("vapid_private"),
  lastDigestAt: time("last_digest_at"),
  brand: jsonb("brand").$type<Brand>(),
  /** Stored as is, like `vapid_private`: tying it to SESSION_SECRET would stop that being rotated (04). */
  googleClientId: text("google_client_id"),
  googleClientSecret: text("google_client_secret"),
  /** Off until an admin has finished a round trip with these credentials. */
  googleEnabled: boolean("google_enabled").notNull().default(false),
  googleTestedBy: uuid("google_tested_by").references((): AnyPgColumn => people.id),
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

/** A sign-in from outside. `subject` is the provider's own id: email can change and isn't unique. */
export const identities = pgTable(
  "identities",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    email: text("email").notNull(),
    hostedDomain: text("hosted_domain"),
    createdAt: createdAt(),
    lastUsedAt: time("last_used_at"),
  },
  (t) => [
    unique("identities_org_provider_subject_unique").on(t.orgId, t.provider, t.subject),
    unique("identities_person_provider_unique").on(t.personId, t.provider),
  ],
);

/** Who an admin removed, by a hash of Google's id: a Workspace's open door mustn't let them back in. */
export const removedIdentities = pgTable(
  "removed_identities",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    provider: text("provider").notNull(),
    subjectHash: text("subject_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.provider, t.subjectHash] })],
);

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

/** One Google round trip, for 10 minutes and one use. `browser_hash` ties it to the cookie that started it. */
export const googleStates = pgTable("google_states", {
  id: id(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  stateHash: text("state_hash").notNull().unique(),
  browserHash: text("browser_hash").notNull(),
  nonce: text("nonce").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  intent: text("intent").notNull(),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }),
  personId: uuid("person_id").references(() => people.id),
  inviteId: uuid("invite_id").references(() => invites.id, { onDelete: "cascade" }),
  next: text("next").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  expiresAt: time("expires_at").notNull(),
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
  brand: jsonb("brand").$type<Brand>().notNull(),
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
    /** A wiki's artifacts are the pages of one knowledge base (SPEC 16). */
    kind: projectKind("kind").notNull().default("project"),
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
    /** An owner let agents edit this wiki page directly, whatever its audience (13). */
    agentMaintained: boolean("agent_maintained").notNull().default(false),
    agentMaintainedBy: uuid("agent_maintained_by").references(() => people.id),
    agentMaintainedAt: time("agent_maintained_at"),
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
  scopes: text("scopes").array().$type<TokenScope[]>().notNull(),
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
  scopes: text("scopes").array().$type<OAuthScope[]>().notNull(),
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
    files: jsonb("files").$type<VersionFiles>().notNull(),
    backendHash: text("backend_hash"),
    message: text("message"),
    name: text("name"),
    notes: jsonb("notes").$type<Record<string, string>>().notNull().default({}),
    summary: text("summary"),
    tags: text("tags").array(),
    /** Role, sources, origin and trust, from the manifest, for an artifact in a wiki (SPEC 16). */
    wiki: jsonb("wiki").$type<WikiMeta>(),
    /** Every `project/slug` this version's articles link to, found by the server in its own clean HTML. */
    links: text("links").array().notNull().default(sql`'{}'::text[]`),
    publishedBy: uuid("published_by")
      .notNull()
      .references(() => people.id),
    agent: text("agent"),
    restoredFrom: integer("restored_from"),
    /** What made this version, when an edited draft became it (13). Null for a publish or a restore. */
    checkpoint: checkpointKind("checkpoint"),
    /** The draft's `edit_docs.seq` that this checkpoint holds. */
    docSeq: bigint("doc_seq", { mode: "number" }),
    publishedAt: time("published_at").notNull().defaultNow(),
    deletedAt: time("deleted_at"),
    deletedBy: uuid("deleted_by").references(() => people.id),
    purgeAfter: time("purge_after"),
  },
  (t) => [
    unique("versions_artifact_n_unique").on(t.artifactId, t.n),
    index("versions_links_idx").using("gin", t.links),
  ],
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
    meta: jsonb("meta").$type<PageMeta>().notNull().default({}),
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
    renders: jsonb("renders").$type<Renders>().notNull(),
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
    /** Who wrote which passage of `text`: `[{ s, e, a, t }]`, with author keys from `edit_authors` (13). */
    authors: jsonb("authors").$type<{ s: number; e: number; a: string; t: string }[]>(),
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
    anchor: jsonb("anchor").$type<Anchor>(),
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
    check("comments_body_length", sql`char_length(${t.body}) <= ${sql.raw(String(COMMENT_MAX))}`),
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
    positions: jsonb("positions").$type<Record<string, unknown>>().notNull().default({}),
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
    positions: jsonb("positions").$type<Record<string, unknown>>().notNull().default({}),
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
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
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
    keys: jsonb("keys").$type<{ p256dh: string; auth: string }>().notNull(),
    createdAt: createdAt(),
    lastOkAt: time("last_ok_at"),
  },
  (t) => [index("push_subscriptions_person_idx").on(t.personId)],
);

// Editing (13-editing.md owns these)

/** The live draft of an editable article or board page: a Yjs document, as a snapshot and the updates after it. */
export const editDocs = pgTable("edit_docs", {
  artifactId: uuid("artifact_id")
    .primaryKey()
    .references(() => artifacts.id),
  orgId: uuid("org_id")
    .notNull()
    .references(() => org.id),
  pageKey: text("page_key").notNull(),
  /** Phase 3 dispatches validation/seeding/checkpoints without changing the sync transport. */
  kind: text("kind").$type<"article" | "board">().notNull().default("article"),
  /** Starts at 1, and goes up each time the draft is started again from a version. */
  epoch: integer("epoch").notNull().default(1),
  /** The version this lineage was seeded from, and the latest checkpoint made from it. */
  baseVersion: integer("base_version").notNull(),
  version: integer("version").notNull(),
  /** The last update's number, the one the latest checkpoint holds, and the one the snapshot holds. */
  seq: bigint("seq", { mode: "number" }).notNull().default(0),
  checkpointSeq: bigint("checkpoint_seq", { mode: "number" }).notNull().default(0),
  snapshotSeq: bigint("snapshot_seq", { mode: "number" }).notNull().default(0),
  snapshot: bytea("snapshot").notNull(),
  /** Title, summary, tags and sources set since the last checkpoint, and threads a direct edit fixes. */
  meta: jsonb("meta").$type<{
    title?: string;
    summary?: string;
    tags?: string[];
    sources?: string[];
    fixes?: { n: number; personId: string | null; agent: string | null; tokenId?: string | null }[];
    /** The sweep's back-off for a draft that failed to checkpoint: attempts, and when to try next. */
    sweep?: { attempts: number; next: string };
  }>(),
  /** Author keys are `a1`, `a2`, ... per artifact. */
  authorCounter: integer("author_counter").notNull().default(0),
  lastActorPersonId: uuid("last_actor_person_id").references(() => people.id),
  lastAgent: text("last_agent"),
  /** When the first change after the latest checkpoint arrived, and the last change. */
  dirtySince: time("dirty_since"),
  updatedAt: time("updated_at"),
  createdAt: createdAt(),
});

export const editUpdates = pgTable(
  "edit_updates",
  {
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    seq: bigint("seq", { mode: "number" }).notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    epoch: integer("epoch").notNull(),
    update: bytea("update").notNull(),
    /** A person, or the person an agent acts for. Null for the server's own fixes and org tokens. */
    actorPersonId: uuid("actor_person_id").references(() => people.id),
    agent: text("agent"),
    tokenId: uuid("token_id").references(() => tokens.id),
    origin: text("origin").$type<"person" | "agent" | "server">().notNull(),
    size: integer("size").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.seq] })],
);

/** Who is in the editor now, coarsely: enough for agents' operations on any replica to respect them. */
export const editPresence = pgTable(
  "edit_presence",
  {
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    connectionId: text("connection_id").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    mode: editMode("mode").notNull(),
    /** The caret's block first, then blocks with changes not yet sent. */
    blocks: text("blocks").array().notNull().default(sql`'{}'::text[]`),
    /** Board holds: selected/dragged/edited objects and unsent local object changes (14). */
    objects: text("objects").array().notNull().default(sql`'{}'::text[]`),
    replica: text("replica").notNull(),
    seenAt: time("seen_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.connectionId] }),
    index("edit_presence_seen_idx").on(t.seenAt),
  ],
);

/** Blocks the editor can't represent: exact Markdown, and a diagram's SVG from the version it came from. */
export const editAtoms = pgTable(
  "edit_atoms",
  {
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    /** SHA-256 of `source`. */
    hash: text("hash").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    kind: atomKind("kind").notNull(),
    source: text("source").notNull(),
    /** Mermaid only: the sanitized SVG the read pipeline drew, which the server can't draw again. */
    svg: text("svg"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.hash] })],
);

/** What an author key stands for: a person, or an agent acting for one, and the sources it wrote from. */
export const editAuthors = pgTable(
  "edit_authors",
  {
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    key: text("key").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    kind: text("kind").$type<"person" | "agent">().notNull(),
    personId: uuid("person_id").references(() => people.id),
    agent: text("agent"),
    tokenId: uuid("token_id").references(() => tokens.id),
    sources: text("sources").array().notNull().default(sql`'{}'::text[]`),
    /** SHA-256 of kind, person, agent, token and sorted sources, so one author gets one key. */
    fingerprint: text("fingerprint").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.key] }),
    unique("edit_authors_artifact_fingerprint_unique").on(t.artifactId, t.fingerprint),
  ],
);

/** An older version's `<heading>/p<n>` keys, and the lasting ids the first edit gave those blocks. */
export const blockAliases = pgTable(
  "block_aliases",
  {
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    legacyKey: text("legacy_key").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    blockId: text("block_id").notNull(),
    version: integer("version").notNull(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.legacyKey] })],
);

export const editRuns = pgTable(
  "edit_runs",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    status: runStatus("status").notNull().default("active"),
    /** Fixed when the run starts: whether its edits apply, or wait as one change set. */
    edits: text("edits").$type<"direct" | "suggestion">().notNull(),
    goal: text("goal").notNull(),
    agent: text("agent"),
    /** The person whose run it is; for an organization token, whoever made the token. */
    startedBy: uuid("started_by")
      .notNull()
      .references(() => people.id),
    tokenId: uuid("token_id").references(() => tokens.id),
    startedAt: time("started_at").notNull(),
    expiresAt: time("expires_at").notNull(),
    finishedAt: time("finished_at"),
    decidedBy: uuid("decided_by").references(() => people.id),
    version: integer("version"),
  },
  (t) => [index("edit_runs_artifact_status_idx").on(t.artifactId, t.status)],
);

export const suggestions = pgTable(
  "suggestions",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    pageKey: text("page_key").notNull(),
    op: suggestionOp("op").notNull(),
    blockId: text("block_id"),
    newBlockId: text("new_block_id"),
    base: text("base"),
    markdown: text("markdown"),
    meta: jsonb("meta").$type<{ title?: string; summary?: string; tags?: string[]; sources?: string[] }>(),
    note: text("note"),
    sources: text("sources").array().notNull().default(sql`'{}'::text[]`),
    fixes: integer("fixes").array().notNull().default(sql`'{}'::integer[]`),
    status: suggestionStatus("status").notNull().default("open"),
    runId: uuid("run_id").references(() => editRuns.id),
    /** The author key its text carries once accepted. */
    authorKey: text("author_key").notNull(),
    authorPersonId: uuid("author_person_id").references(() => people.id),
    agent: text("agent"),
    tokenId: uuid("token_id").references(() => tokens.id),
    createdAt: createdAt(),
    expiresAt: time("expires_at").notNull(),
    decidedAt: time("decided_at"),
    decidedBy: uuid("decided_by").references(() => people.id),
    decisionNote: text("decision_note"),
    /** The checkpoint that carried it, once accepted. */
    version: integer("version"),
  },
  (t) => [
    index("suggestions_artifact_status_idx").on(t.artifactId, t.status),
    index("suggestions_run_idx").on(t.runId),
  ],
);

// Boards (14-boards.md owns these; add-only migration).

/** Immutable board content for a version. Pictures are derived and attached once by a browser. */
export const boardVersions = pgTable(
  "board_versions",
  {
    versionId: uuid("version_id")
      .notNull()
      .references(() => versions.id),
    pageKey: text("page_key").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    snapshot: jsonb("snapshot").$type<BoardSnapshot>().notNull(),
    hash: text("hash").notNull(),
    /** Null means pending, never reuse a previous version's thumbnail as this version's picture. */
    renders: jsonb("renders").$type<BoardRenders>(),
    renderedAt: time("rendered_at"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.pageKey] }),
    index("board_versions_artifact_idx").on(t.artifactId),
  ],
);

/** An artifact-scoped capability to a validated content-addressed raster, not a global hash oracle. */
export const boardAssets = pgTable(
  "board_assets",
  {
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    hash: text("hash").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    image: jsonb("image").$type<BoardImage>().notNull(),
    uploadedBy: uuid("uploaded_by").references(() => people.id),
    tokenId: uuid("token_id").references(() => tokens.id),
    validatedAt: time("validated_at"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.hash] })],
);

/** Short-lived render fence. A draft ticket cannot checkpoint a different epoch/seq/hash. */
export const boardCaptures = pgTable(
  "board_captures",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    pageKey: text("page_key").notNull(),
    /** Null: draft checkpoint; non-null: pictures for this existing immutable version. */
    versionId: uuid("version_id").references(() => versions.id),
    epoch: integer("epoch").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    hash: text("hash").notNull(),
    /** The exact eligible anchor set returned by this ticket, fenced independently of later comments. */
    threads: jsonb("threads").$type<BoardCaptureThread[]>().notNull().default([]),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => people.id),
    expiresAt: time("expires_at").notNull(),
    consumedAt: time("consumed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("board_captures_expires_idx").on(t.expiresAt)],
);

/** Uses Phase 2 policy, authors, runs and decision lifecycle; payloads are atomic board batches. */
export const boardSuggestions = pgTable(
  "board_suggestions",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    pageKey: text("page_key").notNull(),
    epoch: integer("epoch").notNull(),
    request: jsonb("request").$type<BoardEditRequest>().notNull(),
    ids: jsonb("ids").$type<Record<string, string>>().notNull(),
    status: suggestionStatus("status").notNull().default("open"),
    runId: uuid("run_id").references(() => editRuns.id),
    authorKey: text("author_key").notNull(),
    authorPersonId: uuid("author_person_id").references(() => people.id),
    agent: text("agent"),
    tokenId: uuid("token_id").references(() => tokens.id),
    note: text("note"),
    sources: text("sources").array().notNull().default(sql`'{}'::text[]`),
    fixes: integer("fixes").array().notNull().default(sql`'{}'::integer[]`),
    createdAt: createdAt(),
    expiresAt: time("expires_at").notNull(),
    decidedAt: time("decided_at"),
    decidedBy: uuid("decided_by").references(() => people.id),
    decisionNote: text("decision_note"),
    version: integer("version"),
  },
  (t) => [
    index("board_suggestions_artifact_status_idx").on(t.artifactId, t.status),
    index("board_suggestions_run_idx").on(t.runId),
  ],
);

/** Retry receipts survive update-log compaction and remain for the draft's epoch. */
export const boardRequests = pgTable(
  "board_requests",
  {
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    requestId: uuid("request_id").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    epoch: integer("epoch").notNull(),
    callerKey: text("caller_key").notNull(),
    hash: text("hash").notNull(),
    result: jsonb("result").$type<BoardEditResult>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.callerKey, t.requestId] })],
);

// Phase 4 foundation. Every mutable operation takes lockLibrarian(orgId) first.
export const librarianConfig = pgTable(
  "librarian_config",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => org.id),
    enabled: boolean("enabled").notNull().default(false),
    generation: integer("generation").notNull().default(0),
    model: text("model").notNull().default("claude-sonnet-5-5"),
    monthlyLimit: bigint("monthly_limit", { mode: "bigint" }).notNull().default(sql`0`),
    runLimit: bigint("run_limit", { mode: "bigint" }).notNull().default(sql`0`),
    tokenId: uuid("token_id").references(() => tokens.id),
    rateCard: jsonb("rate_card").$type<{ input: string; output: string }>(),
    updatedBy: uuid("updated_by").references(() => people.id),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "librarian_config_money",
      sql`${t.monthlyLimit} >= 0 and ${t.runLimit} >= 0 and ${t.runLimit} <= ${t.monthlyLimit}`,
    ),
  ],
);
export const librarianWikis = pgTable(
  "librarian_wikis",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    selectedBy: uuid("selected_by").references(() => people.id),
    selectedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.projectId] })],
);
export const librarianKeys = pgTable("librarian_keys", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => org.id),
  generation: integer("generation").notNull(),
  envelope: jsonb("envelope")
    .$type<{
      kekId: string;
      ciphertext: string;
      nonce: string;
      tag: string;
      wrappedKey: string;
      wrapNonce: string;
      wrapTag: string;
    }>()
    .notNull(),
  updatedBy: uuid("updated_by").references(() => people.id),
  updatedAt: time("updated_at").notNull().defaultNow(),
});
export const librarianMonths = pgTable(
  "librarian_months",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    month: text("month").notNull(),
    settled: bigint("settled", { mode: "bigint" }).notNull().default(sql`0`),
    uncertain: bigint("uncertain", { mode: "bigint" }).notNull().default(sql`0`),
    reserved: bigint("reserved", { mode: "bigint" }).notNull().default(sql`0`),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.month] }),
    check("librarian_month_money", sql`${t.settled} >= 0 and ${t.uncertain} >= 0 and ${t.reserved} >= 0`),
  ],
);
export const librarianRuns = pgTable(
  "librarian_runs",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    wikiId: uuid("wiki_id")
      .notNull()
      .references(() => projects.id),
    inboxId: uuid("inbox_id").references((): AnyPgColumn => librarianInbox.id),
    dailyKey: text("daily_key"),
    state: text("state").notNull(),
    model: text("model").notNull(),
    configGeneration: integer("config_generation").notNull(),
    rateCard: jsonb("rate_card").$type<{ input: string; output: string }>().notNull(),
    owner: uuid("owner").notNull(),
    fence: integer("fence").notNull(),
    leaseExpiresAt: time("lease_expires_at").notNull(),
    deadline: time("deadline").notNull(),
    month: text("month").notNull(),
    cap: bigint("cap", { mode: "bigint" }).notNull(),
    settled: bigint("settled", { mode: "bigint" }).notNull().default(sql`0`),
    uncertain: bigint("uncertain", { mode: "bigint" }).notNull().default(sql`0`),
    reserved: bigint("reserved", { mode: "bigint" }).notNull(),
    startedAt: time("started_at").notNull(),
    finishedAt: time("finished_at"),
  },
  (t) => [
    unique("librarian_daily_wiki").on(t.orgId, t.wikiId, t.dailyKey),
    unique("librarian_run_inbox").on(t.inboxId),
    uniqueIndex("librarian_one_active_org").on(t.orgId).where(sql`${t.state} = 'running'`),
    check(
      "librarian_run_money",
      sql`${t.cap} >= 0 and ${t.settled} >= 0 and ${t.uncertain} >= 0 and ${t.reserved} >= 0`,
    ),
  ],
);
export const librarianAttempts = pgTable(
  "librarian_attempts",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => librarianRuns.id),
    requestId: text("request_id").unique(),
    state: text("state").notNull(),
    ceiling: bigint("ceiling", { mode: "bigint" }).notNull(),
    charged: bigint("charged", { mode: "bigint" }),
    createdAt: createdAt(),
  },
  (t) => [
    check("librarian_attempt_money", sql`${t.ceiling} >= 0 and (${t.charged} is null or ${t.charged} >= 0)`),
  ],
);

export const librarianInbox = pgTable(
  "librarian_inbox",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    wikiId: uuid("wiki_id")
      .notNull()
      .references(() => projects.id),
    submittedBy: uuid("submitted_by").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    input: jsonb("input").$type<import("@artifacts/schema").SourceInput>(),
    quarantineKey: text("quarantine_key"),
    note: text("note"),
    sourceHash: text("source_hash"),
    sourceArtifactId: uuid("source_artifact_id").references(() => artifacts.id),
    extractionVersion: text("extraction_version"),
    status: text("status").notNull().default("queued"),
    idempotencyKey: uuid("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    runId: uuid("run_id").references(() => librarianRuns.id),
    errorCode: text("error_code"),
    untrusted: boolean("untrusted").notNull().default(true),
    submittedAt: time("submitted_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
    rawExpiresAt: time("raw_expires_at").notNull(),
  },
  (t) => [
    unique("librarian_inbox_submit_key").on(t.orgId, t.submittedBy, t.idempotencyKey),
    index("librarian_inbox_due").on(t.orgId, t.status, t.submittedAt),
    check("librarian_inbox_untrusted", sql`${t.untrusted} = true`),
  ],
);
export const librarianReceipts = pgTable(
  "librarian_receipts",
  {
    id: id().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => librarianRuns.id),
    toolKey: uuid("tool_key").notNull(),
    inputHash: text("input_hash").notNull(),
    result: jsonb("result").$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("librarian_receipt_tool").on(t.runId, t.toolKey),
    check("librarian_receipt_bound", sql`octet_length(${t.result}::text) <= 65536`),
  ],
);
export const librarianProposals = pgTable(
  "librarian_proposals",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => librarianRuns.id),
    wikiId: uuid("wiki_id")
      .notNull()
      .references(() => projects.id),
    proposalKey: uuid("proposal_key").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    markdown: text("markdown").notNull(),
    sources: uuid("sources").array().notNull(),
    untrusted: boolean("untrusted").notNull().default(true),
    status: text("status").notNull().default("open"),
    reviewedBy: uuid("reviewed_by").references(() => people.id),
    reviewedAt: time("reviewed_at"),
    createdAt: createdAt(),
    createdArtifactId: uuid("created_artifact_id").references(() => artifacts.id),
  },
  (t) => [
    unique("librarian_proposal_key").on(t.runId, t.proposalKey),
    check(
      "librarian_proposal_bounds",
      sql`${t.untrusted} = true and octet_length(${t.markdown}) <= 1048576 and char_length(${t.summary}) <= 2000 and char_length(${t.title}) <= 256 and cardinality(${t.sources}) <= 100`,
    ),
  ],
);

/** Admin-only event codes. No provider payload, prompt, source text or error body. */
export const librarianEvents = pgTable(
  "librarian_events",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => org.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => librarianRuns.id),
    code: text("code").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("librarian_events_run").on(t.runId, t.createdAt, t.id)],
);
