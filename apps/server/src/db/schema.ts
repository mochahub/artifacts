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
 * Phase 2 tables (backend_logs, artifact_usage, push_subscriptions) arrive with M9–M11.
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
export const tokenKind = pgEnum("token_kind", ["cli", "org"]);
export const inviteKind = pgEnum("invite_kind", ["org", "artifact"]);
export const pageKind = pgEnum("page_kind", ["canvas", "article", "prototype", "gallery", "deck"]);
export const threadStatus = pgEnum("thread_status", ["open", "fixed", "resolved"]);
export const anchorState = pgEnum("anchor_state", ["ok", "updated", "orphaned", "moved_version"]);
export const decisionKind = pgEnum("decision_kind", ["approved", "changes_requested"]);
export const deviceStatus = pgEnum("device_status", ["pending", "approved", "denied", "used"]);
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
]);

// Organization and people

export const org = pgTable("org", {
  id: id(),
  name: text("name").notNull(),
  homeDomain: text("home_domain").notNull(),
  settings: jsonb("settings").notNull(),
  vapidPublic: text("vapid_public"),
  vapidPrivate: text("vapid_private"),
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

// Projects and artifacts (declared before the tables that reference them)

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
    createdAt: createdAt(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("projects_org_slug_unique").on(t.orgId, t.slug)],
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
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.personId] })],
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
  (t) => [unique("blocks_version_page_block_unique").on(t.versionId, t.pageKey, t.blockKey)],
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
