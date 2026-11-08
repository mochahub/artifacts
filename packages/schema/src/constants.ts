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
/** `edit` sits between comment and publish: change an editable page's text, never its files (13). */
export const PERMISSIONS = ["view", "comment", "edit", "publish"] as const;
export const PROJECT_PERMISSIONS = ["view", "comment", "edit", "publish", "manage"] as const;
export const TEAM_ROLES = ["lead", "member"] as const;
export const PAGE_KINDS = ["canvas", "article", "prototype", "gallery", "deck"] as const;
export const THREAD_STATUSES = ["open", "fixed", "resolved"] as const;
export const ANCHOR_STATES = ["ok", "updated", "orphaned", "moved_version"] as const;
export const DECISION_KINDS = ["approved", "changes_requested"] as const;
export const DATA_SCOPES = ["shared", "me"] as const;
/** A wiki is a project whose artifacts are pages of one knowledge base (SPEC 16). */
export const PROJECT_KINDS = ["project", "wiki"] as const;
/** What an artifact is to its wiki: a page people read, or a source pages are written from. */
export const WIKI_ROLES = ["page", "source"] as const;
/** The slug of a wiki's rules page, which agents read before anything else in it. */
export const WIKI_RULES_SLUG = "rules";
/** Links and sources one version may record. More than any page needs. */
export const WIKI_LINKS_MAX = 500;
export const WIKI_SOURCES_MAX = 50;
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
  // Editing (13). A CLI that doesn't send EDITING_FEATURE never sees these: see "Older clients" in 13.
  "checkpointed",
  "edited",
  "suggested",
  "suggestion_accepted",
  "suggestion_rejected",
  "run_started",
  "run_finished",
  "maintained_changed",
] as const;
/** The activity kinds an older CLI can't parse, and what it is sent instead (null: left out). */
export const EDITING_ACTIVITY_FALLBACK = {
  checkpointed: "published",
  edited: null,
  suggested: null,
  suggestion_accepted: null,
  suggestion_rejected: null,
  run_started: null,
  run_finished: null,
  maintained_changed: null,
} as const;

/** What a token may do (04, "Scopes"). Sessions have no scopes. */
export const TOKEN_SCOPES = ["publish", "comment", "read", "manage", "data", "org", "edit"] as const;
type TokenScope = (typeof TOKEN_SCOPES)[number];
/** What a CLI sign-in gets: everything but `org`, which only an organization token holds. */
export const CLI_SCOPES = [
  "publish",
  "comment",
  "read",
  "manage",
  "data",
  "edit",
] as const satisfies TokenScope[];
/** What a connector can ask for (04, "Connectors"). */
export const OAUTH_SCOPES = ["read", "comment", "publish", "edit"] as const satisfies TokenScope[];
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/** What `GET /api/events` sends (03). */
/** `draft` goes only to streams whose caller can edit the artifact (13). */
export const EVENT_TYPES = ["thread", "comment", "version", "decision", "data", "draft"] as const;
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

// Editing (13)
/** How agents may work on a page right now, as each person in the editor chooses it. */
export const EDIT_MODES = ["write", "pair", "delegate"] as const;
/** What made a checkpoint version. Null on `versions.checkpoint` for an ordinary publish or restore. */
export const CHECKPOINT_KINDS = ["saved", "quiet", "delegate", "agent", "handoff"] as const;
export const SUGGESTION_STATUSES = ["open", "accepted", "rejected", "stale", "expired", "withdrawn"] as const;
export const SUGGESTION_OPS = ["replace", "insert", "delete", "meta"] as const;
export const RUN_STATUSES = ["active", "finished", "accepted", "rejected", "cancelled", "expired"] as const;
/** What a block the editor can't represent losslessly holds: its exact Markdown, drawn by the read pipeline. */
export const ATOM_KINDS = ["image", "chart", "mermaid", "frame", "html", "markdown"] as const;
/** Why a page can't be edited in the browser. */
export const NOT_EDITABLE_REASONS = [
  "not_wiki",
  "not_article",
  "has_backend",
  "archived",
  "redraw",
  "no_access",
] as const;
/**
 * A CLI that parses the editing enum values sends this header with this word. A request with
 * `Artifacts-CLI` and without it gets the fallbacks in 13, "Older clients".
 */
export const FEATURES_HEADER = "Artifacts-Features";
export const EDITING_FEATURE = "editing";

// Patterns
export const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Project and artifact slugs. */
export const SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;
/** Page and board ids. */
export const KEY_PATTERN = /^[a-z0-9-]{1,60}$/;
/**
 * A lasting block id on an editable page (13): `~` and ten base-36 characters. A heading slug never
 * holds `~`, so these can't collide with the `<heading>/p<n>` ids of older versions.
 */
export const BLOCK_ID_PATTERN = /^~[0-9a-z]{10}$/;
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

// Editing limits (13)
export const EDIT_UPDATE_MAX = 1024 * 1024;
export const EDIT_DOC_MAX = 4 * 1024 * 1024;
export const EDIT_BLOCKS_MAX = 2000;
export const EDIT_MESSAGES_PER_SECOND = 30;
export const EDIT_SOCKETS_PER_PERSON = 10;
export const EDIT_EDITORS_MAX = 25;
export const EDIT_OPS_MAX = 50;
export const EDIT_OP_MARKDOWN_MAX = 64 * 1024;
export const EDIT_CALL_MARKDOWN_MAX = 256 * 1024;
export const EDIT_CALLS_PER_MINUTE = 60;
export const SUGGESTIONS_OPEN_MAX = 200;
export const SUGGESTION_NOTE_MAX = 2000;
export const RUN_GOAL_MAX = 500;
export const EDIT_COMPACT_UPDATES = 500;
export const EDIT_COMPACT_BYTES = 1024 * 1024;
/** Coalesce one connection's updates this long before persisting them. */
export const EDIT_COALESCE_MS = 100;
export const EDIT_HEARTBEAT_MS = 25_000;
/** Bigger awareness updates aren't sent through NOTIFY (8000-byte payloads); replicas re-query. */
export const EDIT_NOTIFY_AWARENESS_MAX = 6000;

// How long things last (04)
export const INVITE_DAYS = 7;
export const RESET_HOURS = 1;
/** A deleted artifact can be restored for this long, then it's purged. */
export const PURGE_DAYS = 30;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
/** Editing (13): a quiet spell checkpoints, and so does a draft this old without one. */
export const EDIT_QUIET_MS = 2 * MINUTE_MS;
export const EDIT_DRAFT_MAX_MS = 30 * MINUTE_MS;
/** After the last editor leaves, a dirty draft checkpoints this soon. */
export const EDIT_LEAVE_MS = 30_000;
/** A presence row older than this doesn't count: nobody is there. */
export const PRESENCE_TTL_MS = 30_000;
/** An agent shows in presence this long after its last operation. */
export const AGENT_PRESENCE_MS = MINUTE_MS;
export const RUN_MAX_MS = HOUR_MS;
export const SUGGESTION_DAYS = 14;

// Boards (14): independent editor budget; the read bundle stays at 80 KB gzip.
export const BOARD_OBJECTS_MAX = 2000;
export const BOARD_TEXT_MAX = 16_000;
export const BOARD_LABEL_MAX = 280;
export const BOARD_COORD_MAX = 1_000_000;
export const BOARD_DIMENSION_MAX = 100_000;
export const BOARD_ORDER_MAX = 64;
export const BOARD_DEPTH_MAX = 8;
export const BOARD_STROKE_POINTS_MAX = 2048;
export const BOARD_ASSET_MAX = 10 * 1024 * 1024;
export const BOARD_ASSET_PIXELS_MAX = 16_000_000;
export const BOARD_ASSETS_MAX = 200;
export const BOARD_ASSETS_BYTES_MAX = 100 * 1024 * 1024;
export const BOARD_OBJECT_JSON_MAX = 256 * 1024;
export const BOARD_JSON_MAX = 4 * 1024 * 1024;
export const BOARD_OPS_MAX = 50;
export const BOARD_CALL_MAX = 256 * 1024;
export const BOARD_CAPTURE_TTL_MS = 5 * MINUTE_MS;
export const BOARD_PLACEMENT_TRIES = 100;
export const BOARD_EDITOR_GZIP_MAX = 160_000;

/** Clients understanding native-object comment anchors advertise this alongside editing. */
export const BOARDS_FEATURE = "boards";

/** The message types on the sync socket: y-protocols' sync and awareness, and ours. */
export const SYNC_MESSAGE = { sync: 0, awareness: 1, auth: 2, queryAwareness: 3, control: 100 } as const;
/** Close codes. Not found and not editable look the same, so a socket reveals nothing. */
export const SYNC_CLOSE = {
  invalidUpdate: 4400,
  unauthenticated: 4401,
  lostAccess: 4403,
  notFound: 4404,
  reset: 4409,
  tooLarge: 4413,
  rateLimited: 4429,
  restarting: 4000,
} as const;
