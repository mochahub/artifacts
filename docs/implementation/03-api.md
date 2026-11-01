# 03 · HTTP API

**Contract document.** This file owns every path, request and response shape, header and error code. Types live in `packages/schema` (zod) and are generated from what's written here. Permissions are decided by one function ([04-auth-and-permissions.md](04-auth-and-permissions.md)); this file names the action each route checks.

## Servers and ports

The app is one process listening on three ports:

| Port (env) | Default | Reached from | Serves |
|---|---|---|---|
| `PORT` | 8080 | Public: every viewer domain (`PUBLIC_URL`, `MORE_URLS`, `org.home_domain`) | The viewer SPA, `/api/*`, `/.well-known/webauthn` |
| `CONTENT_PORT` | 8081 | Public: the content domain (`CONTENT_URL`) | `/t/<token>/…`, the **Live previews** host |
| `INTERNAL_PORT` | 8082 | Railway private network only; no domain is attached | `/internal/jobs/*`, for operators and tests |

Requests to the viewer port with a `Host` that isn't a viewer domain get 421, except `GET /api/health`, which answers any `Host` because Railway's and Docker's health checks send their own. Requests to the content port for anything but `/t/` get 404; `/t/` on another `Host` gets 421.

## Conventions

- **JSON** in and out, `Content-Type: application/json; charset=utf-8`. Times are ISO 8601 strings. Ids are UUIDs.
- **Callers** authenticate with one of these (details in 04):
  - the `art_session` cookie (people in the viewer)
  - `Authorization: Bearer art_…` (CLI and org tokens)
  - the `art_guest` cookie (share-link guests)
  - a path capability token (content host only)
- **CSRF:** every non-GET request on the viewer port that's authenticated by a cookie must carry an `Origin` header equal to one of the viewer origins; otherwise 403 `csrf`.
- **Caching:** list and detail `GET`s return an `ETag`; clients send `If-None-Match` and get 304. The MVP viewer polls with this (every 10 seconds on an open artifact, 60 seconds elsewhere).
- **Pagination:** cursor-based, `?limit=50&before=<cursor>`; responses have `nextCursor` (null at the end).
- **Request id:** every response carries `X-Request-Id`, the `requestId` in the logs.
- **Version header:** every response carries `Artifacts-Version: <server semver>`. The CLI sends `Artifacts-CLI: <semver>`; if it's below the server's minimum, the server answers 426 `cli_outdated` with `{ minVersion }`.

### Errors

```json
{ "error": { "code": "not_found", "message": "No artifact camerabuddy/roadmap.", "details": {} } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid` | Body fails validation; `details` has zod issues. Also a number or text Postgres refuses (a version past 2,147,483,647, a NUL byte), with empty `details`. |
| 401 | `unauthenticated` | No valid caller |
| 401 | `recent_auth_required` | The action needs a sign-in within 10 minutes; the viewer re-prompts |
| 403 | `forbidden` | Caller can't do this |
| 403 | `csrf` | Bad `Origin` |
| 403 | `read_only` | The artifact is archived (SPEC §5.5) |
| 404 | `not_found` | Missing, or not visible to the caller (never reveal existence) |
| 409 | `conflict` | Slug taken, version not latest, etc. |
| 409 | `slug_deleted` | Publishing to a slug in Recently deleted, for a caller who could see that artifact; `details: { deletedAt, deletedBy }`. Anyone else gets plain `conflict` |
| 410 | `gone` | Expired or used invite, reset or share link; a deleted artifact's page, only for a caller who could see it before it was deleted (everyone else gets 404, so a 410 never reveals that an artifact existed) |
| 412 | `precondition_failed` | `If-Match` didn't match (data store) |
| 413 | `too_large` | Over a size limit; `details: { limit }` |
| 421 | `misdirected` | Unknown `Host` |
| 426 | `cli_outdated` | CLI too old |
| 429 | `rate_limited` | `Retry-After` header set |
| 500 | `internal` | An unexpected failure; the detail is only in the logs |
| 503 | `setup_mode` | The deployment has no owner yet; only setup routes work |
| 503 | `busy` | A backend's queue is full |

## Setup and meta

| Method, path | Auth | Body → response |
|---|---|---|
| `GET /api/health` | none | `{ ok: true, version, setupMode: bool }` (Railway health check) |
| `GET /api/meta` | none | `{ version, minCliVersion, orgName, homeDomain, publicUrl, contentUrl, viewerOrigins: [] }`. `orgName` and `homeDomain` are null in setup mode; `contentUrl` is null until `CONTENT_URL` is set. |
| `POST /api/setup` | `setupToken` in body | `{ setupToken, orgName, name, email, password, clientName, agent? }` → `{ person, token }`. Only in setup mode; creates org (with `home_domain` = request `Host`), owner, password and a CLI token. 403 if the token is wrong (constant-time compare), 409 once set up. |
| `POST /api/recover` | `setupToken` in body | `{ setupToken, email }` → `{ resetUrl }` for an owner. Rate-limited to 5 per IP per hour. |
| `GET /.well-known/webauthn` | none | Only on the home domain: `{ "origins": [<other viewer origins>] }` (never the content origin). |

## Sign-in and account

| Method, path | Auth | Notes |
|---|---|---|
| `POST /api/auth/password` | none | `{ email, password }` → sets `art_session`; `{ person }`. Rate limits in 04. |
| `POST /api/auth/passkey/options` | none | `{ local?: bool }` → WebAuthn authentication options (`rpId`, `challengeId`). Empty `allowCredentials` (discoverable). `local` asks for this domain instead of the home domain, for browsers without Related Origin Requests. |
| `POST /api/auth/passkey/verify` | none | `{ challengeId, response }` → sets cookie; `{ person }` |
| `POST /api/auth/logout` | session or CLI token | Ends this session, or revokes the token that called it, so `artifacts logout` leaves nothing valid behind. |
| `GET /api/me` | any person caller | `{ person: { id, name, email, role }, org: { name }, recentAuth: bool }` |
| `GET /api/me/sessions` | session | Sessions, CLI tokens and connectors: `[{ id, kind: "session"\|"cli"\|"connector", name, userAgent, lastSeenAt, current }]` |
| `DELETE /api/me/sessions/:id` | session | Ends a session, revokes a CLI token, or ends a connector and every token from it. |
| `POST /api/me/password` | session, recent auth | `{ password }` (12+ chars) → ends other sessions. |
| `GET /api/me/passkeys` | session | `{ passkeys: [{ id, name, rpId, createdAt, lastUsedAt }], passwordSetAt }` |
| `POST /api/me/passkeys/options` | session, recent auth | → registration options for `rpId` = home domain (or the current domain when the client says it lacks Related Origin Requests). |
| `POST /api/me/passkeys/verify` | session, recent auth | `{ challengeId, response, name? }` → `{ passkey }` |
| `PATCH /api/me/passkeys/:id` | session | `{ name }` |
| `DELETE /api/me/passkeys/:id` | session, recent auth | Refused if it's the person's only credential. |
| `POST /api/auth/reauth` | session | `{ password }` or a passkey assertion → refreshes `auth_at`. |

### Invites, resets and joining

| Method, path | Auth | Notes |
|---|---|---|
| `GET /api/invites/:token` | none | Preview: `{ orgName, invitedBy, role, email, artifact?: { title } }`; 410 if used or expired. |
| `POST /api/invites/:token/accept` | none | `{ name, password? }` → creates the person, sets `art_session`; the viewer then offers passkey registration. |
| `GET /api/reset/:token` | none | Preview: `{ email }` or 410. |
| `POST /api/reset/:token` | none | `{ password }` → sets it, ends the person's other sessions, signs in. |

### Device flow (CLI sign-in)

| Method, path | Auth | Notes |
|---|---|---|
| `POST /api/device/start` | none | `{ clientName, agent? }` → `{ deviceCode, userCode, verificationUrl: "<PUBLIC_URL>/device", interval: 5, expiresIn: 600 }` |
| `POST /api/device/poll` | none | `{ deviceCode }` → `{ status: "pending" }`, `{ status: "denied" }`, or `{ status: "approved", token, person }` (once; then `used`). Polling faster than `interval` → 429. |
| `GET /api/device/:userCode` | session | `{ clientName, agent, createdAt, ip, userAgent }` for the approval page. The CLI prints the code and the URL without the code; the person types the code on `/device`, which then shows the client name, agent, IP and time before "Approve". A link alone can't get someone to approve a stranger's sign-in in one tap. |
| `POST /api/device/:userCode/approve` | session, recent auth | Creates a `cli` token with the default scopes. |
| `POST /api/device/:userCode/deny` | session | |

### Guests (share links)

| Method, path | Auth | Notes |
|---|---|---|
| `GET /api/s/:token` | none | `{ artifact: { id, project, slug, title, cover }, permission, needsName: bool, sharedBy }`; 410 if revoked or expired. |
| `GET /api/s/:token/cover` | none | 302 to the cover render, for the landing page, before the guest has a session. |
| `POST /api/s/:token/guest` | none | `{ name }` (1–60 chars) → sets `art_guest` if absent, creates `guest_links` row; `{ guest: { id, name } }` |

## Organization and people (admins)

| Method, path | Action checked | Notes |
|---|---|---|
| `GET /api/org` | `org.read` | Name, settings, domains (read-only view of `PUBLIC_URL`, `MORE_URLS`, `CONTENT_URL`, home domain). |
| `PATCH /api/org` | `org.manage` | `{ name?, settings? }` |
| `GET /api/people` | `people.read` | Members and pending invites: `{ people: [], invites: [] }`; `?kind=outside` lists outside people with what's shared with them. |
| `PATCH /api/people/:id` | `people.manage` | `{ role }`. Only an owner changes owners; there's always at least one owner. An admin or owner who becomes a member or reviewer also loses the invites and reset links they issued that are still unused. |
| `DELETE /api/people/:id` | `people.manage` | Sets `removed_at`, ends sessions and tokens, and revokes what they created: unused invites and reset links, organization tokens, share links (04). |
| `POST /api/people/:id/reset-link` | `people.invite` | → `{ url, expiresAt }`. A token gets 403 for an admin, an owner or itself. |
| `POST /api/invites` | `people.invite` | `{ email, role }` → `{ invite, url }` |
| `DELETE /api/invites/:id` | `people.manage` | Revoke. |
| `POST /api/invites/:id/link` | `people.invite` | → `{ url }`. Secrets are stored hashed, so this makes a new link and the old one stops; it's what "Copy" does on a pending invite. A token gets 403 unless the invite is for a member or reviewer. |
| `GET /api/tokens` / `POST /api/tokens` / `DELETE /api/tokens/:id` | `tokens.manage` + recent auth to create | Org tokens: `{ name, scopes, projectIds?, expiresAt? }` → `{ id, token }`, shown once. |
| `GET /api/shares` | `org.manage` | Every outside share (people and links) across artifacts. |

## Projects, artifacts and lists

| Method, path | Action | Notes |
|---|---|---|
| `GET /api/home` | `home.read` | `{ waiting: [ArtifactCard], recent: [ArtifactCard] }` |
| `GET /api/projects?q=&sort=recent\|name` | `project.list` | `[{ id, slug, name, repo, artifactCount, openCount, updatedAt }]`, only projects with something visible. |
| `GET /api/projects/:slug/artifacts?q=&status=all\|your_turn\|approved\|archived&sort=recent\|name` | `project.read` | `{ project: { slug, name, repo }, artifacts: [ArtifactCard] }` |
| `GET /api/artifacts/by-slug/:project/:slug` | `artifact.read` | `Artifact`. If deleted: 410 `gone` with only `details: { deletedAt }` for a caller who passes the visibility rule in 04 with `deleted_at` ignored, otherwise 404. |
| `GET /api/artifacts/:id` | `artifact.read` | Same. |
| `PATCH /api/artifacts/:id` | `artifact.manage` | `{ visibility? }` |
| `GET /api/search?q=` | `home.read` | ⌘K and the Search tab: `{ artifacts, pages, comments, content }`, 20 each, only what the caller can see, leaving out archived artifacts (SPEC §5.5). `content` is words in the work itself, on the latest version: `{ id, project, slug, title, source, pageKey, ref, snippet }`, with `source` one of `block`, `frame`, `summary`, `tag`, `note`. 60 a minute per caller, shared with `/api/library/search`. |
| `GET /api/activity?filter=all\|agents\|people&before=` | `home.read` | Activity rows the caller can see. |

`ArtifactCard` = `{ id, project, slug, title, cover: { renderHash } | { title }, pageCount, latestVersion, status: { kind: "waiting"|"with_agent"|"approved"|"not_reviewed", agent?, version? }, counts: { open, repliesToYou, changedFrames }, publishedBy, agent, publishedAt, archivedAt }`.

`Artifact` = the card plus `{ visibility, publisherId, hasBackend, pages: [{ key, kind, title, group, changed: bool, open: int }], decision: { kind, note, version, by, at } | null, permissions: { comment, decide, manage, share, delete, purge } }`. `decide` is whether the caller may approve, request changes or resolve threads (`artifact.decide`); a viewer can hide those buttons with it. Older servers omit it.

## The library (agents)

Compact, paged answers for agents, which the CLI's `search`, `list`, `read` and `view` and both MCP servers use. Each works without an `artifact.json`. `:project` and `:slug` are names, not ids. All of them start from the same `can()` filter as the lists above, so a hidden artifact can't reach a count, a snippet or a summary. No answer gives a total.

| Method, path | Action | Notes |
|---|---|---|
| `GET /api/library/search?q=&project=&repo=&archived=&limit=&cursor=` | `home.read` | `{ cards: [LibraryCard], nextCursor }`, the best match per artifact, on the latest version of what the caller can see. Searches titles, slugs, tags, summaries, page and frame titles, article text, version messages, names and notes, and comments. Every word must match, stemmed with Postgres's `english` configuration, and the last word is a prefix; titles, slugs, summaries and tags also match as substrings. Includes archived artifacts, with `outcome.archived` set, unless `archived=false`. 60 a minute per caller. |
| `GET /api/library/projects?repo=&limit=&cursor=` | `project.list` | `{ projects: [{ slug, name, repo, artifacts, updatedAt }], nextCursor }`, only projects with something visible. `repo` takes any form of a git remote. |
| `GET /api/library/projects/:project?limit=&cursor=` | `project.read` | `{ cards, nextCursor }`, newest first. 404 if nothing in it is visible. |
| `GET /api/library/projects/:project/:slug?limit=&cursor=` | `artifact.read` | `{ card, pages: [{ key, kind, title, group, frames, blocks }], nextCursor }`. |
| `GET /api/library/projects/:project/:slug/pages/:page?limit=&cursor=` | `artifact.read` | `{ page, frames: [{ key, board, title, device, note }], nextCursor }`. |
| `GET /api/library/projects/:project/:slug/read?page=&version=&cursor=&chars=` | `artifact.read` | `{ project, slug, title, version, items: [{ page, kind, ref, title, text }], nextCursor }`. Paged by characters, 8,000 by default and 32,000 at most, so the cursor can stop inside a long block. |
| `GET /api/library/projects/:project/:slug/view?page=&frame=&size=&version=` | `artifact.read` | `{ page, frame, title, size, image }`. `size` is `thumb` (the default), `1x` or `2x`. `image` is a path under this API, for `GET /api/artifacts/:id/r/:hash?via=app`. An artifact with no frames gives its OG image. |
| `GET /api/library/projects/:project/:slug/bundle?version=` | `artifact.read` | `VersionBundle`, for `artifacts pull` and `export`: `{ project, slug, version, manifest, rebuilt, files: [{ path, hash, size, type, url }] }`. `url` is a presigned GET on the bucket, which needs no token. `manifest` is the stored `artifact.json`, or, with `rebuilt: true`, a best guess for a version from before it was stored. |
| `GET /api/artifacts/:id/decisions` | `artifact.read` | `[{ version, kind, note, by, at }]`, newest first. |

`limit` defaults to 20 and stops at 50. Cursors are opaque.

`LibraryCard` = `{ project, slug, title, summary, tags, status, outcome: { decision, decisionVersion, openComments, archived }, latestVersion, updatedAt, match: { source, page, ref, snippet } | null }`. `status` is `ArtifactCard.status.kind`. `match.source` is `title`, `summary`, `tag`, `block`, `frame`, `page`, `note` or `comment`, and a snippet is at most 200 characters of plain text. `summary` falls back to the first block's text, then the version message, then frame titles, cut to 280 characters. A card is at most 1,800 characters of JSON, a test holds it there.

## Brand

| Method, path | Action | Notes |
|---|---|---|
| `GET /api/brand` | `brand.read` | `{ brand, fonts: [{ hash, url }] }`. `brand` is null for the default look; `url` is a presigned GET. |
| `DELETE /api/brand` | `brand.apply` | Back to the default look. |
| `GET /api/brand/proposals` | `brand.read` | The latest 50: `[{ id, name, brand, sample: { project, slug } \| null, proposedBy, agent, createdAt, appliedAt }]`. |
| `POST /api/brand/proposals` | `brand.propose` | `{ brand, project, slug, agent? }`, naming a published sample the caller may publish to. Each font's hash must be a file in its latest version → `{ id }`. Changes nothing until it's applied. |
| `POST /api/brand/proposals/:id/apply` | `brand.apply` (a person) | Copies it to `org.brand`. |

## Lifecycle: archive and delete

| Method, path | Action | Notes |
|---|---|---|
| `POST /api/artifacts/:id/archive` / `unarchive` | `artifact.archive` | |
| `POST /api/artifacts/:id/delete` | `artifact.delete` | Moves to Recently deleted; share links stop while it's there and work again if it's restored; `{ purgeAfter }`. |
| `POST /api/artifacts/:id/undelete` | `artifact.delete` | |
| `DELETE /api/artifacts/:id` | `artifact.purge` (a person, recent auth) | Purge now. Only from Recently deleted. |
| `GET /api/deleted` | `deleted.read` | Recently deleted artifacts and versions the caller deleted (admins: all). `[{ kind, artifact, version?, deletedBy, deletedAt, purgeAfter }]` |
| `POST /api/artifacts/:id/versions/:n/delete` / `undelete` | `artifact.delete` | Refused (409) for the latest or only version. |
| `DELETE /api/artifacts/:id/versions/:n` | `artifact.purge` | Purge one version now. |

Every write route below checks `archived_at` and answers 403 `read_only` for archived artifacts, except archive/unarchive, delete, data reads and exports.

## Sharing and access

| Method, path | Action | Notes |
|---|---|---|
| `GET /api/artifacts/:id/access` | `artifact.share` | People added and links. |
| `POST /api/artifacts/:id/access` | `artifact.share` | `{ email, permission }` with `permission` in `view`, `comment`, `publish`. Existing member: added directly. Otherwise creates an outside `artifact` invite: `{ url }`. `publish` is refused (400) for people outside the organization. Called with a token, the access or invite is marked `via_token`, so that person can comment but not decide or resolve; the same call by a person clears the mark (04). |
| `DELETE /api/artifacts/:id/access/:personId` | `artifact.share` | |
| `POST /api/artifacts/:id/links` | `artifact.share` (and `org.settings.linkSharing`) | `{ permission, expiresIn?: "1d"\|"7d"\|"30d"\|null }` → `{ link, url }` |
| `DELETE /api/artifacts/:id/links/:linkId` | `artifact.share` | Revoke; guests lose access at once. |

## Versions

| Method, path | Action | Notes |
|---|---|---|
| `GET /api/artifacts/:id/versions` | `artifact.read` | `[{ n, name, message, publishedBy, agent, publishedAt, restoredFrom, decision?, changes: { frames, blocks } }]` |
| `GET /api/artifacts/:id/versions/:n` | `artifact.read` | `{ n, pages: [Page], notes }`. `Page` for canvas: `{ key, kind, title, boards, frames: [{ key, board, title, device, x, y, w, h, contentHash, renders, live: bool, changed: bool }] }`; for article: `{ key, kind, title, htmlHash, outline, theme, blocks: [{ key, contentHash, changed }] }`, where `theme` is null or `{ accent?, font?, display?, radius? }` (05). |
| `PATCH /api/artifacts/:id/versions/:n` | `artifact.publish` | `{ name }` |
| `POST /api/artifacts/:id/versions/:n/restore` | `artifact.publish` | Publishes a copy as the next version (same `files`, `backend_hash`, frames, blocks), with `restored_from = n`; re-anchors threads; → `{ n }` |
| `GET /api/artifacts/:id/compare?from=&to=` | `artifact.read` | `{ frames: { added, removed, changed }, blocks: { added, removed, changed }, notes }`. `frames.regions` maps each changed frame (the first 40) to `{ before, after, regions }`: the two @2x render hashes and `[{ x, y, w, h }]` as 0–1 fractions, at most 12. |

## Files and renders (viewer port)

| Method, path | Action | Notes |
|---|---|---|
| `GET /api/artifacts/:id/r/:hash` | `artifact.read` | A render or embed image. Checks the hash belongs to one of the artifact's live versions, then 302 to a presigned GET URL. With `?via=app` (the service worker, 06) an `image/*` file up to 64 MB comes through the app instead, as an `attachment` with `nosniff`, never as a page; anything else still gets the 302. |
| `GET /api/artifacts/:id/v/:n/article/:pageKey` | `artifact.read` | The article's HTML as re-sanitized by the server at commit ([05](05-publish-and-storage.md#building-articles-cli)), fetched as text and never navigated to. Served as `Content-Type: text/plain; charset=utf-8` with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, so a browser opening the URL directly can never render it on the viewer's origin. |
| `GET /api/threads/:id/crop` | `artifact.read` | 302 to the crop. |

**Presigned GET URLs** are signed for 24 hours with the signing time rounded down to the UTC day, so the same object gets the same URL all day and phones keep their cached copy. Responses from the bucket for `blobs/` carry `Cache-Control: public, max-age=31536000, immutable` (set as object metadata at upload).

## Publishing (CLI)

| Method, path | Action | Notes |
|---|---|---|
| `POST /api/publish/prepare` | `artifact.publish` (or `project.create` for a new project/artifact) | Body below → `{ uploadId, artifactId, missing: [{ sha256, url, headers }] }`. Presigned PUTs valid 15 minutes. |
| `POST /api/publish/commit` | same | Body below → `PublishResult` |

```jsonc
// prepare
{ "project": "camerabuddy", "projectName": "Camera Buddy", "repo": "zahin-mohammad/camerabuddy",
  "slug": "roadmap", "title": "Camera Buddy roadmap", "visibility": "org",
  "files": [{ "path": "mocks/body-01-onboarding.html", "sha256": "…", "size": 18342, "type": "text/html" }] }

// commit
{ "uploadId": "…", "message": "Move MF above the strip", "name": null,
  "notes": { "live-view": "Moved MF above the strip" }, "agent": "Claude Code",
  "summary": "The plan, research and mocks for Camera Buddy.", "tags": ["roadmap"],
  "files": { "<path>": { "hash": "…", "size": 1, "type": "…" } },
  "backendHash": null,
  "pages": [ /* Page records as produced by render, see 05 */ ],
  "frames": [ /* frame records */ ], "blocks": [ /* block records */ ] }

// PublishResult
{ "version": 5, "url": "https://art.zahin.ca/camerabuddy/roadmap",
  "changes": { "frames": { "added": [], "removed": [], "changed": ["live-view"] }, "blocks": { "changed": ["phase-1"] } },
  "threadsOnChanged": [3, 4, 6, 8], "orphaned": [], "uploaded": { "files": 7, "bytes": 421888 }, "reused": 214 }
```

`commit` also takes `summary` (a string up to 280 characters) and `tags` (up to 8 strings up to 32 characters), both optional, so an older CLI still publishes; `manifest/summary` is what asks for one (07). `prepare` normalizes `repo` to `owner/name` and drops anything else, credentials included.

Commit checks: every path in `files` passes `isBundlePath` (400 `invalid`), every hash in `files` and every render hash is proved, either by a `blobs` row or by downloading the object, hashing it and comparing it with the declared hash and size (05, "Presigned URLs"; a mismatch deletes the object and answers 400 `invalid`), the artifact isn't archived or deleted (409 `slug_deleted` with details, or `conflict` for a caller who couldn't see it), and the caller may publish. It then creates the version, re-anchors threads, sets `latest_version`, writes activity, and returns. One commit at a time per artifact (Postgres advisory lock on the artifact id).

## Review

| Method, path | Action | Notes |
|---|---|---|
| `GET /api/artifacts/:id/threads?status=open\|fixed\|resolved\|all&page=&version=` | `artifact.read` | `[Thread]`, with comments. |
| `POST /api/artifacts/:id/threads` | `artifact.comment` | `{ pageKey, anchor, body, version }` → `Thread`. Canvas anchors trigger crop generation (05). A page key is up to 500 characters, a quote up to 10,000 and its prefix and suffix 500 each. |
| `POST /api/threads/:id/comments` | `artifact.comment` | `{ body, marksFixed?: bool, agent? }`. `agent` is the CLI's detected agent, kept only for CLI tokens. `marksFixed` is allowed for CLI tokens and the publisher: sets `status = fixed`, `fixed_version` = latest. A comment on a `fixed` thread by anyone but the fixer sets it back to `open`. |
| `POST /api/threads/:id/resolve` / `reopen` | `thread.resolve` (people only, never tokens) | |
| `PATCH /api/comments/:id` / `DELETE` | author only | Edit or delete your own comment within 24 hours. |
| `POST /api/artifacts/:id/decisions` | `artifact.decide` (people only) | `{ version, kind, note }` (note up to 10,000 characters) |
| `GET /api/artifacts/:id/status` | `artifact.read` | For `artifacts status`: `{ version, decision, decisionVersion, note, open: [Thread], fixedAwaiting: [Thread] }` |
| `POST /api/artifacts/:id/seen` | `artifact.read` | `{ version, pageKey?, position? }` updates `views` or `guest_views`. `version` is capped at the latest; a position is kept only for a page the artifact has, up to 2,000 characters. |

`Thread` = `{ id, n, pageKey, anchor, anchorState, status, createdVersion, fixedVersion, author: { name, kind: "person"|"guest"|"agent" }, crop: url|null, comments: [{ id, author, agent, body, version, marksFixed, createdAt }], createdAt, resolvedAt }`.

## Data store (frontends, through the viewer)

The viewer calls these on behalf of a live frame (protocol in [08-micro-apps.md](08-micro-apps.md#the-bridge)). `:scope` is `shared` or `me`. All writes refuse archived artifacts with 403 `read_only`.

| Method, path | Action | Notes |
|---|---|---|
| `GET /api/artifacts/:id/data/:scope?prefix=&cursor=` | `data.read` | `{ keys: [{ key, etag, size, updatedAt }], nextCursor }` |
| `GET /api/artifacts/:id/data/:scope/:key` | `data.read` | `{ value, etag }`; 404 if absent. |
| `PUT /api/artifacts/:id/data/:scope/:key` | `data.write` | Body `{ value }`; headers `If-Match: <etag>` or `If-None-Match: *` → `{ etag }`; 412 on mismatch; 413 over limits. |
| `DELETE /api/artifacts/:id/data/:scope/:key` | `data.write` | Optional `If-Match`. |
| `GET /api/artifacts/:id/files/:scope` | `data.read` | List. |
| `PUT /api/artifacts/:id/files/:scope/:name` | `data.write` | Raw body with `Content-Type`; 10 MB default limit → `{ name, etag, size }` |
| `GET /api/artifacts/:id/files/:scope/:name` | `data.read` | 302 to a presigned GET with `response-content-type` and, for non-media types, `response-content-disposition=attachment`. SVG always downloads, because it can carry script. With `Accept: application/json`, `{ url }` instead, for the bridge. |
| `DELETE /api/artifacts/:id/files/:scope/:name` | `data.write` | |
| `GET /api/artifacts/:id/data-export` | `data.export` (publisher, admins) | `{ shared: {…}, me: { "<id>": { name, data: {…} } }, files: [{ scope, owner, name, url }] }` |
| `POST /api/artifacts/:id/data-clear` | `data.export` | `{ scope?: "shared"\|"me" }` |
| `GET /api/artifacts/:id/logs?version=&after=` | `data.export` | The backend's console output for the last 24 hours: `[{ id, version, level, message, requestId, createdAt }]`, oldest first. `after` is a log id, for `--follow`. |

`me` resolves to the caller's per-artifact pseudonym (a person or a share-link guest; see [08](08-micro-apps.md#request-flow)). Guests on a view-only link can read but not write.

## Content host (Live previews)

| Method, path | Notes |
|---|---|
| `POST /api/artifacts/:id/content-token` (viewer port) | Action `artifact.read`. `{ version }` → `{ base: "<CONTENT_URL>/t/<token>/v5/", expiresAt }`. Token format in 04. |
| `GET /t/:token/v:n/*` (content port) | Serves bundle files of version n by path: reads the blob (cached in memory by hash, LRU 64 MB) and returns it with its type. A file over 8 MB isn't loaded whole when a `Range` is asked for: the app reads only that range from the bucket, and an open-ended range (`bytes=0-`) gets one 8 MB piece as a 206, which the browser follows up. Checks: valid token for this artifact and version; `Sec-Fetch-Dest` is `iframe` (or `empty`/`script`/`style`/`image`/`font` for sub-resources, and `audio`/`video`/`track` for media), never `document`, so it can't be opened as a top-level page. Spike S8 confirmed WebKit sends these values ([spikes.md](spikes.md#s8--live-frames-in-webkit)). |
| `ANY /t/:token/v:n/api/*` (content port, Phase 2) | Runs that version's backend in the sandbox ([08](08-micro-apps.md#request-flow)). Rate-limited per caller (04); bodies over `backendRequestBytes` get 413. `Access-Control-Allow-Origin: *`, no credentials, `OPTIONS` preflight answered. 404 if the version has no backend. |

**Access is re-checked on every content-port request,** not just when the token is minted. The token proves who the caller is; it doesn't grant access on its own. On each request the app checks, with a cache of at most 5 seconds:
- the artifact isn't deleted (archived is fine for reads; `api/` writes are then read-only)
- the version isn't removed
- the caller still has access: a person not removed and still able to see it, or a guest whose share link isn't revoked or expired

That's what makes "links stop at once" (SPEC §5.5) and "revoking a link cuts guests off" (SPEC §7.3) true for frames that are already open.

Live frames run in an iframe with only `allow-scripts`, so their document has an **opaque origin**. Every load from it is cross-origin, including its own module scripts, fonts and relative `fetch`. So:

Content-port responses always carry:
- `Access-Control-Allow-Origin: *` on **every** response, with no credentials. The path token is the permission.
- `Content-Security-Policy: default-src <CONTENT_URL>; script-src <CONTENT_URL> 'unsafe-inline'; style-src <CONTENT_URL> 'unsafe-inline'; font-src <CONTENT_URL>; img-src <CONTENT_URL> data: blob: <bucket origin>; media-src <CONTENT_URL> blob: <bucket origin>; connect-src <CONTENT_URL>; frame-ancestors <viewer origins>; base-uri 'none'; form-action 'none'; sandbox allow-scripts`. The content origin is named explicitly because `'self'` doesn't match for an opaque-origin document: in spike S8, WebKit refused the frame's own `fetch` under `connect-src 'self'`. With the origin named, module scripts, fonts, images, relative `fetch` and preflighted `api/` calls all worked.
- `Referrer-Policy: no-referrer`
- `X-Content-Type-Options: nosniff`

The CSP's `sandbox allow-scripts` forces an opaque origin on any document from the content host, however it was opened. So even if a page were opened at the top level, it couldn't register a service worker or read anything stored for the content origin. **Requests without `Sec-Fetch-Dest` are refused** (fail closed): every browser the viewer supports sends it (spike S8 for WebKit).

## Internal API (private network)

| Method, path | Caller | Notes |
|---|---|---|
| `POST /internal/jobs/:name` | `Authorization: Bearer <OPS_SECRET>` (operators and tests) | Run a job now: `purge`, `gc`, `expire`, `usage`, `digest` ([05](05-publish-and-storage.md#clean-up)) |

Backends don't use the internal API: they run in sandbox processes that talk to the app over IPC ([08](08-micro-apps.md#backends-the-sandbox-appsserversrcsandbox)).

## OAuth and the hosted MCP

Both are on viewer origins only, never the Live-preview origin. Issuer, resource and audience are the origin the client used, so each domain in `MORE_URLS` describes itself. Built against MCP revision `2026-07-28` (checked 2026-11-01).

| Method, path | Auth | Notes |
|---|---|---|
| `GET /.well-known/oauth-protected-resource/api/mcp`, `GET /.well-known/oauth-protected-resource` | none | RFC 9728: `{ resource, authorization_servers, scopes_supported, bearer_methods_supported }`. |
| `GET /.well-known/oauth-authorization-server` | none | RFC 8414, with `code_challenge_methods_supported: ["S256"]`, `client_id_metadata_document_supported`, and `authorization_response_iss_parameter_supported`. |
| `GET /api/oauth/authorize` | none | Checks `client_id` and `redirect_uri` first and answers 400 if they fail, without redirecting. Other failures redirect back with `error` and `iss`. A good request goes to the viewer's `/device/connect`. Needs `response_type=code`, S256 PKCE, and `resource` equal to this origin's MCP endpoint. 60 per IP per 15 minutes. |
| `GET /api/oauth/consent?<the same query>` | session | What the consent screen shows: `{ client, clientId, redirectHost, local, scopes, resource }`. |
| `POST /api/oauth/consent` | session, and a recent sign-in to approve | `{ approve, request }`. Checks `request` again → `{ redirect }`, with `code`, `state` and `iss`, or `error=access_denied`. |
| `POST /api/oauth/token` | none, form-encoded | `authorization_code` or `refresh_token`, for public clients. Access tokens last an hour; refresh tokens rotate. A code or refresh token used twice revokes the grant. Errors are RFC 6749's. 120 per IP per 15 minutes. |
| `POST /api/oauth/revoke` | none, form-encoded | RFC 7009: `{ token }`. Revoking a refresh token ends the grant. Always 200. |
| `POST /api/oauth/register` | none | RFC 7591, deprecated by MCP and kept for clients that need it. Public clients only; redirects must be https, or http on loopback. 20 per IP per hour. |
| `POST /api/mcp` | Bearer | Streamable HTTP, JSON responses, no sessions. An access token or a CLI or organization token. Up to 4 MB. An `Origin` that isn't a viewer origin gets 403, even with a good token. No valid token: 401 with `WWW-Authenticate` pointing at the metadata. Too little scope: 403 with `error="insufficient_scope"`. |
| `GET`, `DELETE /api/mcp` | | 405. |

**Protocol.** `2026-07-28` requests (`_meta` version, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) and the older handshake (`initialize`, for `2025-11-25`, `2025-06-18` and `2025-03-26`) both work. Headers that disagree with the body get 400 with `-32020`, an unknown version 400 with `-32022`, and an unknown method 404 with `-32601`. Methods: `server/discover`, `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`.

**Tools:** `artifacts_search`, `_list`, `_read`, `_view`, `_status`, `_comments`, `_reply`, `_versions`, `_publish_article`, `_publish_prepare` and `_publish_commit`, each a call to the same server functions as the routes above. They need `read`, except `_reply` (`comment`) and publishing (`publish`). Answers that can hold other people's text start with a block saying it's data, and each comment carries `untrusted: true` and `authorKind`. **Resources:** `artifacts://guides/<name>` and `artifacts://templates/<name>/<path>`.

**Publishing.** The client renders; the server runs no browser. `artifacts_publish_prepare` takes the fields `artifacts pack` prints, including `payload: { sha256, size }`. If the payload isn't in the bucket yet it answers `{ step: "upload_payload", plan }`; call it again after uploading, and it reads the payload (`PublishCommit` without `uploadId`, plus `declared`, the file list) and answers `{ step: "upload_files", uploadId, missing, plan }`. `plan` is a presigned GET of a JSON file of signed PUTs, so a long list never passes through a model. `artifacts_publish_commit` takes `{ uploadId, payload }`. The ticket is bound to that payload hash, the payload is proved by hash like any other blob, and the commit is the same code and checks as `POST /api/publish/commit`.

**Articles with no CLI.** `artifacts_publish_article` takes `{ project, slug, title, summary, markdown, tags?, message?, repo? }`: `summary` is required here, `markdown` is at most 1 MB, and 30 a minute per token. The server builds the article with the CLI's own pipeline, and it goes through the same prepare and commit, so the same sanitizer and checks apply. It's for articles with text only: a local image, Mermaid, `::chart` or `::frame` is refused, and a remote image is dropped by the allowlist as usual. Images need `artifacts pack`. The artifact has one page, `doc`, and the tool won't replace an artifact with any other page. `artifact.json` and `doc.md` are stored, so `artifacts pull` works.

## Realtime and push (Phase 2)

| Method, path | Notes |
|---|---|
| `GET /api/events?artifact=<id>` | `artifact.read`. Server-sent events: `thread`, `comment`, `version`, `decision`, `data` (`{ scope, key, etag }`, `shared` only). They say something changed and hold no content. Fan-out across replicas with Postgres `LISTEN/NOTIFY`. A stream closes after 5 minutes and the browser reconnects, which rechecks access. 10 streams per caller. |
| `POST /api/push/subscribe` | `{ endpoint, keys }`; `GET /api/push/key` → `{ key }`, the VAPID public key. Only the HTTPS endpoints of Apple's, Google's, Mozilla's and Microsoft's push services are accepted, because the server POSTs to them. `keys.p256dh` must be an uncompressed P-256 point (65 bytes) and `keys.auth` 16 bytes, base64url. 10 devices per person; ended sessions' devices are removed daily. |
| `DELETE /api/push/subscribe` | `{ endpoint }` |
