# Artifacts: scope, requirements and architecture

Status: ready to build, 2026-10-29. Nothing is built yet. Phase 0 (direction and mocks) is done; build from Phase 1.

How to use this: this spec says **what** Artifacts does and **why**. The guides in [`implementation/`](implementation/README.md) say **how** to build it: the exact data model, API, permission rules, message formats and build order. Where they disagree, this spec wins on behaviour and the implementation contracts win on names and shapes. The handoff prompt for the building agent is [`implementation/HANDOFF.md`](implementation/HANDOFF.md).

## 1. Why

In the CameraBuddy roadmap thread, an agent wrote a plan, seven research reports and 26 mock screens. It then built a temporary Figma-style canvas so you could pan the mocks and drop comment pins from your phone. You'd say "address the comments", and the agent read the pins, fixed the mocks and replied. That loop worked well, but everything around it was one-off:

| What went wrong in the thread | What it tells us |
|---|---|
| The site lived on a Mac over Tailscale, and was gone whenever the Mac slept | Artifacts need permanent hosting |
| Safari upgraded `http://` to `https://`, so the site looked "offline" | HTTPS only, on a stable domain |
| Photos went missing on the phone over 5G, and `no-store` re-downloaded about 2.2 MB on every reload | Immutable, content-addressed files, cached forever, with image size budgets |
| The canvas looked different mid-pan, and 26 live HTML screens strained iPhone memory | The canvas should show pre-rendered images and load live HTML only when asked |
| The viewer's own panel overlapped its toolbar, and mock CSS was inlined into the viewer page | Keep artifact content isolated from the viewer UI |
| Copying a page to `/tmp` broke its relative image paths | Bundles must be self-contained, and publishing checks that |
| The agent wrote its own overlap and clipping checker and found about 30 issues in 26 screens | Make that checker a standard lint step before every publish |
| Comments were stored as pixel positions in one JSON file | Comments need stable anchors and must survive new versions |
| Research reports were Markdown files you couldn't comment on | Articles are a first-class format, with comments on any paragraph |

**Goal:** one system that any project's agent can publish to with a single command. The result is a permanent, good-looking link that works well on your phone and your desktop, and the review loop (comment → agent fixes → republish → reply) is built in.

## 2. Goals and non-goals

### Goals
1. **Publish from anywhere.** Claude Code, Codex or a script in any repo publishes with one CLI command and gets back a stable URL.
2. **Always available.** Published versions are immutable and never expire by default. Links never break.
3. **Mobile first, desktop great.** Every view is designed for a one-handed iPhone on cellular first, then scaled up to desktop with keyboard and trackpad.
4. **Several ways to read content** behind one manifest:
   - canvas (Figma style)
   - article
   - prototype
   - gallery
   - deck (later)
5. **Review is the core feature.** Anchored comments, threads, resolve, version-aware pins, and an agent API to read comments and reply to them.
6. **Looks stunning by default.** A shared design kit (device frames, article typography, components) means an agent's first draft already looks polished. Each project can theme it.
7. **Quality gates.** Lint, render and size budgets run before anything is published.
8. **People and teams.** Each deployment is one organization. A publisher is a person or the organization: artifacts are private to their publisher or visible to the whole organization, depending on an organization setting, and any single artifact can be shared with people outside.
9. **Micro apps when needed.** An artifact can be just pages, or a small app: a frontend, an optional backend that ships in the same bundle, and an optional data folder (§7.9). Most artifacts use none of the extras.

### Non-goals (for now)
- Editing in the browser. Agents and repos are where content is written; the viewer is for reading and reviewing.
- Real-time co-editing, or a Figma replacement.
- A hosted, multi-tenant service, for now. Artifacts is open source that each team deploys for itself: one click from the Railway template, or Docker Compose anywhere (§14, [hosting evaluation](hosting-evaluation.md)).
- Sign-in through outside providers (Google, GitHub, SSO). Accounts use email with a password or a passkey, so a deploy needs no OAuth app. Our server does issue OAuth tokens itself, for connectors (§10.4), on that same sign-in.
- Sending email. Invite, reset and share links are copied and sent by hand, so a deploy needs no email provider.
- Long-running servers, background jobs and SQL databases for artifacts. An artifact's backend answers requests and stops (§7.9).

## 3. Concepts

```
Organization          mochahub                 one per deployment; created by `artifacts setup`
├─ People             zahin@… (owner) …        email + password and/or passkeys; roles
└─ Project            camerabuddy              usually one per repo
   └─ Artifact        roadmap                  one URL, one manifest, versioned
      ├─ Version      v1 … vN                  immutable snapshot: pages + optional backend code
      ├─ Data         data/<artifact id>/      optional folder of JSON values and files, shared by all versions
      └─ Page         plan · research/01 · mocks
         └─ Anchor    frame "live-view" · block "h-phase-0" · quote
            └─ Thread → comments, replies, status
```

- **Artifact** is the unit you share and review. The CameraBuddy roadmap becomes one artifact with these pages:
  - the plan (an article)
  - seven research reports (articles, grouped under "Research")
  - the mocks (a canvas with four boards)
- **Page kinds:**

| Kind | Source | What it looks like | MVP? |
|---|---|---|---|
| `canvas` | HTML boards with frames marked `data-frame` | Infinite pan/zoom board, frames shown as rendered images, comment pins | ✅ |
| `article` | Markdown (GFM + extensions) | Long-form reading view, outline, comments on paragraphs and selections | ✅ |
| `prototype` | One HTML entry point plus assets | Full-screen live page in a device frame; hotspots can link frames | Phase 2 |
| `gallery` | Images or video plus captions | Grid that opens into a swipeable lightbox | Phase 2 |
| `deck` | Markdown split by `---` | Slides you swipe through, with presenter mode | Phase 3 |

- **Embeds across kinds:** an article can embed a canvas frame (`::frame{ref="mocks/onboarding/welcome"}`), a chart or a Mermaid diagram. Tapping an embed opens it in its own page.

## 4. Authoring contract

### 4.1 Manifest (`artifact.json`, kept next to the source)

The server holds what's published, so source doesn't have to be in git. `artifacts init` writes to `.artifacts/work/<slug>/`, which git ignores; `--in-repo` writes to the current folder, to commit it. `artifacts pull` restores a working folder from any version, and `artifacts export` writes out a whole project.

```jsonc
{
  "project": "camerabuddy",
  "slug": "roadmap",
  "visibility": "org",           // "me" or "org"; optional, otherwise the organization default (§7.3)
  "title": "Camera Buddy roadmap",
  "summary": "The plan, research and mocks. Wi-Fi pairing won over Bluetooth.",   // required by lint, up to 280 characters
  "tags": ["roadmap", "camera"],  // optional: up to 8, up to 32 characters each
  "theme": { "accent": "#ff9f0a", "font": "inter", "mode": "auto" },
  "backend": { "src": "api/index.ts" },   // optional: request handlers shipped with the bundle (§7.9)
  "pages": [
    { "id": "plan", "kind": "article", "src": "README.md" },
    { "id": "research-01", "kind": "article", "src": "research/01-wifi-camera-remote-api.md", "group": "Research" },
    { "id": "mocks", "kind": "canvas", "boards": [
      { "id": "onboarding", "title": "Onboarding", "subtitle": "First run…", "src": "mocks/body-01-onboarding.html" }
    ], "styles": ["mocks/mock.css"], "scripts": ["mocks/img/photos.js", "mocks/mock.js"] }
  ]
}
```

`summary` and `tags` are an artifact's frontmatter: what a later agent reads instead of the whole document (§10.3). Versions from before they existed stay valid, and show their first text instead.

### 4.2 Canvas rules
- Every screen is an element with a **stable** `data-frame="live-view"` id and `data-device="iphone|ipad|watch|mac|browser|none"`. Comments attach to these ids, so renaming one orphans its comments, and lint warns about it.
- Rendering must be deterministic: seeded randomness only, and no `Date.now()` in what's drawn.
- No network access at render time. Fonts and images ship in the bundle, and all paths are relative.
- Live frames that need to remember things use the kit's data API (§7.9), never `localStorage` or their own server. Renders use the bundle's fixtures (`fixtures/data.json` and `fixtures/files/`).

### 4.3 Article rules
- GFM plus these extensions:
  - callouts (`> [!NOTE]`)
  - figures with captions
  - Mermaid
  - `::frame` and `::chart` embeds
  - verdict badges (`{Verified}`, `{Unverified}`), since the research docs already use that convention
- Every block gets a stable id: its heading slug, or its position under that heading. The block's content hash is stored in a separate field, so edits don't change the id. When re-anchoring, the text quote is the fallback (§6).

## 5. Viewer requirements

### 5.1 Shared shell (all kinds)
- **Navigation:** artifact title, page switcher (a bottom sheet on phones, a sidebar on desktop), version picker, and a "what changed" note.
  - On phones the viewer is a page in Safari. Its tab bar (Review, Projects, Activity, Search) sits just above Safari's bar.
- **An artifact is one link with pages inside.** The roadmap is one artifact; its plan, research articles and mock boards are its pages. One publish versions all of them together, and each page has its own link.
- **Status nobody has to set.** Each artifact shows whose turn it is, worked out from the review: **Waiting on you** (a new version, or a reply, since your last decision), **With Claude** (you asked for changes and the agent hasn't published since), **Approved vN**, or **Not reviewed yet**.
- **Projects:** search, sort (recent activity or name) and filter by status.
- **Light and dark mode:** follows the system, with an override switch.
- **Marks:** yellow is a person's (pins, highlights, open counts); violet is an agent's (new versions, replies, changed frames and paragraphs). Labels are coloured words, not tinted pills; only counts get a filled badge. Agents sign with initials in a violet square, never a sparkle icon, and nothing uses a coloured bar down a card's edge.
- **Home and Activity:** Home lists the artifacts waiting on you (a new version since you last looked, or replies to you). Activity is a feed of publishes, comments and decisions across projects, which you can filter to agents or people.
- **Installable:** a PWA you can add to the Home Screen. A service worker caches the versions you've viewed, so they open offline.
- **Links:**
  - `/<project>/<artifact>` always shows the latest version
  - `/v/3` pins a version
  - `#frame=live-view` and `?c=<commentId>` deep-link to a frame or comment
  - every link has an Open Graph preview image made from the rendered frames, so links unfurl in iMessage and Slack
- **Performance budgets:**
  - Viewer JS ≤ 80 KB gzipped.
  - First meaningful paint on mid-range 4G ≤ 1.5 s.
  - No page download over 3 MB on cellular before the user zooms in.

### 5.2 Canvas
- **Gestures:**
  - one-finger pan, pinch to zoom, double-tap to fit a frame, inertia
  - on desktop: scroll to pan, ⌘-scroll or pinch to zoom
  - shortcuts: V (move), C (comment), 0 (fit all), 1 (100%), N and P (next and previous frame), Esc
- **Level of detail:**
  - Zoomed out, frames are rendered images: a thumbnail first, then @2x or @3x as you zoom in.
  - **Try it** swaps one frame for its live HTML in a sandboxed iframe, so you can scroll and tap a prototype. **Done** puts the picture back.
  - The images stay pixel-identical while you pan, and memory stays bounded.
- **Comment mode:** tap a spot to drop a pin, which stores the frame id plus x and y as 0–1 fractions. A bottom sheet opens above the keyboard (positioned with `visualViewport`) and never covers the toolbar.
- **Frames list:** jump to any frame, with a dot on frames that have open comments or changed in this version.
- **Compare (Phase 2):** side by side, swipe, or **Changes**: the regions whose pixels differ between the two renders, each outlined in violet and numbered. An agent can label a frame's change when it publishes (`--note "live-view=Moved MF above the strip"`), and the label appears next to that region.

### 5.3 Article
- **Readable at any width:**
  - a reading column of about 68 characters, with an outline drawer
  - tables scroll sideways on phones instead of squashing
  - code blocks wrap or scroll
- **Comments:** tap a paragraph's margin dot, or select text, then comment. On phones the threads open in a sheet; on desktop they show in the right margin.
- **Reading position** is remembered per article. A "changed since you last read" highlight appears after a new version.

### 5.4 Mobile rules (every view)
- Safe areas are respected, and touch targets are at least 44 pt.
- Nothing depends on hover.
- Sheets never cover primary controls.
- Pages never zoom when an input gets focus (16 px minimum font size).
- Tested in WebKit at iPhone size before release (§9).

### 5.5 Archive and delete

Two ways to clear an artifact away: **archive** when it's done and worth keeping, **delete** when it shouldn't exist.

| | Archive | Delete |
|---|---|---|
| What it's for | Finished work you may want to look back at | Mistakes, duplicates, things published by accident |
| Lists | Hidden from Home, Projects and people's search; shown under a project's **Archived** filter. Agents still find it in `artifacts search`, marked archived, because a dropped experiment is worth knowing about (§10.3) | Gone from every list; shown in **Recently deleted** for 30 days |
| Its links | Keep working, with an "Archived" banner | Stop working at once: people who could see it are told "This artifact was deleted", anyone else gets the ordinary not-found page, and share links stop |
| Reviewing | Read-only: no new comments, versions or approvals | Nothing |
| Micro app | Try it still runs; its data folder becomes read-only, so backend writes are refused | Its backend stops |
| Undo | **Unarchive**, any time | **Restore** within 30 days; after that it's purged for good |
| Who | Its publisher, or an admin. Agents too, with `artifacts archive` | Its publisher, or an admin, signed in within the last 10 minutes. Agents can move an artifact to Recently deleted, but only a person can purge |

**Rules:**
- **Purging is permanent.** After 30 days in Recently deleted, or when someone chooses "Delete now", the artifact is erased: its versions, pages, comments, share links, approvals, data folder and backend code. Its files are removed from the bucket unless another version or artifact still uses them (below).
- **Agents can only do undoable things.** An agent's CLI token can archive, unarchive and move to Recently deleted, all of which a person can undo. Purging needs a person in the viewer.
- **Confirmation says what goes.** The delete sheet lists what will be erased ("5 versions, 23 comments, its data and its backend") and when.
- **The slug stays taken while it's recoverable.** Publishing to a deleted artifact's slug fails with "Deleted on Oct 29 by Zahin; restore it or pick another slug" for someone who could see the artifact; anyone else is only told the slug is taken. After the purge the slug is free.
- **Activity records it.** "Zahin archived Camera Buddy roadmap" and "Claude moved Old onboarding to Recently deleted" appear in Activity. A purge leaves a one-line record (name, who, when) with no content.
- **One version can be removed too,** for a version that should never have been published (say, it showed a secret). It's the same 30-day Recently deleted step. The artifact's other versions stay, and threads made on that version move to the next version, marked "made on a removed version". The only version, or the latest one, can't be removed; publish a fix first.
- **Recently deleted** is a page under Settings. People see what they deleted; admins see everything.

## 6. Review model

- **Anchors:**
  - Canvas: `{page, frame, x, y}`.
  - Article: `{page, blockId, quote: {exact, prefix, suffix}}`, in the W3C text-quote style, so a quote is found again even if its block moves.
  - Page-level comments need no anchor.
- **Threads:**
  - a root comment plus replies
  - status is `open`, `fixed` (an agent says it addressed the thread, in version N) or `resolved`. Only people resolve; a reply to a fixed thread reopens it.
  - each thread records the version it was made on
  - mentions, and simple reactions in Phase 2
- **Across versions:**
  - When vN+1 is published, every open thread is re-anchored.
  - A thread whose frame or block content hash changed is marked **updated** ("frame changed since this comment").
  - A frame's hash comes from its **rendered @1x image**, not its source HTML. In the CameraBuddy thread most fixes were in shared `mock.css`, `mock.js` and `photos.js`, so a source hash would either miss them or flag every frame. The determinism lint makes the image hash reliable.
  - A thread whose anchor disappeared is marked **orphaned** and moves to the page level, with a link to view it in the old version.
- **Agent loop:** this is what makes the system worth building.
  - `artifacts comments --open --json` returns, for each thread:
    - the anchor
    - the text
    - the author
    - the version it was made on
    - a **cropped image of the area around the pin**, so the agent can see what the comment points at. The server cuts it from the stored @2x render when the comment is made and keeps it in the bucket (`crops/<thread id>.webp`). Article comments carry their quoted text instead.
  - `artifacts reply <id> "Moved MF control above the strip" --fixed` marks the thread fixed in the new version and asks the author to resolve it.
  - `artifacts publish` prints which open threads point at frames that changed, so the agent can reply to each of them.
- **Approval:** you can mark a version "Approved" or "Request changes" with a note.
  - Nothing is pushed to the agent. Agents run on people's machines, not on the server, so "Request changes" only records the decision. The skill starts every agent run with `artifacts status`, which returns the decision, the note and the open comments.
  - **Later, optional:** a webhook per project that fires on "Request changes", so a team can start an agent run from it (a CI job, or a remote Claude Code session).
- **Version history:** every publish is kept. Like a docs app, a person can name a version ("Real photos"), preview any version, compare it with the current one, and **restore** it. Restoring publishes a copy of the old version as the next one, so nothing is lost and open threads re-anchor as usual. CLI: `artifacts versions`, `artifacts versions name 4 "Real photos"`, `artifacts restore 4`. Agents can name the version they publish with `artifacts publish --name`.
- **Notifications (Phase 2):** your own server sends Web Push to devices that allowed it, when an agent publishes or someone replies, plus a daily digest.
  - No outside provider or account: the server signs messages with a VAPID key pair it generates on first boot and keeps in Postgres, and the browser's push service delivers them (Apple's, for Safari).
  - On iPhone, Safari only allows web notifications for sites added to the Home Screen, so the viewer asks once, after your first comment.

## 7. Architecture (self-hosted on Railway, portable anywhere)

```
             ┌──────────────── your machine / any agent ─────────────────┐
             │  repo/artifact.json + sources                             │
             │  artifacts CLI: lint → render (Playwright WebKit) →       │
             │                 hash → upload missing files → commit      │
             └──────┬──────────────────────────────────┬─────────────────┘
                    │ HTTPS + CLI token                │ presigned PUT (direct)
┌───────────────────▼──────────────────────┐   ┌───────▼──────────────────┐
│ app service: one container, Bun + Hono   │   │ Storage bucket (S3 API)  │
│  viewer domain   viewer + /api + auth    │──▶│ blobs/<sha256>, renders  │
│  content domain  sandboxed bundle files  │   │ immutable; read through  │
│  passwords (argon2id), passkeys          │   │ presigned GET redirects  │
│  (WebAuthn), sessions, invites, tokens   │   │ data/<artifact>/…: each  │
│  artifact data API, backend proxy (§7.9) │   │ artifact's values, files │
│  backend sandbox: QuickJS child          │   └──────────────────────────┘
│  processes, no secrets (§7.9)            │
│  realtime over SSE (Phase 2)             │
└──────────┬───────────────────────────────┘
           │
┌──────────▼──────────────────┐
│ Postgres: org, people,      │
│ credentials, sessions,      │
│ projects, artifacts,        │
│ versions, threads, activity │
└─────────────────────────────┘
```

On Railway, those are three things in one project from the template: the app service, Railway Postgres and a Railway Storage Bucket. Artifact backends (Phase 2) run inside the app service, in sandboxed child processes, so they add no service. Anywhere else, `deploy/compose` runs the same containers with Postgres and SeaweedFS (an S3-compatible store).

### 7.1 Components
- **App server.** One container:
  - **Code:** TypeScript on Bun, Hono for routing, Drizzle for Postgres migrations, which run at boot. Password hashing uses Bun's built-in `Bun.password` (argon2id), so there's no native module to compile.
  - **What it serves:** the viewer (a Preact SPA build), the API, and the content host.
  - **Three ports:** the viewer and API (8080), the content host (8081), and an internal port (8082) reachable only over Railway's private network, for operators' job triggers. Full list in [implementation/03-api.md](implementation/03-api.md).
  - **Two domains:** the content host answers on its own port, and Railway lets a service have one domain per port ("target ports"). With Railway's generated domains, both sit under `up.railway.app`, which is on the Public Suffix List (checked 2026-10-29). Browsers therefore treat them as separate sites, so the content host is isolated without buying a second domain.
  - **Custom domains** are optional and can be added at any time (§7.3, "More than one domain"). Keep the content host on its Railway domain, or on a different registrable domain: `content.zahin.ca` would be the same site as `art.zahin.ca`, which weakens the isolation. The server warns if they share a site.
  - **Scaling:** the server keeps no state in memory. If it ever runs more than one replica, realtime events fan out through Postgres `LISTEN/NOTIFY`.
- **Postgres** holds the organization, people, credentials, sessions and all review data.
  - The full schema (every table, column and index) is in [implementation/02-data-model.md](implementation/02-data-model.md).
  - Every row keeps an `org_id`, so multi-tenancy stays possible later without a migration.
- **Object storage** is any S3-compatible bucket: Railway Buckets, SeaweedFS, R2 or S3.
  - Files are content-addressed, `blobs/<sha256>`. A version is a manifest that maps each path to a hash, and republishing uploads only changed files.
  - **Clean-up:** because versions and artifacts share files, purging never deletes files directly. A daily job in the app lists every hash that a version still uses, and deletes bucket files that nothing uses and that are more than a day old. The day's delay protects uploads from a publish that hasn't committed yet. Purging an artifact deletes its data folder (`data/<artifact id>/`) directly.
  - **Uploads go straight from the CLI to the bucket** through presigned PUT URLs. On Railway, uploads *from a service* to a bucket are billed as service egress; direct uploads aren't.
  - **Frame images and assets** are served by redirecting to presigned GET URLs. Bucket egress on Railway is free; serving through the app would be billed. Signatures are issued per day, not per request, so phones can keep cached copies.
  - **HTML, CSS and JS for live frames and prototypes** go through the content host, so the sandbox rules apply.
- **Rendering happens in the CLI.** Playwright WebKit renders every frame at @1x, @2x and @3x, plus thumbnails and OG images. The server never runs a browser. It does cut comment crops from the stored @2x renders with an image library (§6).
- **The backend sandbox (Phase 2)** runs artifact backends (§7.9) in child processes of the app, with no environment and no credentials; they reach their data only through the app.
- **Images** are resized and converted to WebP or AVIF by the CLI at publish time, within size budgets.
- **No email.** The server never sends mail, so a deploy needs no email provider. Invite, reset and share links are copied from the UI or printed by the CLI, and you send them yourself (Messages, Slack). Sending email can be added later without changing anything else.
- **Realtime (Phase 2)** is server-sent events from the app. The MVP polls with ETags.
- **Latency.** Railway serves from the region you deploy in, with no CDN. Immutable cache headers mean a phone downloads each image once. A team spread across continents can put a CDN in front of a custom domain later.

### 7.2 Publish flow
1. The CLI runs `lint` and fails on errors (§9).
2. The CLI runs `render`, which captures frame images and records each frame's and block's content hash.
3. `POST /api/publish/prepare {files: [{path, sha256, size, type}]}` returns the hashes the bucket doesn't have yet, each with a presigned PUT URL valid for 15 minutes.
4. The CLI uploads those files directly to the bucket.
5. `POST /api/publish/commit` checks that every file exists with the right size, then creates version N+1.
   - The server re-anchors open threads, marks threads as updated or orphaned, and moves `latest`.
6. The CLI prints the URL, what changed (frames and blocks added, changed or removed) and the open threads on changed anchors.

### 7.3 People, sign-in and sharing

**One deployment is one organization.** Roles:

| Role | Can |
|---|---|
| Owner | Everything an admin can, plus transferring ownership and deleting the deployment's data |
| Admin | Invite and remove people, change roles and settings, create organization tokens, issue reset links, archive or delete any artifact |
| Member | Publish, see every organization-visible artifact, comment, share, archive and delete their own artifacts |
| Reviewer | See and comment on organization-visible artifacts; can't publish |

**Sign-in is email with a password, a passkey, or both.** No outside OAuth provider is involved.
- **Passwords:**
  - argon2id hashes (`Bun.password`) and a 12-character minimum.
  - Rate limits with backoff, per account and per IP.
  - Changing a password ends the person's other sessions.
- **Passkeys:**
  - WebAuthn through `@simplewebauthn/server` and `@simplewebauthn/browser`.
  - A person can add several passkeys, and a passkey can be their only credential.
  - **A passkey belongs to one domain.** Here that's the *home domain*: the viewer URL `artifacts setup` was run against. The server records it at setup and never changes it. More than one domain is covered below.
- **Sessions:**
  - Stored in Postgres and sent as an `httpOnly`, `Secure`, `SameSite=Lax` cookie that lasts 30 days from last use.
  - People can see and end their sessions.
  - Adding a passkey, changing a password or creating a token needs a sign-in within the last 10 minutes.

**No open sign-up.** Accounts only come from invites:
- **Organization invites,** from an admin with a role. The link is single-use and expires in 7 days. The admin copies it and sends it themselves. The invitee picks a password, a passkey or both.
- **Artifact invites,** from whoever shared the artifact, also as a copied link. They create an outside account that can only reach the artifacts shared with it.
- **Email addresses are sign-in names.** Nothing checks that a person owns their address; the admin who sent the link vouches for it.

**Password reset.** An admin issues a one-time reset link that lasts an hour (`artifacts org reset-link <email>` or the person's page) and sends it. A person with a passkey can also sign in with it and change their password. Owner recovery is in §7.4.

**More than one domain.** A deployment can answer on several viewer domains, for example the Railway domain it started on plus `art.zahin.ca` added later. Passkeys keep working on all of them:
- `PUBLIC_URL` is the domain copied links use. `MORE_URLS` lists the other viewer domains.
- The home domain serves `/.well-known/webauthn`, listing the other domains. This is a WebAuthn standard called Related Origin Requests: a browser on `art.zahin.ca` checks that file and then accepts passkeys made for the home domain. Nobody adds their passkeys again.
- **Browser support** (passkeys.dev, checked 2026-10-29): Chrome and Edge 128+, Safari on iOS 18+ and macOS 15+, Firefox 152+.
- **Older browsers:** the viewer checks `PublicKeyCredential.getClientCapabilities()`. Without `relatedOrigins`, the sign-in page offers "Sign in on <home domain>", which always works, as well as the password. People can also add a passkey made for the domain they're on; the server accepts passkeys made for any of its viewer domains.
- **Limits:**
  - The home domain has to stay attached to the service, even if nobody visits it any more. Removing it breaks every passkey made for it. The server always serves it as a viewer domain, whatever `PUBLIC_URL` and `MORE_URLS` say, so editing those can't break sign-in.
  - Password managers show the home domain's name on the passkey, for example `artifacts-production.up.railway.app`.
  - Browsers accept at most 5 distinct names ("labels") in the list. The home domain itself isn't listed. `art.zahin.ca` counts as `zahin`; a Railway domain counts as its own name, such as `artifacts-production`, because `up.railway.app` is a public suffix. A deployment needs one or two.
- **The content domain is never listed.** Bundle scripts run there and must not be able to ask for passkeys. The server refuses to start if it's listed.
- Sign-in sessions are per domain: opening the other domain means signing in again, with the same passkey.

**Visibility inside the organization.** Each artifact is **Only me** (the publisher, plus anyone they add) or **Organization** (every member and reviewer). An organization setting picks the default for new artifacts, and the manifest's `visibility` or the viewer can override it per artifact.

**Sharing outside, per artifact:**
- **People:** invite someone by email address as a viewer or commenter, and send them the printed link. A member of the organization can also be added as a **publisher** of that one artifact, so their agent can publish new versions; only the artifact's publisher or an admin can do that, because publishing a backend can read everyone's saved data. They sign in to an outside account that sees only what's shared with it.
- **Links:** anyone with the link can view, or view and comment. Links can expire and be revoked. Guests type a name and don't sign in. Opening a link starts a **guest session** for that link: a cookie on the viewer domain holding a random guest id and the typed name, lasting 90 days or until the link expires or is revoked. The guest id is what their comments, `me` data and backend caller identity use (details in [implementation/04-auth-and-permissions.md](implementation/04-auth-and-permissions.md)).
- Admins can turn link sharing off and see every outside share on one page.

**The CLI and agents.**
- `artifacts login <url>` uses the device flow. The CLI shows a code and opens `<url>/device`; you sign in with your password or passkey and approve. The token goes in the OS keychain, acts as you, and is scoped to publishing and commenting.
- Admins create organization tokens for CI and headless agents, scoped to projects and revocable.
- Anything a token does is marked as an agent's, shown with its person ("Zahin's Claude Code", or "Zahin's agent" when it didn't name itself). It never reads as the person's own comment or publish.

**One permission check.** Every request resolves to who is asking (a session, a CLI or organization token, or a share token). One function decides what that caller may do. Every API route uses it, and so does minting content-host tokens. A test matrix covers role × visibility × share type.

**URLs.** `<viewer domain>/<project>/<artifact>`, with `/v/3`, `#frame=…` and `?c=…`. Share links are `<viewer domain>/s/<token>`.

**Content host access, without cookies.** The UI calls the content host **Live previews**: it's where an artifact's own code runs, on a site of its own that can't read anyone's sign-in.
- The viewer gets a short-lived, path-scoped capability token from the API once the permission check passes. The content host then serves `<content domain>/t/<token>/v3/mocks/...`, so the bundle's relative URLs carry the token.
- It refuses top-level navigation (it checks `Sec-Fetch-Dest: iframe` and the embedding origin), so a share link can't become a bare hosted page.

### 7.4 The CLI is the entry point: `artifacts setup`

Everyone starts by installing the CLI and running `artifacts setup`. It deploys the server if there isn't one, claims it, signs this machine in, and installs the skill. Nobody needs to visit Railway's dashboard.

```
$ artifacts setup
Where should your Artifacts server run?
› Railway (recommended)    Docker, on a machine you run    I already have one
✓ Railway CLI 5.71.0, signed in as zahin@…
Railway workspace: Zahin's Projects
✓ Created Railway project "artifacts"
✓ Deployed the Artifacts template: app, Postgres, storage bucket
✓ Running: https://artifacts-production.up.railway.app
Organization name: Mochahub
Your name: Zahin
Email: zahin@…
Password: ••••••••••••   Again: ••••••••••••
✓ Created Mochahub with you as owner. This machine is signed in as you.
Install the skill for Claude Code and Codex? [Y/n] y
✓ ~/.claude/skills/artifacts   ✓ Codex skills
Next:
  Add a passkey: scan the code, or open https://artifacts-production.up.railway.app/settings/sign-in
  Invite someone: artifacts org invite sam@example.com
  Use your own domain: artifacts domain add art.zahin.ca
```

**What `artifacts setup` does on Railway.** It drives the Railway CLI. Every command below is in Railway CLI 5.71.0's help (checked 2026-10-29); the full sequence hasn't been run yet.
1. Checks for the Railway CLI and offers to install it (Homebrew or npm). If you're not signed in, it runs `railway login`, which opens Railway's sign-in in your browser.
2. `railway init --name artifacts --json` creates the project. `init` links the folder it runs in, so the CLI runs it in its own config folder (`~/.config/artifacts/railway/`), not in your repo.
3. `railway deploy --template <code>` provisions the published Artifacts template into that project: the app service, Postgres and a bucket, with variables and both domains (§7.5).
4. `railway service status --json` until the app is healthy, then `railway domain list --json` for the URLs.
5. `railway variable list --service artifacts --json` reads `SETUP_TOKEN` without printing it, and the CLI claims the server with it (below).
6. The CLI saves the server URL, the Railway project ID and the service name, so `artifacts upgrade` and `artifacts domain` can find it later.

**Other places to run it.**
- **Docker:** `artifacts setup --docker` writes `docker-compose.yml` and an `.env` with generated secrets into a folder you pick, runs `docker compose up -d`, and carries on from step 5 with the token it generated.
- **An existing server:** `artifacts setup <url>`. If the server is still in setup mode (say, someone used the Deploy on Railway button), it claims it; it reads the token through the Railway CLI if it can, or asks you to paste it. If the server is already set up, it signs you in instead (below).
- **Teammates** run `artifacts setup https://art.zahin.ca` too, after accepting their invite. It signs them in with browser approval (the device flow) and installs the skill.

**Claiming, and why there's a token.** A new server has no people. Until someone claims it, it's in **setup mode**: the viewer says "This deployment isn't set up yet. Run `artifacts setup <url>`.", and every other API returns 503.
- A freshly deployed public URL is otherwise claimable by whoever finds it first, so claiming needs `SETUP_TOKEN`. The template generates it with a template variable function; with Docker, the CLI generates it.
- Railway's CLI can't read *sealed* variables, so the template must not seal `SETUP_TOKEN`. If it's sealed, paste it from Railway → your project → artifacts → Variables.
- **The password is set in the CLI;** passkeys need a browser, so setup ends with a QR code and a link to add one on your phone.
- **The server's first URL becomes the home domain** for passkeys (§7.3).
- **Setup runs once.** After the owner exists, `/setup` is gone for good.
- **Owner recovery:** `artifacts recover <url>` with the same `SETUP_TOKEN` issues a one-time reset link for an owner. Whoever controls the deployment's variables can recover it, and changing `SETUP_TOKEN` on Railway retires the old one.

**Upgrades: `artifacts upgrade`.** One command updates everything you're responsible for:
- **The CLI** replaces its own binary with the latest release.
- **The skill** files are rewritten to match the CLI.
- **The server,** if you're an admin and it runs on Railway: `railway service source connect --image ghcr.io/<org>/artifacts:<version> --service artifacts` points the service at the new release's image, and the CLI waits until it's healthy. Migrations run at boot.
  - Migrations only add things, so one version back stays compatible. `artifacts upgrade --server --to <version>` rolls back.
  - On Docker, it changes the image tag in `docker-compose.yml` and runs `docker compose up -d`.
- The server tells an outdated CLI which version it needs, and the viewer shows admins when a new release is out.

**Domains: `artifacts domain add art.zahin.ca`** runs `railway domain art.zahin.ca --service artifacts --port <viewer port>`, prints the DNS records to add, adds the domain to `MORE_URLS` with `railway variable set`, and asks whether it should become `PUBLIC_URL`, the domain in copied links (§7.3).

### 7.5 The Railway template
- **Who uses it:** `artifacts setup` deploys it with `railway deploy --template` (§7.4). It's also published with a Deploy on Railway button, for people who'd rather start in the browser and claim with `artifacts setup <url>` afterwards.
- **What it creates:** the `artifacts` service, running this repo's released image (`ghcr.io/<org>/artifacts:<version>`, pinned), plus Railway Postgres and a Storage Bucket.
- **Updates come from the CLI,** not from Railway. Railway's own template update notices only work for services built from a GitHub repo (Railway's template updates docs, checked 2026-10-29). A pinned image is faster to deploy and easy to roll back, and `artifacts upgrade` moves it to a new version (§7.4).
- **Variables it wires:**
  - `DATABASE_URL` from Postgres, and the bucket's endpoint and keys.
  - `SETUP_TOKEN`, `SESSION_SECRET` and `OPS_SECRET` from template variable functions. The Web Push (VAPID) key pair isn't a variable: the server generates it on first boot and keeps it in Postgres, because a template can only generate random strings, not a key pair.
  - `PUBLIC_URL` from the first generated domain (`RAILWAY_PUBLIC_DOMAIN`). `CONTENT_URL` is set by `artifacts setup` from the second domain before it claims the server, because Railway has no variable for it (spike S1); until then Live previews are off. `MORE_URLS` starts empty.
- **Idle cost:** Railway's Serverless setting (app sleeping) is **off** for the app, so the viewer never has a slow first load.
- **Payout:** Railway pays template creators a share of what deployers spend. The docs say 25%, paid in credits or cash; a September 2025 changelog said 50%.

**Cost to a team per month (Railway rates checked 2026-10-29).** The rates:
- Plans: Hobby is $5 a month including $5 of usage; Pro is $20 including $20. Usage above the included amount is billed as the difference.
- Containers: RAM $10 per GB-month, CPU $20 per vCPU-month, both for what's actually used. Egress $0.05 per GB, volumes $0.15 per GB-month. Hobby caps a volume at 5 GB.
- Buckets: $0.015 per GB-month, with free API calls and free bucket egress.
- Serverless sleep: a service sleeps after 5–10 minutes with no outbound traffic and wakes on the next request, public or private.

Two services run, the app and Postgres, both always on. Backends run inside the app. Railway bills what each one actually uses every minute, so "always on" sets a floor rather than a fixed price. Above the floor, cost follows activity, not the number of artifacts stored:
- **App:** more requests mean more CPU. Each open viewer holds a small live connection, and the app passes live-preview files and backend calls through. Memory grows a little with concurrent users.
- **Postgres:** keeps more of the review data in memory as it grows, and serves more queries.
- **Backends:** use the app's CPU while they run, and up to 64 MB each while warm.
- **Storage and traffic:** grow with what's published, and are cheap.

| | Idle floor | Small | Team | Large |
|---|---|---|---|---|
| Who | Nobody using it | 3 people, 20 artifacts, a few micro apps now and then | 15 people, 150 artifacts, 10 micro apps used daily | 50 people, 1,000 artifacts, micro apps busy in work hours |
| App (RAM, CPU) | 0.1 GB: $1.04 | 0.1 GB: $1.10 | 0.15 GB, 0.02 vCPU: $1.90 | 0.25 GB, 0.06 vCPU: $3.70 |
| Postgres (RAM, CPU, disk) | 0.12 GB: $1.26 | 0.15 GB, 0.5 GB disk: $1.64 | 0.2 GB, 1 GB disk: $2.35 | 0.35 GB, 1.5 GB disk: $4.32 |
| Bucket | $0 | 2 GB: $0.03 | 20 GB: $0.30 | 100 GB: $1.50 |
| Egress from the app | $0 | 2 GB: $0.10 | 15 GB: $0.75 | 60 GB: $3.00 |
| **Usage** | **$2.31** | **$2.87** | **$5.30** | **$12.52** |
| **Bill on Hobby** | **$5** | **$5** | **about $5.30** | **about $12.50** |

All four fit on Hobby. Pro ($20, including $20 of usage) is only needed above Hobby's limits, such as a database volume over 5 GB.

What one more of each thing costs:
- **An artifact:** about 15 MB for its first version (26 frames at 1x, 2x and 3x as WebP), then only changed files. 100 artifacts at 30 MB each is 3 GB: about $0.05 a month.
- **A million backend requests:** about $0.25 of CPU, at about 30 ms of app CPU per request. Bucket calls are free.
- **Images and files people view:** free, because they come straight from the bucket.

**Unverified:** the RAM and CPU figures are estimates for Bun and Postgres at these loads (backends now run in the app, so the app's line will grow with micro-app use; measure it), not measurements; an earlier draft of this table guessed higher. Measure them on the first deploy, and update this table.

### 7.6 Portability
The code uses no Railway-only APIs. It needs a container host, Postgres and an S3-compatible bucket. `deploy/compose` (app + Postgres + SeaweedFS) covers a VPS, a home server or Fly/Render-style hosts. The Railway template is the recommended path, not the only one.

### 7.7 Why Railway rather than Cloudflare

| | Cloudflare (previous design) | Railway (this design) |
|---|---|---|
| Portability | Workers, D1, R2 and Durable Objects are Cloudflare-only | A standard container + Postgres + S3 runs anywhere |
| Passwords and passkeys | Argon2id needs tens of ms of CPU per sign-in; Workers Free allows 10 ms per request | argon2id built into Bun; no per-request CPU limit |
| Realtime | Durable Objects | Server-sent events from the same process |
| One-click deploy | Deploy to Cloudflare button | Railway template, plus a 25% creator payout |
| Storage | R2: $0.015/GB-month, free egress | Buckets: $0.015/GB-month, free bucket egress |
| Isolated content domain | `workers.dev` is on the PSL | `up.railway.app` is on the PSL |
| Cost floor | About $0 | $5 a month (Hobby, includes $5 of usage) |
| Global edge | Yes | One region; add a CDN later if needed |

### 7.8 End to end: install, set up, publish, review

Where each step runs:

| Step | Who, how often | Runs on |
|---|---|---|
| 1. Install the CLI | Everyone who publishes, once per machine | Their machine |
| 2. `artifacts setup` | One person, once: deploys, claims, installs the skill | CLI → Railway CLI → Railway; then CLI → app service → Postgres |
| 3. Invite | An admin, per person | CLI or People page; you send the link |
| 4. Write and preview | The agent, every change | Your machine only |
| 5. Publish | The agent | CLI → app service, and CLI → bucket directly |
| 6. Review | People, on a phone or desktop | Safari → app service; images from the bucket |
| 7. Fix and reply | The agent | CLI → app service |
| 8. `artifacts upgrade` | Each person for the CLI; an admin for the server | Their machine; Railway |

1. **Install the CLI.** One binary built with `bun build --compile`. **Planned, not decided:** the install channel (an install script, Homebrew or `bun add -g`); nothing is released yet. Playwright's WebKit downloads the first time it's needed.
2. **`artifacts setup`.** Deploys the server through the Railway CLI, waits for it, claims it with `SETUP_TOKEN`, makes you the owner, stores a token in your keychain and installs the skill (§7.4). On your phone, scan the QR code and add a passkey.
3. **Invite.** `artifacts org invite sam@example.com` (or People → Invite) prints a single-use link. Send it in Messages or Slack. Sam opens it, creates a passkey or a password, and is in. If Sam publishes too, Sam installs the CLI and runs `artifacts setup https://art.zahin.ca`.
4. **Write and preview (local).** In a project repo, `artifacts init` adds `artifact.json` and the kit. The agent writes pages following the skill. `artifacts dev` serves the viewer locally with hot reload. `artifacts lint` and `artifacts render` run WebKit on your machine and write a contact sheet to `.artifacts/`. Nothing leaves your machine.
5. **Publish.** `artifacts publish -m "…"` runs lint and render, hashes every file, and asks the app which files the bucket is missing. The CLI uploads those straight to the bucket with presigned URLs. Then the app checks the uploads, writes the new version to Postgres, re-anchors open threads, and the CLI prints the URL and what changed (§7.2).
6. **Review.** Open the URL in Safari on your phone. The app serves the viewer and the review data from Postgres. Frame images come from the bucket through presigned redirects. Live HTML frames load from the content domain in a sandboxed iframe. Comments, approvals and requests for changes go to the app and into Postgres.
7. **Fix and reply.** In the next agent session, `artifacts status` and `artifacts comments --open --json` give the agent your decision and the open threads, with a crop of each pin. It fixes the source, publishes the next version and runs `artifacts reply <id> "…" --fixed`. You check and resolve.
8. **Upgrade.** `artifacts upgrade` updates the CLI and the skill, and for an admin, moves the Railway service to the new release's image (§7.4).

### 7.9 Micro apps: frontend, backend and data

An artifact can be just pages, or a small app. It has up to three parts, and most artifacts only use the first:

| Part | What it is | Where it runs | Versioned? |
|---|---|---|---|
| **Frontend** (always) | Pages, canvases and prototypes: static HTML, CSS and JS | Files in the bucket, shown from Live previews in a sandboxed iframe | Yes: each version is immutable |
| **Backend** (optional) | Request handlers in the bundle's `api/` folder | Code stored in the bucket with the version; run on demand by the app, in a sandbox | Yes, with the frontend: v3's pages call v3's backend, and restoring v2 brings back v2's backend |
| **Data** (optional) | The artifact's folder in the bucket: JSON values and files | The bucket, through the app | No: one folder shared by every version |

One `artifacts publish` ships the frontend and backend together. The data folder exists as soon as either one writes to it.

**Who decides who can see the data.** Each artifact chooses:
- **Without a backend,** the frontend uses the built-in store below, and its two scopes decide: `shared` for everyone, `me` for each person. (A frontend with a backend can still use the built-in store too.)
- **With a backend,** the frontend talks to its backend, and the backend reads and writes the whole folder and applies its own rules, using the caller's identity that Artifacts passes in.
- Either way, the publisher can export the folder with the CLI, and the viewer tells people "This artifact saves data; its author can see it."

#### Data

Prototypes and interactive articles sometimes need to remember things: a to-do list in a mocked app, which of three directions each reviewer picked, a checklist ticked off during review. The built-in store covers that without a backend. It lives in the bucket, not in Postgres.

**Why the bucket and not Postgres.**
- It's the artifact's own data, written by code an agent wrote. Keeping it out of Postgres means no tables or migrations for it, a busy prototype can't slow the review database down, and backups of review data stay small.
- An artifact's data is one prefix, so exporting or deleting it is one operation.
- One prefix per artifact in the existing bucket, not a bucket per artifact. A bucket is a provisioned resource with its own credentials; a prefix costs nothing.

```
data/<artifact id>/shared/<key>
data/<artifact id>/me/<caller id>/<key>            # caller id: a per-artifact pseudonym of the person or guest
data/<artifact id>/files/shared/<name>
data/<artifact id>/files/me/<caller id>/<name>
```

**Two scopes:**

| Scope | One copy for | Who can read | Who can write |
|---|---|---|---|
| `shared` | Everyone | Anyone who can view the artifact | Anyone who can comment on it |
| `me` | Each person, or each named guest on a link | That person; the publisher and admins, through the CLI | That person |

In Try it, the viewer says which applies: "Saved for everyone" or "Saved for you". The publisher can read people's `me` data because it's review input, and the viewer says so. (Confirmed; see §15.)

**What goes in each.** `shared` is for things everyone should see the same way; `me` is for things each reviewer should have their own copy of, so reviewers don't overwrite each other.
- `shared`: a poll's tally, a team checklist, shared notes, a leaderboard.
- `me`: your own ticks on a checklist, the answers you typed into a mocked onboarding form, your settings inside a prototype, your vote before results are shown, a photo you picked.

**The API artifact code uses** (from the kit):
```js
import { data } from "@artifacts/kit/data";
const { value, etag } = await data.shared.get("votes");        // JSON, or null
await data.shared.put("votes", next, { ifMatch: etag });       // throws Conflict if someone wrote first
await data.shared.update("votes", v => ({ ...v, [me]: "B" })); // read, change, write, retry on conflict
await data.me.list("todos/");
```
- Values are JSON, up to 64 KB each. Keys are up to 200 characters of letters, digits and `._/-`.
- Default limits per artifact: 1,000 keys and 5 MB per scope, and 10 writes a second per person. Admins can raise them.

**Files.** A prototype can store files too, such as a photo someone picks or a PDF they attach. Files use the same two scopes and the same path to the bucket.
```js
const { name, etag } = await data.me.files.put("avatar.jpg", file);   // a File or Blob
const url = await data.me.files.url("avatar.jpg");                    // short-lived link for <img src>
await data.shared.files.list();
```
- Default limits: 10 MB per file and 100 MB of files per artifact. Admins can raise them.
- **Uploads** go through the viewer and the app like other writes, so the bucket needs no CORS. On Railway, an upload from the app to the bucket counts as service egress ($0.05 per GB), which is negligible at these sizes.
- **Downloads** use presigned GET links on the bucket's own domain, never ours, and the app sets the content type when it signs them. Images, audio, video and PDF keep their type. Anything else is served as a download (`Content-Disposition: attachment`), so an uploaded HTML file can't run as a page.
- The live preview's content security policy allows images and media from the bucket's domain, and nothing else outside the bundle.
- Renders use fixture files from the bundle's `fixtures/files/`, like the JSON fixture.

**How a write reaches the bucket.** Live frames run in a sandboxed iframe without `allow-same-origin`, so by design they have no cookies, storage or same-origin requests of their own. Data calls go through the viewer:
1. The kit posts a message to the parent window: `{op: "put", scope, key, value, ifMatch}`.
2. The viewer accepts it only from the iframe it created for that artifact (it checks `event.source`), then calls `PUT /api/artifacts/<id>/data/<scope>/<key>` with the person's session, or the guest session for a share link.
3. The app runs the usual permission check (§7.3), enforces the limits, and writes to the bucket with a conditional write: `If-Match: <etag>`, or `If-None-Match: *` for a new key.
4. The answer goes back the same way. On a conflict the bucket answers 412, and the kit's `update()` re-reads and tries again.

Consequences:
- The content host has no data API to secure. It serves bundle files, and from Phase 2 runs `api/` requests in the backend sandbox (below).
- Stored values come back through `postMessage` and are never served as a page, so stored data can't inject script into the viewer.
- Writes go through the app rather than presigned URLs. Values are small, and it avoids needing CORS on the bucket, which Railway's bucket docs don't mention.

**Concurrent writes.** Railway's buckets run on Tigris, and Tigris documents `If-Match` and `If-None-Match` on uploads, answering 412 when the condition fails. SeaweedFS, used in `deploy/compose`, supports both, and Railway's bucket endpoint passes them through (spike S3: 22 of 22 checks on both, 2026-10-30). Conditional writes are required of the bucket, so there's no lock-only fallback ([08](implementation/08-micro-apps.md#data-store-server)).

**Versions.** Data belongs to the artifact, not to a version, so it survives republishing and restoring.
- If a new version changes the shape of the data, the artifact's code handles it. The skill tells agents to keep a `schema` number in stored values, or to start new keys.
- `artifacts data clear` resets it.
- **Archived artifacts** are read-only everywhere: the data API and the backend's `env.DATA` both refuse writes (§5.5).

**Rendering stays deterministic.** Frame images must not depend on what reviewers clicked. `artifacts render` runs every frame with the bundle's fixtures (`fixtures/data.json` and `fixtures/files/`; empty if absent), and the canvas shows those pictures. Live data only loads in Try it.

**Local development.** `artifacts dev` serves the same API from `.artifacts/data/` in the repo, so prototypes work offline.

**The agent's side.** Data is review input, so an agent can read what people chose:
```
artifacts data ls [--scope shared|me]
artifacts data get <key> [--scope shared|me] [--json]
artifacts data export > data.json       # everything, with each person's name
artifacts data clear [--scope shared|me]
```

**Later:** `data.shared.watch(key, fn)` over the same server-sent events as live comments, so a poll updates as people vote.

#### Backend

**What an agent writes.** A module in `api/` with the Web-standard handler that most serverless platforms use:
```ts
// api/index.ts
import { caller } from "@artifacts/kit/backend";
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const who = caller(request);                 // { id, name, kind, canComment, isPublisher }
    const votes = (await env.DATA.get("votes")) ?? {};
    if (request.method === "POST") {
      votes[who.id] = (await request.json()).choice;
      await env.DATA.put("votes", votes);        // the whole folder, any key; the backend sets the rules
    }
    return Response.json(votes);
  },
};
```
- `env.DATA` is the artifact's folder: the same get, put, list and files calls as the built-in store, without the scope rules. It's the only thing a backend can reach: no network, no secrets, no other artifact's folder. More can be added later if a real need shows up.
- `caller(request)` reads identity that the app adds to the request. The app removes any copy a client tries to send.
  - **Fields:** a stable id for that person in this artifact, their display name (or a guest's typed name), and whether they're a member, reviewer, outside person or guest. It also says whether they can comment, and whether they published the artifact.
  - **Not included:** email addresses. Ids differ per artifact.

**The manifest declares it:** `"backend": { "src": "api/index.ts" }`.

**How a request flows.**
1. The frontend calls a relative URL, `fetch("api/votes")`. Because live frames load from `<live previews>/t/<token>/v3/…`, that resolves to `…/t/<token>/v3/api/votes`.
2. The app checks the path token, which already says who is looking and at which version (§7.3), and adds the caller identity.
3. The app hands the request to a sandbox process with the backend's content hash. The sandbox loads that code (from the app, by hash), keeps it warm while it's in use and unloads it when idle.
4. It runs the handler. Each `env.DATA` call goes back to the app, which applies it to that artifact's folder only, and the response goes back the same way.

The live frame has no origin of its own, so the app answers `api/` requests with `Access-Control-Allow-Origin: *` and no cookies. The token in the path is the permission.

**Sandboxing and limits.** Agent-written code runs on your server, so there are two layers of defence:
- **The engine:** each backend runs in its own QuickJS instance compiled to WebAssembly, with its own capped memory, and no file system, environment, timers or network. Its only binding is `env.DATA`.
- **The process:** sandboxes run in child processes of the app with nothing secret in their environment: no database URL, bucket keys or secrets. Their only channel is to the app, which checks every `env.DATA` call against the request in flight. `env.DATA` writes are refused for people who can only view, and on archived artifacts.
- **Default limits:** 1 MB of bundled code, 10 seconds per request and 64 MB of memory per backend, all enforced per backend: a stuck or greedy backend fails alone, without slowing others. Admins can change them.
- **Threat model:** a self-hosted deployment where everyone who can publish is invited. A hosted, multi-tenant version would need a VM-level sandbox per tenant (§14).

**Publishing.** The CLI bundles `api/` into one ES module with `bun build`, lints it (size, no network calls, no APIs the sandbox lacks), and uploads it content-addressed like every other file. The version's manifest records the backend's hash.

**Versions.** Old versions keep running their own backend code, so an old link still works. The data folder is shared, so a backend that changes the shape of its data handles both shapes; the skill tells agents to keep a `schema` number in stored values.

**Rendering stays deterministic.** `artifacts render` runs the backend locally against the bundle's fixture data, so frames look the same every time.

**Local development.** `artifacts dev` runs the same sandbox on your machine, with data in `.artifacts/data/`.

**For agents.** `artifacts logs [--follow]` shows the backend's console output and errors for the last 24 hours.

**The sandbox: QuickJS in child processes of the app** (decided 2026-10-30, replacing the workerd runner service). Spike S4 found that workerd and Deno couldn't enforce per-backend CPU and memory limits; QuickJS compiled to WebAssembly can, and needs no extra service. Agents' code is the same `fetch(request, env)` module either way. Details in [implementation/08-micro-apps.md](implementation/08-micro-apps.md#backends-the-sandbox-appsserversrcsandbox) and [implementation/spikes.md](implementation/spikes.md); the earlier comparison is in [backend-runtime-evaluation.md](backend-runtime-evaluation.md).

**Not included, for now:** outbound network calls, secrets, long-running processes, background or scheduled jobs, WebSockets, and SQL databases. A backend answers a request using its data folder, and stops.

## 8. Design kit (`@artifacts/kit`)

The kit is why artifacts look stunning by default instead of only when an agent tries hard.

- **Device frames:**
  - iPhone (Dynamic Island, status bar, home indicator)
  - iPad, Watch, Mac window, browser window
  - Android in a later phase
  - Each is a web component (`<a-phone time="9:41">`), generalized from CameraBuddy's `mock.js`.
- **iOS-style primitives:**
  - tab bar, nav bar, sheet, list rows, toggles, segmented control
  - the "safe text" utilities the audit kept needing (no text under the home indicator, no clipped labels)
- **Templates:** editable starters for daily work, copied by `artifacts init --template <name>`: design review, presentation, case study, PRD, RFC, research report and weekly status. Each has a guide to its structure in the skill. They never prescribe content, and agents can skip them. Presentations are canvas boards of 16:9 frames.
- **Icons:** an open-licence icon set such as Lucide, with a name map. No emoji as icons, as the CameraBuddy audit found.
- **Article typography:** a display and body font pair, plus these components:
  - callouts
  - comparison tables
  - decision lists
  - verdict badges
  - stat tiles
  - figures and charts (the `dataviz` skill's palette and rules)
- **Theme tokens:** accent, neutrals, radius, fonts and type scale. Each project sets them in its manifest, so CameraBuddy looks like CameraBuddy. The CLI turns them into tokens at render, and articles carry the allowed values to the viewer, which applies them only inside the article body. The review UI keeps its own look.
- **Brand:** a good default ships for everyone. `artifacts setup` ends with a prompt to hand an agent, which reads your brand guide, previews it across the templates and proposes it with a sample artifact. A person reviews the sample and applies it in Settings; a token can't. A person can also set a name, colours, built-in fonts and corners by hand in Settings, with a live preview; only an agent can add font files. Precedence, lowest first: a template's look, the org's brand, a project's `theme`. The CLI caches the brand, so it renders offline. Brand fonts ship in each bundle, so they must be licensed for embedding.
- **Photo helpers:** stand-in images, `data-p` photo frames with real aspect-fit, and computed overlays. CameraBuddy's overlay code stays in that project; the kit only provides the hook.

Phase 0 sets the visual direction: we mock the viewer itself and review it in the existing local canvas. The system is also its own first artifact.

## 9. Quality gates (`artifacts lint`)

| Rule | Comes from |
|---|---|
| Overlapping controls, clipped or wrapped labels, text under the home indicator, content off-frame | The thread's 26-screen audit |
| Missing files, absolute paths, external URLs (fonts, CDNs) | The `/tmp` relative-path breakage, and offline viewing |
| Backend: bundle size, network calls, APIs the sandbox lacks | Backends that fail only after publishing (§7.9) |
| Image weights, and total weight per frame and bundle | The 2.2 MB cellular reload |
| Duplicate or renamed `data-frame` and block ids that have open comments | Keeping comments anchored |
| Non-deterministic rendering (render twice and compare pixels) | The "render changes while I pan" report |
| Data used outside the kit API, and frames that render differently with and without the fixtures | Keeping pictures independent of what reviewers clicked (§7.9) |
| Text contrast (WCAG AA) on frames and articles | Readability of chips over bright photos |
| Project-specific rules (`lint.rules.js` in the project) | Overlays showing only on the intended screens, and similar |

`artifacts render` also writes a contact sheet of every frame, so the agent can check them visually before publishing. The skill makes this check mandatory.

## 10. CLI and skill

### 10.1 CLI (`artifacts`, Bun, compiled to one binary; `bunx` works too)
```
artifacts setup [--docker]        # the entry point: deploys a server on Railway (or Docker), claims it, signs in, installs the skill
artifacts setup <url>             # an existing server: claims it if it's new, otherwise signs you in and installs the skill
artifacts upgrade [--server] [--to <version>]   # updates the CLI and skill; admins also move the server to the new release
artifacts domain add <domain> | list            # adds a custom domain on Railway and prints the DNS records
artifacts doctor                  # checks WebKit, the skill, the sign-in and the server version
artifacts skill install           # reinstalls the skill for Claude Code and Codex
artifacts login <url> | logout | whoami   # browser approval (device flow); token in the OS keychain
artifacts recover <url>           # with SETUP_TOKEN: a one-hour reset link for an owner
artifacts init [--in-repo]        # a working folder in .artifacts/work/, or artifact.json + kit here
artifacts dev                     # local viewer with hot reload (replaces review/server.py)
artifacts lint | render           # quality gates; contact sheet in .artifacts/
artifacts publish [-m <message>] [--note <frame>=<text>]   # → URL, change summary, threads on changed anchors
artifacts search <words>          # the hosted library: short cards, from any folder
artifacts list [<project>[/<slug>[/<page>]]]   # browse, only as deep as asked
artifacts read <project>/<slug>   # full text, in pieces
artifacts view <project>/<slug>   # a frame as a picture: a thumbnail, or larger on request
artifacts pull <project>/<slug>   # restore a working folder from a published version
artifacts export <project>        # every artifact in a project, with versions, comments and decisions
artifacts open [--version N]
artifacts comments [--open] [--json] [--page mocks]
artifacts status                  # latest decision, note and open comment count
artifacts reply <id> "<text>" [--fixed]
artifacts visibility org|me       # who inside the organization can see it
artifacts share --link [--comment] [--expires 7d]          # external link
artifacts share --invite sam@example.com [--comment]       # external person; prints their link
artifacts org invite <email> [--role member|reviewer]      # admins only; prints the invite link
artifacts org reset-link <email>                           # admins only; prints a one-hour reset link
artifacts versions | diff v3 v4
artifacts archive [<project>/<slug>] [--undo]    # hide a finished artifact; read-only, links keep working
artifacts delete [<project>/<slug>] [--version <n>]   # to Recently deleted for 30 days
artifacts undelete [<project>/<slug>] [--version <n>] # back within 30 days; purging is only in the viewer
artifacts versions name <n> "<label>"   # name a version; publish --name does it at publish time
artifacts restore <n>             # publishes a copy of version n as the next version
artifacts data ls | get <key> | export | clear [--scope shared|me]   # an artifact's data (§7.9)
artifacts logs [--follow]         # the artifact backend's console output and errors
```
- **Which artifact a command acts on:** commands about one artifact (`publish`, `open`, `comments`, `status`, `reply`, `visibility`, `share`, `versions`, `restore`, `archive`, `delete`, `undelete`, `data`, `logs`) act on the artifact named by the `artifact.json` in the current folder or its nearest parent, or else on the only working folder in `.artifacts/work/`. An optional `<project>/<slug>` argument overrides that, for example `artifacts archive camerabuddy/onboarding-v1`. Every command accepts `--json` for agents.
- **`share --invite` from a CLI token** gives access that can comment but not approve, request changes or resolve, until a person confirms it by granting the same person access in the viewer.
- The CLI is agent-agnostic, so Claude Code, Codex, CI and you can all use the same contract. The full command reference, with flags and output, is in [implementation/07-cli-and-skill.md](implementation/07-cli-and-skill.md).
- An **MCP server** (Phase 2) is a thin wrapper over the same API, for tools without a shell.

### 10.2 Skill (`~/.claude/skills/artifacts/SKILL.md`, synced to Codex)
- **When to publish:** any plan, research report, mock, comparison or report the user should read or review. Don't use it for throwaway output.
- **How to structure it:**
  - the manifest
  - which page kind to use for which content
  - frame and block id conventions
  - how to use the kit and theme tokens
  - the writing style for articles
- **Gate:** lint → render → look at the contact sheet → fix → publish. The agent never publishes on a failing lint.
- **Review loop:** on "address the comments":
  1. Pull open threads with their crops.
  2. Fix the source.
  3. Republish.
  4. Reply to each thread with what changed, using `--fixed`. Never resolve a person's comment. If a comment is ambiguous, ask a question and leave the thread open.
- **Report back:** the URL, the version, what changed and which threads were marked fixed.

### 10.3 The hosted library

A later agent should find, skim and open published work almost as easily as local files, in any repo, with or without a working copy.

- **Selective disclosure.** `search` and `list` return small cards with a capped size: project, slug, title, summary, tags, status, outcome, latest version, updated time and a match snippet. Only `read` (paged) and `view` (a picture) return content, so an agent can page through a hundred results without filling its context.
- **Search** is Postgres full-text search over each artifact's latest version: article text, frame and page titles, summaries, tags, version notes and comments. It answers in the viewer's ⌘K too.
- **`outcome`** says how the review ended: approved or changes requested, open comments, and archived, so an agent can tell whether an experiment won or was dropped.
- **Project matching.** A project remembers its git remote, in any form, with credentials removed, so an agent in a clone finds its project with no `artifact.json`.
- **Every search, list and read** goes through the same permission check as the viewer, and a hidden artifact can't show through a count, a snippet or a summary.
- **Text in results is data.** Comments, summaries and articles can come from other people, guests included, so tool results say to treat them as data, never as instructions.

### 10.4 The hosted connector

A hosted MCP server at `<viewer domain>/api/mcp` makes a remote box easy to set up in tools like Claude Code and Codex, with no local skill.

- **Sign-in** is OAuth 2.1 with our own server as the authorization server, on the existing email, password and passkey sign-in, plus a consent screen. Connectors appear in Settings and can be ended there. Scopes are read, comment and publish. A connector can't resolve, decide, delete or manage. CLI tokens also work as a static bearer.
- **Tools:** search, list, read, view, status, comments, reply and versions, with the same permission checks as the API, and two for publishing. Templates and guides are resources, so a connected agent has the guidance without the skill.
- **Publishing:** the client renders, and the server stays browserless. `artifacts pack` lints, renders and writes a publish to a local folder; files go straight to the bucket, and a commit payload goes as a blob and is committed by hash, so neither passes through the model.
- **Articles with no CLI:** a tool publishes Markdown with a required summary, with no filesystem or shell, through the same commit and sanitizer as the CLI. It takes text only: images, diagrams and embeds need the CLI.
- **What's still needed on a box:** the CLI and WebKit, to render canvases or anything with images. Reading, commenting, replying and publishing text articles need neither.
- It's opt-in: `artifacts mcp install` adds it. The local `artifacts mcp` stays, for tools on the same machine.

## 11. Repo layout (this repo)
```
apps/server      Hono API on Bun: viewer + content host, auth, publish, data API, backend sandbox, jobs; Drizzle migrations
apps/viewer      Preact SPA: shell, canvas, article, comments, settings
packages/cli     artifacts CLI (Bun, compiled binary): setup, publish, lint rules, Playwright renderer, dev server
packages/kit     design kit for artifacts: CSS tokens, web components, icons, article styles; kit/data and kit/backend
packages/schema  manifest, API and message types (zod), shared by all of the above
skill/           SKILL.md + references, installed into ~/.claude/skills and Codex
deploy/railway   template definition and README for the Railway template
deploy/compose   docker-compose.yml: app + Postgres + SeaweedFS, for any other host
docs/            this spec, evaluations, implementation guides, mocks and the review canvas
```

## 12. Phases

| Phase | Scope | Done when |
|---|---|---|
| **0: Direction** (days) | Pick the name. Mock the viewer (canvas, article, comments) on phone and desktop. Review the mocks with the current local canvas. Lock the kit's visual direction. | You've approved the viewer mocks |
| **1: MVP** | One container (Bun + Hono) with Postgres and S3-compatible storage, MIT licensed. The Railway template and Docker Compose. Email + password and passkey sign-in, `artifacts setup` for the first owner, invites, the four roles, the organization visibility setting, and per-artifact external sharing (people and links). CLI `setup, upgrade, domain, login, init, dev, lint, render, publish, comments, reply, share, org invite, archive, delete, undelete`. Archive, delete with Recently deleted, and file clean-up (§5.5). Version history: name, preview, compare and restore (§6). Status that follows the review, and project search, sort and filter (§5.1). Canvas viewer (image level of detail, pins, frames list). Article viewer (outline, block and quote comments). Version picker and "changed" badges. Approve or request changes, and `artifacts status`. Kit v1. Skill v1. | **Acceptance:** the CameraBuddy roadmap (plan, seven research reports, four boards) is published, reviewed on your iPhone over 5G, and an agent completes a full comment → fix → republish → reply round trip from a fresh session. On a machine with only the CLI installed, `artifacts setup` deploys to Railway, claims the server and installs the skill in under 10 minutes. A teammate joins through an invite and sees organization artifacts but not your private ones, and someone outside comments through a link |
| **2: Live review and micro apps** | Realtime comments over server-sent events, Web Push and the install prompt, version compare (side by side, swipe, changes), Micro apps (§7.9): Try it, artifact data and files, and backends in the app's sandbox with `artifacts logs`; the prototype and gallery kinds, ⌘K search, MCP server, OG unfurls | Comments show up live on the second device; you get a push notification when the agent replies. Outside teams deploy the template and publish within 15 minutes |
| **3: Breadth** | Decks, PDF and zip export, Android frames, groups inside an organization, audit log export. If hosting is ever approved (§14): multi-tenancy, abuse tooling, billing, SSO | — |

## 13. Mocks

The viewer is mocked in [`mocks/boards/`](mocks/boards/) on seven boards: find and open, canvas review, read and annotate, desktop, share/decide/notify, accounts (setup, sign-in, passkeys, invites, domains), and archive and delete. The viewer is a website, so phone screens are drawn in Safari: the full bottom bar on pages seen from the top, and the collapsed bar on canvases, articles and sheets. To view them here, run `python3 -I review/server.py` from `docs/`. Comments left there go to `review/comments.json`, which git ignores. To review them on a phone, publish them as an artifact. The phone screens shown inside the mocks are Camera Buddy's mocks, captured with `mocks/tools/capture-cb.mjs`.

## 14. Self-hosted, on Railway

Decided 2026-10-29. Artifacts is open source (MIT), and each team deploys its own copy:
- **Recommended path:** `artifacts setup`, which deploys the Railway template for you.
- **Anywhere else:** Docker Compose.
- **Sign-in:** email with a password or a passkey, so there's no OAuth app to register.
- **First owner:** created by `artifacts setup` (§7.4).

Why self-hosted rather than a hosted service is in [hosting-evaluation.md](hosting-evaluation.md). In short:
- Claude Code artifacts and four startups already sell the hosted publish-and-comment loop.
- What's left is narrower: a mobile canvas with pins, multi-page bundles, image files at no token cost, WebKit rendering with lint, and any agent. A tool you run covers that without the work of a hosted business.

Why Railway rather than Cloudflare is in §7.7.

A hosted version stays possible: rows keep an `org_id`, and every request goes through one permission check. It isn't planned.

## 15. Decisions

Decided 2026-10-29:
1. **Runtime:** Bun, for the server and the CLI.
2. **Domains:** either works. Start on Railway's generated domains and add a custom domain whenever you like; passkeys carry over (§7.3, "More than one domain").
3. **Email:** none for now. Invite, reset and share links are copied by hand.
4. **Licence:** MIT.
5. **Micro apps are central.** An artifact can carry a backend and a data folder; both ship in Phase 2.
6. **Backend sandbox:** QuickJS (WebAssembly) in child processes of the app, with no separate service (2026-10-30, after spike S4; it replaced workerd).
7. **Backend reach:** only its own data folder. No network or secrets until there's a need.

Defaults the builder uses until the user says otherwise:
8. **Reviewer role:** keep it (owner, admin, member, reviewer). The mocks use it.
9. **Retention:** keep every version forever. Archive and delete (§5.5) cover clearing things away by hand.
10. **Viewer stack:** Preact SPA, for the 80 KB budget.
11. **The 30-minute Claude Code artifacts test:** skipped; the direction is set.
12. **Who can read `me` data in an artifact without a backend:** that person, plus the publisher and admins through the CLI, with the viewer saying so (§7.9). Confirmed 2026-10-30.
13. **CLI install channel:** an install script that downloads the binary from GitHub Releases, plus `bun add -g @artifacts/cli`. Homebrew later.
