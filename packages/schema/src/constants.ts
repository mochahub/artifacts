/**
 * Names, patterns and limits that the server, the CLI and the viewer all hold to. No zod here, so the
 * viewer can import them without spending its bundle budget. The zod schemas build on these.
 */

// Enums (02 owns them; the database's pgEnums are built from these lists).
export const ROLES = ["owner", "admin", "member", "reviewer", "outside"] as const;
/** The roles an invite can give: an owner is made at setup, and outside people come in through a share. */
export const INVITE_ROLES = ["admin", "member", "reviewer"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];
export const VISIBILITIES = ["me", "org"] as const;
export const PERMISSIONS = ["view", "comment", "publish"] as const;
export const PROJECT_PERMISSIONS = ["view", "comment", "publish", "manage"] as const;
export const TEAM_ROLES = ["lead", "member"] as const;
export const PAGE_KINDS = ["canvas", "article", "prototype", "gallery", "deck"] as const;
export const THREAD_STATUSES = ["open", "fixed", "resolved"] as const;
export const ANCHOR_STATES = ["ok", "updated", "orphaned", "moved_version"] as const;
export const DECISION_KINDS = ["approved", "changes_requested"] as const;
export const DATA_SCOPES = ["shared", "me"] as const;
export const ACTIVITY_KINDS = [
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
  "identity_linked",
] as const;

/** What a token may do (04, "Scopes"). Sessions have no scopes. */
export const TOKEN_SCOPES = ["publish", "comment", "read", "manage", "data", "org"] as const;
type TokenScope = (typeof TOKEN_SCOPES)[number];
/** What a CLI sign-in gets: everything but `org`, which only an organization token holds. */
export const CLI_SCOPES = ["publish", "comment", "read", "manage", "data"] as const satisfies TokenScope[];
/** What a connector can ask for (04, "Connectors"). */
export const OAUTH_SCOPES = ["read", "comment", "publish"] as const satisfies TokenScope[];
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/** What `GET /api/events` sends (03). */
export const EVENT_TYPES = ["thread", "comment", "version", "decision", "data"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** The `?google=` result on a redirect back from Google (03, "Google sign-in"). */
export const GOOGLE_OUTCOMES = [
  "expired",
  "off",
  "cancelled",
  "failed",
  "unverified",
  "link-first",
  "not-linked",
  "no-account",
  "invite-mismatch",
  "invite-gone",
  "in-use",
  "recent",
  "mismatch",
  "linked",
  "confirmed",
  "tested",
] as const;
export type GoogleOutcome = (typeof GOOGLE_OUTCOMES)[number];

// Patterns
export const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Project and artifact slugs. */
export const SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;
/** Page and board ids. */
export const KEY_PATTERN = /^[a-z0-9-]{1,60}$/;
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 -]{0,39}$/;
export const FONT_WEIGHT = /^[1-9]00$/;
/** Fonts ship in the bundle, because lint bans external ones. Extension to CSS `format()`. */
export const FONT_FORMATS = { woff2: "woff2", woff: "woff", otf: "opentype", ttf: "truetype" } as const;
export type FontFormat = keyof typeof FONT_FORMATS;
export const RADIUS = { min: 0, max: 32 } as const;
export const SCALE = { min: 0.85, max: 1.25 } as const;

// Limits
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
/** Names an agent signs with, such as "Claude Code". */
export const AGENT_MAX = 60;
export const COMMENT_MAX = 10_000;
export const FILES_MAX = 20_000;
export const GUEST_NAME_MAX = 60;
export const TEAM_NAME_MAX = 60;
export const TEAM_ABOUT_MAX = 280;
export const BRAND_NAME_MAX = 80;
export const VERSION_NAME_MAX = 120;
/** The frontmatter an agent reads instead of the whole artifact, so these caps are what keep search small. */
export const SUMMARY_MAX = 280;
export const TAGS_MAX = 8;
export const TAG_MAX = 32;
export const MAX_BRAND_FONTS = 8;
export const MAX_FONT_BYTES = 4 * 1024 * 1024;

// How long things last (04)
export const INVITE_DAYS = 7;
export const RESET_HOURS = 1;
/** A deleted artifact can be restored for this long, then it's purged. */
export const PURGE_DAYS = 30;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
