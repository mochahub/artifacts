# 06 · The viewer (web app)

The viewer is a website, used mostly in Safari on an iPhone and in desktop browsers. It isn't a native app.
- **Visual source of truth:** the mock boards in [`docs/mocks/boards/`](../mocks/boards/), reviewed on the canvas (see [HANDOFF.md](HANDOFF.md#the-mocks-and-the-review-canvas)).
- **Behaviour:** SPEC §5.
- **Data:** the API in [03-api.md](03-api.md).

## Stack

- **Preact** with `@preact/signals` and `preact-iso` (router and lazy routes). Built with Vite into `apps/viewer/dist`, which `apps/server` serves.
- **No CSS framework.** Plain CSS with custom properties, ported from `docs/mocks/kit.css`: tokens, components and the rules below. The mocks' `kit.css` and `kit.js` are the reference implementation of the look; rebuild their components as Preact components with the same class names where practical.
- **Budget:** the initial route's JS is ≤ 80 KB gzipped; the canvas and article views are lazy chunks. CI fails over budget (`bun run size`).
- **Icons:** Lucide icons (MIT), imported per icon. The mocks' inline SVG paths are close to Lucide's.

## Design rules (keep the look, avoid generic patterns)

**The look:**
- The canvas is dark (`#1b1d22` with a faint dot grid); pages are light or dark following the system.
- Titles use the system serif (New York on Apple, `ui-serif`); everything else uses the system UI font.
- Floating bars and sheets use translucent material, as in the mocks.

**Colour has two jobs:**
- **Yellow `#ffd84d`** is a person's mark: comment pins, highlighted commented text, open counts, the Resolve and Post buttons.
- **Blue `#2b8cd6`** is an agent's change: version numbers, "Changed in v5", changed-frame outlines, changed-paragraph dots, agent replies.

**Forbidden:** the user rejected these patterns, so they must not appear:
- a coloured bar down the edge of a card, thread or quote
- sparkle icons for AI or agents, and initials in a coloured square (agents sign with a blue pencil in a soft disc)
- tinted pill backgrounds on word labels (labels are coloured words; only numeric counts get a filled badge: yellow for open marks, blue for agent counts)
- middle dots joining text ("A · B"; use commas or separate lines)
- "›" or "→" appended to link text (a version range like "v4 → v5" is fine)
- gradient washes as decoration

**Mock details not to copy:** the gradient fade under the guest landing photo (board 05, screen 2); the `.fadeb` gradient under the tab bar in `kit.css`; the middle dots in board captions ("1 · Review"), which are board labels, not product UI. Use a plain edge or a solid surface instead.

**Copy:** sentence case; plain verbs. A button says what happens ("Request changes", "Copy invite link"), and the result uses the same verb.

## Routes

| Path | Screen (board · screen) |
|---|---|
| `/` | Review home (01·1; desktop 04·3) |
| `/projects` | Projects (01·2). `?team=<slug>` filters to a team's. |
| `/activity` | Activity (05·5) |
| `/search` | Search: artifacts, pages and comments (also ⌘K) |
| `/:project` | A project: search, sort, filter tabs All / Your turn / Approved / Archived (01·3, 07·4), with its access as a label, and a Share sheet for those who manage it. It's a sheet and not `/:project/access`, which would collide with artifact slugs. |
| `/:project/:artifact` | The artifact and its pages (01·4) |
| `/:project/:artifact/:page` | A page: canvas (02) or article (03); `?v=5` pins a version; `#frame=live-view`; `?c=<thread n>` opens a thread |
| `/:project/:artifact/v/:n` and `/:project/:artifact/v/:n/:page` | Same as above, pinned to version n (SPEC §5.1 links) |
| `/:project/:artifact/compare?from=4&to=5` | Compare (02·6) |
| `/s/:token` | Share link landing: name entry, then the artifact (05·2) |
| `/join/:token` | Accept an invite (06·6) |
| `/reset/:token` | Set a new password |
| `/device` | Approve the CLI: type the code the CLI printed (06·7) |
| `/device/connect` | Connect an app: the OAuth consent screen, under an already reserved word |
| `/sign-in` | Sign in (06·2) |
| `/settings` | Settings index |
| `/settings/sign-in` | Passkeys, Google, password, sessions (06·3) |
| `/settings/google` | Google sign-in, for admins: redirect URIs, client, Test, on or off, Workspace auto-join |

| `/settings/notifications` | Web Push on this device |
| `/settings/people` | People and invites (06·4, 06·5, 06·8) |
| `/settings/teams`, `/settings/teams/:slug` | Teams: the list, and one team's members, leads and what's shared with it. Members and up. |
| `/settings/domains` | Domains, read-only (06·9) |
| `/settings/deleted` | Recently deleted (07·3) |
| `/settings/tokens` | Org tokens (admins) |
| `/settings/org` | Org name, default visibility, what new projects start as, link sharing, limits |

**Reserved project slugs**, refused by the schema: `api`, `s`, `t`, `join`, `reset`, `device`, `sign-in`, `settings`, `projects`, `activity`, `search`, `setup`, `assets`, `internal`, `well-known`, `favicon.ico`, `manifest.webmanifest`, `sw.js`. A page id of `compare` is refused too, because `/:project/:artifact/compare` is the compare screen.

In setup mode, every route renders the "Almost ready" page (06·1).

## Screens, by board

### 01 · Find and open
1. **Review (home).**
   - **Data:** `GET /api/home`.
   - **Card:** cover thumbnails, title, "<agent> published vN, <time>", then coloured word counts: blue "3 frames changed" and "4 replies to you", yellow "5 open".
   - **Below:** recently viewed.
   - **Tab bar** (Review with a count badge, Projects, Activity, Search) floats above Safari's bar.
2. **Projects.** Search field, then rows with an initials tile (neutral, not per-project colours), artifact count and time, and a yellow count badge for open comments.
3. **A project.** Search, sort (Recent / Name), filter tabs, and a grid of artifact cards (cover, title, page count or kind, status word: Waiting on you, With Claude, Approved v2, Not reviewed yet). Status is computed (02 "Derived state").
4. **An artifact and its pages.**
   - **Header:** title, description, "vN by <agent>, <time>" and the status.
   - **"What changed in vN"** as plain text with a blue heading.
   - **"N pages"** list with blue dots for changed pages and yellow counts.
   - **Primary:** "Review changes" (opens the first changed page at its first change). Secondary: Approve.
5. **Page switcher.** Opened from the title bar on any page: a sheet listing every page grouped as in the manifest, with changed dots and open counts.
6. **Version history.** A sheet listing versions: number, name or date, who. Tapping a row expands it to Restore, Compare and Name. The current version is marked; approved ones say "Approved".

### Wikis
A project whose kind is `wiki` opens a lazy wiki home, outside the initial JS budget. It polls `GET /api/wikis/:slug` every minute: rules, title and summary search, pages, sources newest first, findings grouped by kind, and recent changes. Rows use the existing type, agent words and comment counts. Wiki audiences use server-derived labels; sharing uses the project share sheet.

A wiki artifact with one page replaces its overview route with that page. Wiki articles fetch their links once per version, show a plain untrusted line near the top, and end with Sources and Linked from. Missing outgoing pages have dashed underlines and “Not written yet” titles. Wanted findings name the missing slug and link to the pages asking for it. The projects list labels wikis in its secondary text.

### 02 · Canvas review
1. **Overview.**
   - **Layout:** all boards on the canvas; board titles above each; frames as images.
   - **Changed frames:** blue outline.
   - **Pins:** yellow numbered pins.
   - **Title bar:** a floating capsule with the menu, page and artifact title, "v5" in blue, Share.
   - **Bottom toolbar:** Move, Comment | Frames, Comments (count).
2. **One frame.** Double-tap fits a frame; swipe for the next. "Try it" (Phase 2) in the title bar swaps in the live frame. Resolved pins turn grey.
3. **Comment.**
   - **Placing a pin:** Comment mode, then tap a spot to place a draft pin.
   - **The sheet:** sits on the keyboard, positioned with `visualViewport`, and never covers the toolbar.
   - **Panning:** the canvas pans so the pin stays visible above the sheet.
4. **Agent reply.** The thread sheet: the pin number, the frame name, "Fixed in v5" in blue; the comments; the crop of the changed area with "Compare v4 and v5"; then Reply and Resolve.
5. **Frames.** A sheet with All / Open / Changed tabs; rows with a thumbnail, name, blue dot and yellow count.
6. **Compare** (Phase 2). Side by side / Swipe / Changes. Changes outlines each changed region in blue with a numbered marker, plus the agent's `--note` text.

### 03 · Read and annotate
1. **Reading.** Serif column (about 68 characters); a banner offering "N sections changed since you read vK" with Show; title, meta; content.
2. **Changes and tables.**
   - **Changes:** with Changes on, edited paragraphs get a blue dot in the margin.
   - **Tables:** they scroll sideways.
   - **Commented passages:** highlighted yellow, with the comment number in the margin.
3. **Comment on a passage.** Select text: Safari's own menu stays above the selection; the viewer shows its own yellow **Comment** button below it. (A website can't add to Safari's selection menu.) Or tap Comment in the toolbar, then a paragraph.
4. **The quote travels.** The comment sheet shows the quoted text in quotation marks, then the field.
5. **Contents.** The outline sheet with reading progress, changed dots and open counts.
6. **Embeds and settings.** An embedded canvas frame opens in the canvas. The Aa popover sets text size, theme (Light / Dark / Auto) and typeface (Serif / Sans), remembered per device in `localStorage`.

### 04 · Desktop
1. **Canvas on desktop:** a left rail of pages; the canvas; a right panel of comments (Open / Fixed / Resolved). Selecting a thread flies to its pin. Keyboard shortcuts per SPEC §5.2.
2. **Article on desktop:** an outline rail; the article; threads in the right margin beside their passages; "Changes since v3" picks the comparison base.
3. **Home on desktop:** a left rail with Review, Activity and projects; ⌘K search; a "waiting on you" card grid; recently viewed as a table; an Activity column.

### 05 · Share, decide, get notified
1. **Share:** who has access: Org or Only people added (Project inside a restricted project, since names vary in length and the segment has to fit), then one field that finds people and teams, or takes an address for an outside invite. Each row says where its access came from: a team links to its page, and inherited rows can't be edited here. Levels are always the same words: Can view, Can comment, Can publish, Can manage. A team an agent added can be confirmed in place. The same sheet serves a whole project, and restricting one first says who loses access, how many links and invites stay live, with an option to revoke them, and which organization tokens stop reaching it. In a restricted project, links and outside invites show only for its managers. Below that: link permission (View / View and comment), expiry, "Copy link"; live links, each revoked by its own row (links are stored hashed, so one can't be shown again).
2. **A guest arrives:** the cover; "Zahin shared this with you"; title, description, a "Your name" field, then "Start reviewing".
3. **Decide:** Approve or Request changes, a note field, the open comments that will go with it, and "Request changes". Fine print: "Claude sees this the next time it runs `artifacts status`". After Request changes, the sheet stays open with "Copy prompt for your agent".
4. **Notifications** (Phase 2): an iOS lock-screen example.
5. **Activity:** All / Agents / People; grouped by day.
6. **Install** (Phase 2): asked once after the first comment: "Tap ⋯ then Share, then Add to Home Screen". Verify the Safari menu path on a real iPhone; it's an open item.
7. **Copy prompt for your agent:** on the Open tab of the comments sheet and panel while anything is open, and after Request changes, for people who can decide. It copies three lines: address the open comments on `<project>/<slug>` with the artifacts skill, `artifacts pull` if the source isn't in the repo, and the link. It never includes comment text, because guests can write comments and pasted text reads as the person's own instructions. If the copy fails, the prompt appears to select by hand.
8. **The agent's side:** terminal reference for `status`, `comments`, `publish` and `reply` (CLI, 07).

### 06 · Setup, sign-in and people
1. **Setup mode:** "Almost ready" with the `artifacts setup <url>` command and Copy.
2. **Sign in:** "Sign in with a passkey" first, then Continue with Google when it's on, then email and password. No sign-up. "Forgot your password? Ask an admin for a reset link." Google is a link, not a form, and the result comes back as `?google=`.

3. **Sign-in settings:** passkeys (name, added, last used), Add a passkey (recent auth), Change password, "Signed in on" (sessions and CLI tokens, with End).
4. **People:**
   - **Tabs:** Organization N / Outside N.
   - **Rows:** members with role.
   - **Invited:** pending invites, each with Copy (the link again) and revoke.
5. **Invite:** email, role (Member / Reviewer / Admin), then "Copy invite link" (no email is sent).
6. **Accept:** "<name> invited you as a reviewer"; your name, email (fixed); "Create a passkey", Continue with Google when it's on, or "Use a password instead".

7. **Approve the CLI:** the code, the client and agent, what it can do, Approve or Deny.
8. **Reset a password:** in a person's sheet, "Copy reset link" (one hour). "Remove Jo from Mochahub" is plain text, with a confirmation.
9. **Domains:** viewer domains (primary for links, home for passkeys) and Live previews (the content domain), read-only, with the browser-support note.
10. **The CLI is the way in:** terminal reference (07).

### 07 · Archive and delete
1. The artifact menu: Share, Version history; Archive (explains read-only), Delete (red; explains Recently deleted).
2. The delete sheet: what will be erased (versions and pages, comments, saved data and backend, share links that stop now), then Delete and "Archive instead".
3. Recently deleted (`/settings/deleted`): rows with "N days left" and Restore; "Delete all now" (recent auth).
4. A project's Archived filter.
5. An archived artifact: the banner "Archived by you on Oct 3. Read-only." with Unarchive; commenting is off.
6. A deleted link: "This artifact was deleted" with the date only; no title, no names.
7. The agent's side: terminal reference (07).

## The canvas engine (`apps/viewer/src/canvas/`)

- **World and transform:**
  - **World:** boards laid out left to right with 80 px gaps (canvas `pages.meta.boards` and frame `x, y, w, h`). On a tall screen the viewer wraps them into two columns, as board 02 draws it. Anchors are per frame, so this only moves them on screen.
  - **One transformed layer:** a single container with `transform: translate(x,y) scale(s)`. Frames are absolutely positioned `<img>` elements.
- **Level of detail, picked per frame from its on-screen size:**
  - under 120 CSS px wide: `thumb`
  - otherwise `1x` × device pixel ratio, rounded up to `1x`, `2x` or `3x`
  - the new image swaps in only after `decode()`, so frames never flash blank and look the same mid-pan (SPEC §1)
- **Virtualization:** frames more than one screen outside the viewport keep only their thumb in DOM; at most 40 full-resolution images are decoded at once. That bounds memory for 26-frame boards on an iPhone.
- **Gestures:**
  - **Pointer Events,** with `touch-action: none` on the canvas.
  - **Touch:** one finger pans, two fingers pinch around their midpoint, double-tap zooms to fit the tapped frame (or back out), and inertia uses the last 100 ms of velocity.
  - **Desktop:** the wheel pans, and ⌘ or Ctrl with the wheel (or a trackpad pinch, `ctrlKey` wheel events) zooms.
- **Pins:**
  - **Placement:** positioned at the frame's `x + ax·w, y + ay·h`, in a separate un-scaled overlay, so pins stay 20 px at any zoom.
  - **Hit area:** 44 px.
  - **Grey pins:** resolved.
  - **Drafts:** a white pin with "+".
- **Sheets:** bottom sheets with detents (medium, large). The comment sheet sits on top of the keyboard using `visualViewport.height` and `offsetTop`, and the canvas animates so the pin stays above the sheet.
- **URL state:** `#frame=<key>` and `?c=<n>` update with `history.replaceState`; opening such a URL flies to the frame or thread.

## The article view (`apps/viewer/src/article/`)

**Never trust stored HTML.** The viewer only loads article HTML that the server re-sanitized at commit ([05](05-publish-and-storage.md#building-articles-cli)). The viewer's CSP is the second layer, not the first.

- **Rendering:** fetch the sanitized HTML (03), insert it, then decorate:
  - attach comment counts to `[data-block]`
  - highlight anchored quotes with the CSS Custom Highlight API where available, falling back to `<mark>` wrapping
  - mark changed blocks with a blue dot
- **Text-quote comments:** take the selection, find its block and character offsets, and build `{ exact, prefix (32 chars), suffix (32 chars) }`.
- **Reading position:** per page, sent with `POST /seen` at most every 10 seconds.
- **Settings:** size, theme and typeface in `localStorage` per device.

## The editor (`apps/viewer/src/editing/`)

Editing wiki pages in the browser (Phase 2 Part B). The contract is [13-editing.md](13-editing.md#viewer), and the design is the hosted canvas `artifacts/phase-2b-editing-design`.

- **Two chunks:**
  - `entry.tsx` sits in the article chunk. It fetches `DocState`, draws the yellow Edit key at the end of the reader's bar, Ask to edit for people who can only comment, and the draft line for editors. It also draws the blue pencil in the reader.
  - `editor.tsx` is the lazy `editor` chunk, fetched on the first tap on Edit or with `?edit=1`. It holds ProseMirror, y-prosemirror, Yjs, `@artifacts/doc` (the schema and the id plugin, by subpath, never the Markdown converters) and the provider. `bun run size` checks it against its own 120 KB budget, beside the reader's 80 KB.
- **Sync:** `sync.ts` is the one door to `provider.ts` (`connect(artifactId, epoch, ydoc, awareness)`). Without a connection the editor still edits locally and says "Offline. Your changes will sync."
- **Plugins** (`plugins.ts`):
  - **Author:** marks what the person types with the author key from `hello`. Text never carries the mark of the words beside the caret, which may be an agent's. While an IME composes, it waits until the composition ends.
  - **Presence:** the caret's block and the blocks changed in the last two seconds go into awareness as `block` and `pending`. The server holds those blocks against agent replaces.
  - **Pencil:** an underline on text whose author key is an agent's, from `GET …/authors?draft=1`.
  - **Suggestions:** a card under the block each one changes. It shows the old words struck and the new ones in the blue pencil, then the note, then Reject and Accept, 44 pt tall and 12 pt apart. A suggestion's HTML is parsed for its words only, and is never put on the page.
- **The screen:**
  - **Phone:** Done, who is here, Saved, and More. The mode switch (Write, Pair, Delegate) sits under the bar, with the current mode underlined and the audience on the right. While the keyboard is up, the mode folds into the toolbar's first key.
  - **Desktop:** the modes are centred in the bar, beside Save version. The tools sit in a row under the bar, with the audience line on the right.
- **Toolbar:** heading, bold, italic, list, `[[` and link, then undo. Every key is at least 44 pt (40 pt on a desktop). On a phone it is fixed above the keyboard: `visualViewport` gives the covered height as `--kb`.
- **Delegate:** Start sends `POST …/doc/runs` with the goal. A strip at the foot says "Claude is working on this page", with Stop. When a suggestion run finishes, its review lists each change as a word diff with its sources. Each change can be reverted (that rejects it), or all of them can be reverted, or they can be kept (`…/runs/:id/accept`). A direct run links to compare its checkpoint.
- **Attribution:** `wiki/attribution.tsx` maps `blocks.authors` offsets (the block's text, whitespace collapsed) onto the DOM, the way quote highlights are mapped. It wraps agents' passages in the pencil. Tapping or clicking a passage shows who wrote it, for whom, when, which version, and its sources, with untrusted ones marked. That is a sheet on a phone and a popover on a desktop.
- **Keys:** ⌘B, ⌘I, ⌘S (Save version), ⌥↑ and ⌥↓ (move a block), ⌘⌥Y and ⌘⌥N (accept or reject the suggestion at the caret), and Esc (leave). The page is `role="textbox"` with `aria-multiline` and a label. The toolbar is `role="toolbar"` and arrow keys move along it. New suggestions are announced in a polite live region.

## Live frames and the bridge

See [08-micro-apps.md](08-micro-apps.md#try-it). Phase 2.

## Polling, realtime and the service worker

- **MVP polling:** poll with ETags: the open artifact's threads and versions every 10 seconds while the tab is visible; home and lists every 60 seconds.
- **Phase 2 realtime:** an open artifact uses `GET /api/events` (SSE) and refreshes on each event. With a stream open, its fast polls drop to one a minute as a safety net.
- **Service worker** (Phase 2, with the install prompt):
  - caches the app shell, plus renders and article HTML of versions you've opened (cache-first, since they're immutable). Renders are fetched with `?via=app`, because a bucket's answer can't be read without CORS. Video and audio aren't kept.
  - fetches API calls network-first, with the last response kept for offline reading. Search, sessions, sign-in answers, and anything that lists other people (people, tokens, invites, who an artifact is shared with, its saved data and files) are never kept.
  - keeps at most 1,500 files and 300 API answers, oldest out first
  - forgets everything but the app when the artifact or the session says this device has no access (401, 403, 404, 410), and at sign-out. A revoked device keeps its copies only until it next reaches the server.
  - handles Web Push

## Accessibility and Safari specifics

- **Touch and layout:** touch targets of at least 44 pt; safe-area insets; nothing hover-only; inputs at least 16 px so Safari doesn't zoom on focus.
- **Accessible names:** pins and frames have them ("Comment 3 on Live view"); sheets trap focus and close with Escape; the canvas has a "Frames" list as its keyboard and screen-reader route.
- **Safari's bar:** pages can sit under Safari's bottom bar, so fixed bottom UI uses `env(safe-area-inset-bottom)` and is checked on a real iPhone (user-only acceptance, see 10).
- **Contrast:** WCAG AA for text in both themes. Yellow text on white isn't used; light theme uses `#8a6a00` for yellow words.

## Native board integration

Native checkpoint scenes use the lightweight board reader; Edit lazily loads the board editor,
Yjs provider and drawing controls. Fit includes canonical objects and suggestion ghosts, including
both poses when a suggestion moves an existing object. Ghost parent and connector bindings resolve
against the proposed scene. Captures still use only the canonical snapshot fenced by the server.
Run and checkpoint socket messages refresh author records as well as board state.

Board acceptance tests create a separate wiki and board for each test through the real API, seed
objects with board operations, checkpoint them, and use the real WebSocket transport. They do not
intercept HTTP or WebSocket responses. Coverage includes checkpoint reading without eager editor
loads, bound arrows, concurrent writers, keyboard movement/deletion/undo, tool hit areas, reduced
motion, pen/palm ownership, touch drawing/pinching, Pair acceptance, attribution, object comment
pins after checkpointing a move, and a signed-in commenter without draft access.

For an isolated board run, set `E2E_BOARDS_ONLY=1` and invoke Playwright directly with `boards`.
Start private storage first and supply `E2E_DATABASE_URL`, `E2E_S3_ENDPOINT` and `E2E_PORT`.
A Linux Playwright container can use an independently started server with
`E2E_EXTERNAL_SERVER=1` and `E2E_HOST`. `E2E_AUTH_FILE`, `E2E_TOKEN_FILE` and `E2E_OUTPUT_DIR`
isolate credentials and traces from another runner. Claim once, then use `--no-deps` for focused
checks. Long runs using `--repeat-each=10` can exhaust the real per-caller rate limits; provision
fresh private server instances per repetition rather than disabling the rate checks. The intermittent startup stall in the forwarded Linux harness was traced to TCP client-port reuse
in Docker Desktop's host forwarder. `bun run e2e:linux` keeps the app and browser together on Linux
loopback and uses a fresh private compose stack per invocation. The normal acceptance suite retains
its legacy fixture setup.

`bun run size` (also `bun apps/viewer/scripts/board-size.ts`) checks the reader entry's complete static
import closure plus CSS against 80 KB gzip. Article Edit and board Edit are measured separately,
including every additional static JS/CSS dependency beyond their respective readers, with the shared
sync provider included in each cold load. Their limits remain 120 KB and 160 KB. The final November
2026 build measures 59.81 KB for the entry, 118.42 KB for article Edit and 53.08 KB for board Edit.

The real Delegate regression requires a finished run in board state, including the permitted finished
review data after returning to the board; it passes in native Linux acceptance.
Synthetic pointer tests do not replace physical Pencil pressure, latency, palm rejection or Scribble QA.
