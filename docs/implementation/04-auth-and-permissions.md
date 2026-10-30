# 04 · Sign-in, callers and permissions

**Contract document.** This file owns the caller types, cookie and token formats, token scopes, the permission actions and their matrix. Behaviour comes from SPEC §7.3, §7.4 and §5.5.

## Callers

Every request resolves to exactly one caller before any route code runs (`apps/server/src/auth/resolve.ts`):

| Caller | How it's recognised | Acts as |
|---|---|---|
| `person` | `art_session` cookie → `sessions.token_hash` (not expired; person not removed) | That person, with `recentAuth = now - auth_at < 10 min` |
| `cliToken` | `Authorization: Bearer art_…` → `tokens` where `kind = cli` | The token's person, limited to the token's scopes; never `recentAuth` |
| `orgToken` | Same header, `kind = org` | The organization, limited to scopes and `project_ids` |
| `guest` | `art_guest` cookie → `guests`, plus the share link being used (from the route's artifact and the guest's `guest_links`) | A named guest with the link's permission on that one artifact |
| `content` | Path token on the content port | The caller recorded in the token, for one artifact version |
| `anonymous` | Nothing | Only public routes (health, meta, sign-in, invites, share-link preview) |

Precedence when several are present: Bearer token, then session cookie, then guest cookie. A request with both a session and a guest cookie is the person.

## Secrets and formats

- **Session cookie** `art_session`: 32 random bytes, base64url. `HttpOnly; Secure; SameSite=Lax; Path=/` (`Secure` is left off only on a plain-http viewer origin, where browsers would drop the cookie: local Compose, dev and e2e), host-only on the viewer domain that set it, `Max-Age` 30 days, refreshed when `last_seen_at` is more than a day old.
- **Guest cookie** `art_guest`: same format and flags, `Max-Age` 90 days.
- **Tokens** (`art_` + base32 of 32 bytes), **invite**, **reset** and **share link** secrets (32 bytes base64url), and **device codes**: stored as SHA-256 hex. Compared by hash lookup, which avoids timing leaks.
- **`SETUP_TOKEN`**: compared with `crypto.timingSafeEqual` on equal-length buffers.
- **Content tokens** (path capability, SPEC §7.3):
  - **Format:** `base64url(payload).base64url(HMAC-SHA256(key, payload))`, with key = HKDF(`SESSION_SECRET`, info `"content"`).
  - **Payload:** `{ a: artifactId, v: version, c: { kind: "person"|"guest", id, name, canComment, isPublisher }, exp }`.
  - **Lifetime:** 2 hours. The viewer mints a new one when it reloads a frame.
  - **Not a grant on its own:** every content-port request re-checks that the artifact and version are live and that the caller still has access (cached at most 5 seconds; [03](03-api.md#content-host-live-previews)). Deleting an artifact, removing a person or revoking a link stops open frames within seconds.
  - **Scope:** only valid on `/t/<token>/v<v>/` for that artifact.
- **`OPS_SECRET`**: a template-generated random string on the app only, for `/internal/jobs/*`.
- **Backend sandboxes** hold no secrets: they run in child processes with an empty environment, and their `env.DATA` calls are scoped by the app to the request in flight ([08](08-micro-apps.md#backends-the-sandbox-appsserversrcsandbox)).
- **Rotating `SESSION_SECRET`** signs everyone out and invalidates open content tokens, and nothing else. Caller pseudonyms use `org.pseudonym_key` (02).

## Passwords

- argon2id with `Bun.password.hash(password, { algorithm: "argon2id" })`. Bun's defaults are 64 MiB of memory and 2 passes.
- At least 12 characters and at most 256. No other composition rules.
- Rate limits, kept in memory per process:
  - 5 failures per account per 15 minutes, then 1 attempt per minute, doubling to a 1-hour cap
  - 30 attempts per IP per 15 minutes
- Changing or resetting a password ends every other session of that person, and every reset link of theirs that is still unused.

## Passkeys (WebAuthn)

Libraries: `@simplewebauthn/server` and `@simplewebauthn/browser`.

- **RP ID:** `org.home_domain` by default.
- **Expected origins:** every viewer origin (home, `PUBLIC_URL`, `MORE_URLS`).
- **Expected RP IDs on verification:** the home domain plus every other viewer hostname, so passkeys made without Related Origin Requests on another domain still verify. Each passkey stores its `rp_id`.
- **Related Origin Requests** (SPEC §7.3):
  - The home domain serves `/.well-known/webauthn` listing the other viewer origins.
  - The server refuses to start if `CONTENT_URL`'s host is a viewer host or would be listed.
  - At startup it logs a warning if `CONTENT_URL` and a viewer domain share a registrable domain, because they'd be the same site.
- **Browser capability:** the viewer calls `PublicKeyCredential.getClientCapabilities?.()`. If `relatedOrigins` is false or missing and the page isn't on the home domain:
  - Sign-in shows "Sign in on <home domain>", which opens the home domain.
  - Registration offers to create the passkey for the current domain instead.
- **Discoverable credentials** (`residentKey: "required"`), so sign-in needs no email first.
- **User verification is required** (`userVerification: "required"` in options, and `requireUserVerification: true` when verifying, for registration and sign-in). A passkey can be someone's only credential, so it has to prove the person and not just the device.
- **Challenges** live in `webauthn_challenges` for 5 minutes and are single use.

## Sessions and "recent sign-in"

- A session is created by password, passkey, invite acceptance, reset, or setup. Each sets `auth_at = now`.
- These actions need `recentAuth`: adding or removing a passkey, changing a password, creating an org token, purging (artifact or version), and approving a device code. The API answers 401 `recent_auth_required`. The viewer then shows a re-auth sheet (passkey or password → `POST /api/auth/reauth`) and retries.
- Sessions are per domain (host-only cookies), so another viewer domain means signing in again.

## Setup mode

- **When:** while `org` has no row, the server is in setup mode.
  - `GET /api/health` reports `setupMode: true`.
  - The viewer SPA shows only the "Almost ready" page (board 6, screen 1).
  - Every `/api/*` route except health, meta and setup answers 503 `setup_mode`.
- **`POST /api/setup`:**
  1. Checks `SETUP_TOKEN`.
  2. In one transaction, creates `org` (with `home_domain` = request host), the owner, their password and a CLI token.
  3. Leaves setup mode.

  It answers 409 once an owner exists, before it looks at the token, so it can't be used to test guesses; in setup mode, wrong tokens are limited to 20 per IP per hour.
- **`POST /api/recover`:** with a valid `SETUP_TOKEN`, issues a one-hour reset link for an existing owner. It's written to activity as `recovered`.

## Device flow (`artifacts login` and `artifacts setup <url>` for teammates)

1. **The CLI starts it:** `POST /api/device/start` → prints `userCode` and opens `verificationUrl`.
2. **The person approves in the browser:** they sign in if needed, see the client name, agent and code (board 6, screen 7), and approve with a recent sign-in.
3. **The CLI collects the token:** it polls `POST /api/device/poll` every `interval` seconds, and on `approved` stores the token in the OS keychain ([07-cli-and-skill.md](07-cli-and-skill.md#credentials)).
4. **Expiry:** codes expire after 10 minutes and work once.

## Token scopes

| Scope | Allows |
|---|---|
| `publish` | `publish/*`, version names, restore |
| `comment` | Read threads, comment, reply, mark fixed |
| `read` | Read artifacts, versions, status, data export (publisher only) |
| `manage` | Visibility, sharing, archive/unarchive, delete/undelete (never purge) |
| `data` | `artifacts data` commands, `artifacts logs` |
| `org` | Org-token only: create projects |

- **CLI tokens** from the device flow or setup get `publish comment read manage data`.
- **Org tokens:** the admin picks scopes and projects.
- **What no token can do:** resolve threads, decide (approve or request changes), purge, change roles or remove people, manage org settings, or approve devices. An admin's CLI token can print invite and reset links (`people.invite`), because the CLI is how SPEC §10 says that's done. Those are people-only actions (SPEC §5.5, §6). A token must not mint itself a browser session, which can do what no token may, so it can invite only members and reviewers (and get a fresh link for one of those), and can't issue a reset link for an admin, an owner or itself. Those come from the viewer.

## The permission function

One function decides everything: `can(caller, action, resource) → boolean`, in `apps/server/src/auth/can.ts`. Every route calls it, and so does minting content tokens and scoping backend `env.DATA` calls. It never throws, and it logs denials at debug level with the reason.

The resource is an artifact (with its project, visibility, publisher, `archived_at`, `deleted_at`, access list and links), a thread, a person, or the org.

### Visibility first

Can the caller see an artifact at all (`artifact.read`)?

| Caller | Can see when |
|---|---|
| owner, admin | Always, including `me` artifacts (admins manage the deployment) |
| member, reviewer | `visibility = org`, **or** they published it, **or** they're in `artifact_access` |
| outside | They're in `artifact_access` |
| guest | Their `guest_links` row for a link on this artifact is unexpired and the link isn't revoked or expired |
| cliToken | As its person, and the token has `read` |
| orgToken | `visibility = org` and the project is in its `project_ids` (or all), and it has `read` |
| content | The token's artifact and version |

Someone in `artifact_access` with `view` can only view, whatever their role: on a `me` artifact, a member added with `view` can't comment.

Deleted artifacts (`deleted_at` set) are invisible to everyone except in `GET /api/deleted` and undelete/purge, for their deleter and admins. The only other trace is for a caller who passes the table above with `deleted_at` ignored: they get 410 `gone` on its page and `slug_deleted` on its slug (03). Everyone else gets 404 and plain `conflict`, as if it had never existed.

### Actions

| Action | Who (after visibility) |
|---|---|
| `account.read` | Any person caller: a session or a CLI token |
| `account.manage` | A person in a browser session, never a token: their sessions, password, passkeys, approving devices |
| `home.read`, `project.list`, `project.read` | Any person caller; tokens with `read` |
| `artifact.read` | Visibility rule above |
| `artifact.comment` | owner, admin, member, reviewer; outside and guests with `comment` permission; cliToken with `comment`. Not on archived artifacts. |
| `thread.resolve`, `artifact.decide` | People only (not guests, not tokens) who can comment |
| `artifact.publish` | The publisher, admins, owner; members the publisher or an admin added with `publish` in `artifact_access`; cliToken (`publish`) as its person, when that person may publish; orgToken (`publish`, project allowed). Reviewers and outside people never. Not on archived artifacts. Publishing a backend can read every person's `me` data, which is why this isn't open to every member. |
| `project.create` | Members and up; tokens with `publish` (cli) or `org` (org token) |
| `artifact.manage`, `artifact.share` | The publisher, admins, owner; cliToken with `manage` as the publisher. `share` also requires `org.settings.linkSharing` for links. Only these callers can add someone with `publish`, and only organization members can receive it. |
| `artifact.archive`, `artifact.delete` | Same as `manage` (archive and delete are undoable) |
| `artifact.purge` | The publisher or an admin, as a **person** with `recentAuth`. Never a token. |
| `deleted.read` | People, and cliTokens with `manage`: their own deletions; admins: all. Agents can undelete, so they need to find what they deleted. |
| `data.read` | Anyone with `artifact.read` (for `me`, only their own key space) |
| `data.write` | Anyone with `artifact.comment`, on their own `me` space or `shared`. Not on archived artifacts. A backend's `env.DATA` writes follow the same rule for the caller of that request: read-only for viewers and on archived artifacts (08). |
| `data.export` | The publisher and admins (people or cliToken with `data`) |
| `org.read` | Admins, owner |
| `org.manage`, `people.manage`, `tokens.manage` | Admins, owner (people only) |
| `people.read` | Admins, owner; an admin's cliToken with `read` |
| `people.invite` | Admins, owner; an admin's cliToken with `manage`. `artifacts org invite` and `org reset-link` need this (SPEC §10). |

### Test matrix

`apps/server/test/permissions.test.ts` generates every combination of:
- caller: owner, admin, member (publisher), member (added with `publish`), member (other), reviewer, outside (added), outside (not added), guest (view link), guest (comment link), guest (revoked link), cliToken (publisher), orgToken (allowed project), orgToken (other project), anonymous
- visibility: `me`, `org`
- lifecycle: active, archived, deleted
- every action in the table above

The expected result is computed from a second, deliberately simple table in the test, not from `can()`. A mismatch fails the test, so a regression shows up as a matrix diff.

## CSRF, hosts and headers

- **CSRF:** non-GET requests carrying a session or guest cookie must have `Origin` ∈ viewer origins, and any non-GET request with a foreign `Origin` is refused, which stops forged sign-ins too. Requests with `Authorization: Bearer …` are exempt, since they carry no cookies and the server ignores cookies for them. Any other `Authorization` header gets no exemption.
- **Host routing:** the viewer port accepts only viewer hosts, except `GET /api/health`; the content port serves `/t/` only on the content host (03).
- **Viewer response headers:**
  - `Content-Security-Policy: default-src 'self'; frame-src <CONTENT_URL>; img-src 'self' data: blob: <bucket origin>; connect-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`
  - `Strict-Transport-Security: max-age=31536000`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: same-origin`
  - `X-Content-Type-Options: nosniff`
- **The live preview iframe:** `sandbox="allow-scripts"` (never `allow-same-origin`), `allow="fullscreen"`, `referrerpolicy="no-referrer"`.

## Rate limits (in memory, per process)

| What | Limit |
|---|---|
| Password sign-in | Per account and per IP, above |
| `POST /api/device/start` | 10 per IP per hour |
| `POST /api/device/poll` | 1 per `interval` per code |
| `POST /api/s/:token/guest` | 20 per IP per hour |
| Comments | 30 per caller per minute |
| Data writes | `org.settings.limits.writesPerSecond` (default 10) per caller per artifact |
| Backend requests (`/t/…/api/*`) | `org.settings.limits.backendRequestsPerMinute` (default 120) per caller per artifact |
| `POST /api/recover` | 5 per IP per hour |
| `POST /api/setup` | 20 per IP per hour, while in setup mode |

With more than one replica, limits are per replica. That's acceptable for a self-hosted deployment.
