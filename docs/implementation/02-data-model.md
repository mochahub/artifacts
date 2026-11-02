# 02 · Data model: Postgres and the bucket

**Contract document.** This file owns every table name, column name, enum value and bucket prefix. Other documents link here rather than restating it. Behaviour comes from [SPEC.md](../SPEC.md).

## Conventions

- **Ids** are UUIDv7 (`uuid` columns), generated in the app with `Bun.randomUUIDv7()`. They're time-ordered, so they index well and sort by creation.
- **Every table has `org_id`**, not null and referencing `org`, except `org` itself (SPEC §14), even though one deployment is one organization, so multi-tenancy never needs a migration. That includes child tables that could reach it through a parent. Every query filters on it. The test in `apps/server/test/data-model.test.ts` enforces this.
- **Timestamps** are `timestamptz`. Soft-delete and lifecycle columns are nullable timestamps (`archived_at`, `deleted_at`, `revoked_at`).
- **Secrets are stored hashed.** Session tokens, invite tokens, reset tokens, CLI tokens, share-link tokens and device codes are stored as SHA-256 hex of the secret (`*_hash`); the secret itself appears only once, in the response that creates it. Passwords use argon2id via `Bun.password`.
- **Migrations** are Drizzle (`apps/server/src/db/schema.ts` → `apps/server/drizzle/`), run at boot. They only add: new tables, new nullable columns, new indexes. A column is dropped only two releases after the code stops reading it, so `artifacts upgrade --to <previous>` keeps working (SPEC §7.4).
- **Enums** are Postgres enums named below.

## Enums

| Enum | Values |
|---|---|
| `role` | `owner`, `admin`, `member`, `reviewer`, `outside` |
| `visibility` | `me`, `org` |
| `permission` | `view`, `comment`, `publish` (`publish` only for organization members in `artifact_access`; it includes `comment`) |
| `project_permission` | `view`, `comment`, `publish`, `manage` |
| `token_kind` | `cli`, `org`, `oauth` |
| `invite_kind` | `org`, `artifact`, `project` |
| `page_kind` | `canvas`, `article`, `prototype`, `gallery`, `deck` |
| `thread_status` | `open`, `fixed`, `resolved` |
| `anchor_state` | `ok`, `updated`, `orphaned`, `moved_version` |
| `decision_kind` | `approved`, `changes_requested` |
| `device_status` | `pending`, `approved`, `denied`, `used` |
| `team_role` | `lead`, `member` |
| `activity_kind` | `published`, `restored`, `commented`, `replied`, `fixed`, `resolved`, `reopened`, `approved`, `changes_requested`, `archived`, `unarchived`, `deleted`, `undeleted`, `purged`, `version_deleted`, `version_undeleted`, `version_named`, `shared`, `joined`, `recovered`, `team_created`, `team_deleted`, `team_member_added`, `team_member_removed`, `project_access_changed`, `identity_linked` |

## Tables

### Organization and people

**`org`**: one row per deployment.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | "Mochahub" |
| `home_domain` | text not null | Hostname that `artifacts setup` ran against; the passkey RP ID. Never changes (SPEC §7.3). |
| `settings` | jsonb not null | `{ defaultVisibility: "org"\|"me", linkSharing: true, defaultProjectAccess: "org"\|"restricted", googleAutoJoin: { domain, role, teamIds } \| null, limits: { dataValueBytes, dataKeysPerScope, dataBytesPerScope, fileBytes, filesBytesPerArtifact, backendCodeBytes, backendTimeoutMs, backendMemoryMb, backendRequestBytes, backendResponseBytes, backendRequestsPerMinute, writesPerSecond }, sandboxProcesses: 2 }`. Defaults in [08-micro-apps.md](08-micro-apps.md#data-store-server). |
| `vapid_public` | text null | Phase 2. Generated the first time push needs it, not at boot, because there's no `org` row on first boot. |
| `vapid_private` | text null | Phase 2. Stored as is: anyone who can read this table can already read everything else, and tying it to `SESSION_SECRET` would stop that secret being rotated. |
| `last_digest_at` | timestamptz null | Phase 2. When the daily push digest last went out, so a restart doesn't send it again. |
| `google_client_id`, `google_client_secret` | text null | The Google client. Stored as is, like `vapid_private`, and outside `settings`, so `/api/org` never returns it. Not encrypted with `SESSION_SECRET`, which 04 promises only touches sessions and content tokens. |
| `google_enabled` | boolean not null default false | Whether people can use it. |
| `google_tested_by` | uuid null FK people | Who finished a round trip with these credentials. Only they can turn it on, and new credentials clear it. |
| `brand` | jsonb null | The applied brand: `{ name, theme, fonts: [{ family, weight, style, format, hash }] }`. Null means the default look. Only a person changes it (04). |
| `pseudonym_key` | bytea not null | 32 random bytes generated at setup. Keys the per-artifact caller pseudonyms (08). Separate from `SESSION_SECRET` so that secret can be rotated; never rotated itself, because `me` data is keyed by pseudonym. |
| `created_at` | timestamptz | |

**`people`**

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK org | |
| `email` | citext not null | Sign-in name; unique per org among rows where `removed_at is null`. Never verified (SPEC §7.3). |
| `name` | text not null | Display name. |
| `role` | `role` | `outside` = account created by an artifact invite; sees only artifacts in `artifact_access`. |
| `created_at`, `removed_at` | timestamptz | Removing a person sets `removed_at`, ends their sessions and tokens, revokes the organization tokens and share links they created, keeps their comments with their name. |

Index: unique `(org_id, lower(email)) where removed_at is null`.

**`passwords`**: `person_id` uuid PK FK people, `org_id`, `hash` text (argon2id PHC string), `updated_at`.

**`passkeys`**

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid | |
| `person_id` | uuid FK | |
| `credential_id` | bytea unique | |
| `public_key` | bytea | COSE key from `@simplewebauthn/server`. |
| `counter` | bigint | |
| `transports` | text[] | |
| `rp_id` | text not null | Usually `org.home_domain`; another viewer domain when made in a browser without Related Origin Requests (SPEC §7.3). |
| `name` | text | "iCloud Keychain", editable. |
| `created_at`, `last_used_at` | timestamptz | |

**`identities`**: a sign-in from outside. `id`, `org_id`, `person_id`, `provider` text (`google`), `subject` text (Google's `sub`: email can change and isn't unique), `email` text (the last one seen, for display), `hosted_domain` text null (the `hd` claim), `created_at`, `last_used_at`. Unique `(org_id, provider, subject)` and `(person_id, provider)`. A reset or removing the person deletes these (04).

**`removed_identities`**: PK `(org_id, provider, subject_hash)`, `created_at`. A SHA-256 of the `subject` of each identity a removed person had, so Workspace auto-join can refuse them after their row in `identities` is gone. Re-inviting them still works.

**`google_states`**: one round trip, for 10 minutes and one use. `id`, `org_id`, `state_hash` unique, `browser_hash` (of the cookie that started it), `nonce`, `code_verifier`, `intent` text (`signin`, `invite`, `link`, `reauth`, `test`), `session_id` null (cascades), `person_id` null, `invite_id` null (cascades), `next` text (a path on this site), `redirect_uri`, `expires_at`. Deleted when used, or once expired, by the next round trip or the daily job.

**`webauthn_challenges`**: `id` uuid PK, `org_id`, `challenge` text, `kind` text (`register` \| `authenticate`), `person_id` uuid null, `expires_at` (5 minutes). Deleted when used or expired.

**`sessions`**

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid | |
| `token_hash` | text unique | Cookie `art_session` holds the secret. |
| `person_id` | uuid FK | |
| `domain` | text | Viewer hostname the cookie was set on. |
| `auth_at` | timestamptz | Last time the person proved a credential. "Recent sign-in" = within 10 minutes (SPEC §7.3). |
| `created_at`, `last_seen_at`, `expires_at` | timestamptz | `expires_at` = `last_seen_at` + 30 days, sliding. |
| `user_agent`, `ip` | text | Shown on the sign-in settings page. |

**`guests`**: one row per browser that opened a share link.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | Stable guest id; cookie `art_guest` holds a secret whose hash is `token_hash`. |
| `org_id` | uuid | |
| `token_hash` | text unique | |
| `created_at`, `last_seen_at` | timestamptz | |

**`guest_links`**: a guest's name and access per share link. PK `(guest_id, share_link_id)`, `org_id`, `name` text not null (what they typed), `created_at`, `expires_at` (90 days from first use, never past the link's own expiry). Revoking or expiring the link ends access at once (checked on every request).

**`invites`**

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid | |
| `kind` | `invite_kind` | `org` (role invite), or `artifact` or `project` (outside person). |
| `email` | citext | |
| `role` | `role` | For `org` invites: `admin`, `member` or `reviewer`. For `artifact` invites: `outside`. |
| `artifact_id` | uuid null | For `artifact` invites. |
| `permission` | `permission` null | For `artifact` invites. |
| `project_id` | uuid null | For `project` invites. |
| `project_permission` | `project_permission` null | For `project` invites. |
| `via_token` | boolean not null default false | True when a token made the invite (`artifacts share --invite`). The `artifact_access` row it becomes carries it over (04). |
| `team_ids` | uuid[] null | Teams to join on accepting. Not a foreign key: a team deleted meanwhile is skipped. |
| `token_hash` | text unique | |
| `created_by` | uuid FK people | |
| `created_at`, `expires_at`, `accepted_at`, `revoked_at` | timestamptz | Expires in 7 days; single use. |

**`teams`**: people who work together, inside the organization. `id`, `org_id`, `slug` text (unique per org; `a-z0-9-`, up to 40 characters), `name` text, `description` text null, `created_by` uuid FK people, `created_at`.

**`team_members`**: PK `(team_id, person_id)`, `org_id`, `role` `team_role` (default `member`; a lead changes the membership, and must be a member or above), `added_by` uuid FK people, `created_at`. Index `(person_id)`. Removing a person deletes their rows.

**`reset_links`**: `id`, `org_id`, `person_id`, `token_hash` unique, `created_by` (uuid null; null when made by `artifacts recover`), `created_at`, `expires_at` (1 hour), `used_at`.

**`device_codes`**: the CLI's device flow.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid | |
| `device_code_hash` | text unique | The CLI polls with the secret device code. |
| `user_code` | text unique | `WDJB-MJHT`: 8 characters from `BCDFGHJKLMNPQRSTVWXZ`, shown in the terminal and on the approval page. |
| `client_name` | text | "Sam's MacBook Pro". |
| `agent` | text null | "Claude Code", detected by the CLI. |
| `status` | `device_status` | |
| `person_id` | uuid null | Set on approval. |
| `ip`, `user_agent` | text null | Where `POST /api/device/start` came from, shown on the approval page (03). |
| `created_at`, `expires_at` | timestamptz | 10 minutes. |

**`tokens`**: CLI and organization tokens.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid | |
| `kind` | `token_kind` | `cli` acts as a person; `org` acts as the organization for CI. |
| `person_id` | uuid null | For `cli`. |
| `name` | text | "artifacts CLI on Sam's MacBook Pro", or an admin's label. |
| `token_hash` | text unique | Secret format `art_<base32 32 bytes>`. |
| `scopes` | text[] | See [04-auth-and-permissions.md](04-auth-and-permissions.md#token-scopes). |
| `project_ids` | uuid[] null | `org` tokens only; null = all projects. |
| `created_by` | uuid FK people | |
| `created_at`, `last_used_at`, `expires_at`, `revoked_at` | timestamptz | `cli` tokens don't expire; they're revoked from the sign-in page or by `logout`. `oauth` tokens last an hour. |
| `grant_id` | uuid null FK oauth_grants | `oauth` tokens only. |
| `audience` | text null | `oauth` tokens only: the MCP endpoint it may be used at, on the origin it was issued for. |

**`brand_proposals`**: `id`, `org_id`, `name`, `brand` jsonb (the same shape as `org.brand`), `artifact_id` uuid null (the sample; cleared if it's purged), `proposed_by` uuid FK people, `agent` text null, `created_at`, `applied_at`, `applied_by`.

**`oauth_clients`**: `id`, `org_id`, `client_id` text (unique per org: `art_client_…` from registration, or a metadata document's URL), `name`, `redirect_uris` text[], `metadata_url` bool, `created_at`, `fetched_at` (when a metadata document was last read; it's kept an hour). A registered client nothing has used goes after 30 days.

**`oauth_grants`**: one person's consent to one client. `id`, `org_id`, `person_id`, `client_id`, `client_name` (snapshot for display), `audience`, `scopes` text[], `created_at`, `last_used_at`, `revoked_at`. Revoking it ends every token from it. It's what Settings shows as a connector.

**`oauth_codes`**: `id`, `org_id`, `code_hash` unique, `grant_id`, `client_id`, `redirect_uri`, `code_challenge`, `created_at`, `expires_at` (5 minutes), `used_at`.

**`oauth_refresh_tokens`**: `id`, `org_id`, `grant_id`, `token_hash` unique, `created_at`, `expires_at` (60 days), `used_at`. Rotated on each use; one coming back revokes the grant.

### Projects and artifacts

**`projects`**: `id`, `org_id`, `slug` text (unique per org; lowercase `a-z0-9-`, 1–40 chars, not a reserved word, see [06-viewer.md](06-viewer.md#routes)), `name` text, `repo` text null (`owner/name`, lowercased, from `git remote`; a project with none learns it on its next publish), `restricted` boolean not null default false, `created_by` uuid null FK people (null for a project from before this column, or one a token made), `created_by_token` uuid null FK tokens (the organization token that made it), `created_at`, `updated_at`. Index `(org_id, lower(repo))`.

**`project_access`**: access to a whole project, for a person or a team. `id`, `org_id`, `project_id`, `person_id` uuid null, `team_id` uuid null, `permission` `project_permission`, `granted_by`, `created_at`. Exactly one of `person_id` and `team_id` is set. Unique `(project_id, person_id)` and `(project_id, team_id)`; indexes on `person_id` and `team_id`. Whoever creates a project gets `manage` here. Tokens never write this table.

**`artifacts`**

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id`, `project_id` | uuid | |
| `slug` | text | Unique per project among rows not yet purged (purged rows are deleted, so a plain unique index works). |
| `title` | text | From the manifest; latest publish wins. |
| `visibility` | `visibility` | |
| `publisher_id` | uuid FK people | Who first published it. Owns it for archive, delete, share and data export. |
| `latest_version` | int | Highest live version number. |
| `has_backend` | bool | True if the latest version has a backend. |
| `thread_counter` | int | The last thread number used. Numbers are never reused, even after a thread's only comment is deleted. |
| `archived_at`, `archived_by` | timestamptz, uuid null | Archived = read-only (SPEC §5.5). |
| `deleted_at`, `deleted_by`, `purge_after` | timestamptz, uuid null, timestamptz | In Recently deleted while set; `purge_after` = `deleted_at` + 30 days. |
| `created_at`, `updated_at` | timestamptz | |

Indexes: unique `(project_id, slug)`; `(org_id, updated_at desc) where deleted_at is null`; `(purge_after) where deleted_at is not null`.

**`artifact_access`**: people added to one artifact. PK `(artifact_id, person_id)`, `org_id`, `permission`, `granted_by`, `via_token` (boolean not null default false), `created_at`. Used for "Only me plus people I add", and for outside people. `via_token` is true while the access was granted by a token and no person has granted it again: the person can comment (when the permission allows) but can't approve, request changes or resolve threads (04). A person creating or changing the row sets it to false; a token creating it, or changing its permission, sets it to true.

**`artifact_team_access`**: a team's access to one artifact. PK `(artifact_id, team_id)`, `org_id`, `permission`, `granted_by`, `via_token` (boolean not null default false, as on `artifact_access`), `created_at`. Index `(team_id)`. It's separate from `artifact_access` because that table's key needs a person, and widening it wouldn't be additive.

**`share_links`**: `id`, `org_id`, `artifact_id`, `token_hash` unique (URL `/s/<secret>`), `permission`, `created_by`, `created_at`, `expires_at` null, `revoked_at` null.

### Versions and content

**`versions`**

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id`, `artifact_id` | uuid | |
| `n` | int | 1, 2, 3…; unique `(artifact_id, n)`. Numbers are never reused, even after a version is purged. |
| `files` | jsonb | The version manifest: `{ "<path>": { "hash": "<sha256>", "size": 1234, "type": "text/html" } }`. Every file in the bundle, including `artifact.json`, generated article HTML, the backend module and the backend's source. Paths must pass `isBundlePath`: relative, no `..`, no `.git`, no backslash (03). |
| `backend_hash` | text null | sha256 of the bundled backend module, if any. |
| `message` | text | `publish -m`. |
| `name` | text null | Version name ("Real photos"), set by `publish --name`, `versions name`, or the viewer. |
| `notes` | jsonb | `{ "<frameKey>": "Moved MF above the strip" }` from `--note`. |
| `summary` | text null | The manifest's `summary`, at most 280 characters. Null on versions from before it existed; those show their first text instead (03). |
| `tags` | text[] null | The manifest's `tags`, at most 8 of at most 32 characters. |
| `published_by` | uuid FK people | |
| `agent` | text null | "Claude Code", from the CLI's detection. |
| `restored_from` | int null | Set when the version was made by restoring version n. |
| `published_at` | timestamptz | |
| `deleted_at`, `deleted_by`, `purge_after` | | Removing one version (SPEC §5.5). The latest and the only version can't be removed. |

**`blobs`**: bucket objects the server has hashed itself. PK `(org_id, hash)`, `size` bigint, `verified_at`. Files are shared by hash across artifacts, so "the bucket has this key" isn't proof of its content: anyone with a presigned PUT could have stored something else there. A hash counts as already stored only with a row here; commit downloads and hashes anything without one (05).

**`pages`**: `id`, `org_id`, `version_id`, `page_key` text (manifest page `id`), `kind` `page_kind`, `title`, `group` text null, `position` int, `meta` jsonb (article: `{ readingMinutes, htmlHash, outline: [{ id, title, level }], theme?: { accent, font, display, radius } }`; canvas: `{ boards: [{ key, title, subtitle, x, y, w, h }] }`). Unique `(version_id, page_key)`.

**`frames`**: canvas frames, one row per frame per version.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid | |
| `version_id` | uuid | |
| `page_key`, `board_key`, `frame_key` | text | `frame_key` = the author's `data-frame` id. Unique `(version_id, page_key, frame_key)`. |
| `title`, `device` | text | `device` from `data-device`. |
| `x`, `y`, `w`, `h` | real | Position and size on the board, in CSS pixels at 1x. |
| `content_hash` | text | sha256 of the frame's 1x render pixels (SPEC §6). Equal hash = unchanged frame. |
| `renders` | jsonb | `{ "1x": "<sha256>", "2x": "<sha256>", "3x": "<sha256>", "thumb": "<sha256>" }`, WebP blobs. |
| `live_path` | text null | Path of the frame's live HTML inside the bundle, for Try it. |

**`blocks`**: article blocks. `id`, `org_id`, `version_id`, `page_key`, `block_key` text (heading slug or `<heading slug>/p<n>`), `content_hash` text, `text` text (plain text, for quote re-anchoring and search). Unique `(version_id, page_key, block_key)`. GIN index on `to_tsvector('english', text)`. Ids are in reading order, because they're UUIDv7 written in order.

### Review

**`threads`**

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | Shown to people and agents as a short number: `n` below. |
| `org_id`, `artifact_id` | uuid | |
| `n` | int | Per-artifact thread number (#3); unique `(artifact_id, n)`. |
| `page_key` | text | |
| `anchor` | jsonb null | Canvas `{ type: "frame", frameKey, x, y }` (x, y are 0–1 fractions). Article `{ type: "text", blockKey, quote: { exact, prefix, suffix } }` or `{ type: "block", blockKey }`. Null = page-level. |
| `anchor_state` | `anchor_state` | Recomputed on every publish ([05-publish-and-storage.md](05-publish-and-storage.md#re-anchoring)). |
| `status` | `thread_status` | |
| `created_version` | int | Version it was made on. |
| `fixed_version` | int null | Set by an agent's `reply --fixed`. |
| `moved_from_version` | int null | The removed version this thread was made on. It survives later re-anchoring, and purging that version scrubs the thread's crop and quote, which show the removed content. |
| `author_person_id`, `author_guest_id` | uuid null | Exactly one is set. |
| `author_name` | text | Snapshot for display. |
| `crop_key` | text null | `crops/<thread id>.webp` for canvas threads. |
| `created_at`, `resolved_at` | timestamptz | |
| `resolved_by` | uuid null | A person; never an agent (SPEC §6). |

**`comments`**: `id`, `thread_id`, `org_id`, `author_person_id` / `author_guest_id` (one set), `author_name`, `agent` text null (always set when a token wrote it: the client's name for itself, or `agent` if it gave none. Shown with its person, as "Zahin's agent". Comments from before this rule were saved with none, and can't be told apart), `body` text (Markdown, 10 000 chars max), `version` int, `marks_fixed` bool, `created_at`, `edited_at`. GIN index on `to_tsvector('english', body)`.

**`decisions`**: `id`, `org_id`, `artifact_id`, `version` int, `person_id`, `kind` `decision_kind`, `note` text, `created_at`. The latest row per artifact is the current decision.

**`views`**: per person per artifact. PK `(person_id, artifact_id)`, `org_id`, `last_seen_version` int, `last_seen_at`, `positions` jsonb (`{ "<pageKey>": { scrollY | blockKey } }`). Guests: PK `(guest_id, artifact_id)` in **`guest_views`** with the same columns.

### Activity, lifecycle and operations

**`activity`**: `id`, `org_id`, `artifact_id` null, `project_id` null, `actor_person_id` null, `actor_guest_id` null, `agent` text null, `kind` `activity_kind`, `payload` jsonb (version, thread n, message…), `created_at`. Index `(org_id, created_at desc)`. Kept forever except rows whose artifact is purged (replaced by one `purged` row).

**`tombstones`**: one line left by a purge. `id`, `org_id`, `kind` (`artifact` \| `version`), `project_slug`, `slug`, `title`, `version` int null, `deleted_by`, `purged_at`. No content.

**`backend_logs`** (Phase 2): `id`, `org_id`, `artifact_id`, `version` int, `level` text (`log`, `warn`, `error`), `message` text (8 KB max), `request_id` text, `created_at`. At most 100 rows per request. A job deletes rows older than 24 hours.

**`artifact_usage`** (Phase 2): the data store's counters for limits. PK `(artifact_id, scope)` with `scope` in `shared`, `me`, `files`; `org_id`, `keys` int, `bytes` bigint, `updated_at`. Writes lock the row (`SELECT … FOR UPDATE`) for the length of one data write (08). Recounted by the daily job for artifacts written that day; deleted with the artifact on purge.

**`push_subscriptions`** (Phase 2): `id`, `org_id`, `person_id`, `session_id` (cascades, so ending a session ends its device's pushes), `endpoint` text unique, `keys` jsonb, `created_at`, `last_ok_at`.

**`releases`**: none. The app learns the latest release from GitHub Releases (cached 6 hours) for the admin "new version" notice.

**`artifact_usage`** ships with M9; `backend_logs` with M10 and `push_subscriptions` with M11.

## Derived state, not stored

- **Status of an artifact for a person** (SPEC §5.1): computed per request.
  1. If the latest decision is `approved` for the latest version, it's **Approved vN**.
  2. Else if the latest decision is `changes_requested` and no version was published after it, it's **With <agent or publisher>**.
  3. Else if a version newer than `views.last_seen_version` exists, or a comment by someone else replied to the person's thread since `last_seen_at`, it's **Waiting on you**.
  4. Else if there are no decisions, it's **Not reviewed yet**.
- **Open counts**: threads with `status = open` (fixed threads count as waiting on the person to resolve).
- **Changed since version m**: frames and blocks whose `content_hash` differs between versions.

## Bucket layout

One bucket, private (Railway buckets have no public mode). Every object is reached through the app: presigned URLs or proxied reads.

| Prefix | What | Written by | Lifetime |
|---|---|---|---|
| `blobs/<sha256>` | Every bundle file, render, generated article HTML and backend module. Content-addressed and immutable; `Content-Type` set at upload. | The CLI, by presigned PUT | Until the daily clean-up finds nothing uses it ([05](05-publish-and-storage.md#clean-up)) |
| `plans/<id>.json` | An upload plan for a connector's publish: the signed PUTs, kept out of tool results | The app | A day, then the clean-up job |
| `crops/<thread id>.webp` | Comment crops | The app, when a canvas thread is made | Until its artifact is purged |
| `data/<artifact id>/shared/<key>` | Built-in store, shared scope (JSON) | The app, for frontends and backends | Until cleared or purged |
| `data/<artifact id>/me/<caller id>/<key>` | Built-in store, per-person scope (JSON). `<caller id>` is the per-artifact pseudonym of the person or guest ([08](08-micro-apps.md#request-flow)), the same id a backend sees. | The app | Same |
| `data/<artifact id>/files/shared/<name>` and `files/me/<caller id>/<name>` | Stored files | The app | Same |

Keys and file names: 1–200 characters of `A-Za-z0-9._/-`, no leading `/`, no `..`.
