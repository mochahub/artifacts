# 06 · The viewer (web app)

The viewer is a website, used mostly in Safari on an iPhone and in desktop browsers. It isn't a native app.
- **Visual source of truth:** the mock boards in [`docs/mocks/boards/`](../mocks/boards/), reviewed on the canvas (see [HANDOFF.md](HANDOFF.md#the-mocks-and-the-review-canvas)).
- **Behaviour:** SPEC §5.
- **Data:** the API in [03-api.md](03-api.md).

## Stack

- **Preact** with `@preact/signals` and `preact-iso` (router and lazy routes). Built with Vite into `apps/viewer/dist`, which `apps/server` serves.
- **No CSS framework.** Plain CSS with custom properties, ported from `docs/mocks/kit.css`: tokens, components and the rules below. The mocks' `kit.css` and `kit.js` are the reference implementation of the look; rebuild their components as Preact components with the same class names where practical.
- **Budget:** the initial route's JS is ≤ 80 KB gzipped; the canvas and article views are lazy chunks. CI fails over budget (`size-limit`).
- **Icons:** Lucide icons (MIT), imported per icon. The mocks' inline SVG paths are close to Lucide's.

## Design rules (keep the look, avoid generic patterns)

**The look:**
- The canvas is dark (`#1b1d22` with a faint dot grid); pages are light or dark following the system.
- Titles use the system serif (New York on Apple, `ui-serif`); everything else uses the system UI font.
- Floating bars and sheets use translucent material, as in the mocks.

**Colour has two jobs:**
- **Yellow `#ffd84d`** is a person's mark: comment pins, highlighted commented text, open counts, the Resolve and Post buttons.
- **Violet `#8f7cff`** is an agent's change: version numbers, "Changed in v5", changed-frame outlines, changed-paragraph dots, agent replies.

**Forbidden:** the user rejected these patterns, so they must not appear:
- a coloured bar down the edge of a card, thread or quote
- sparkle icons for AI or agents (agents sign with initials in a violet rounded square: "Cl" for Claude, "Cx" for Codex)
- tinted pill backgrounds on word labels (labels are coloured words; only numeric counts get a filled badge: yellow for open marks, violet for agent counts)
- middle dots joining text ("A · B"; use commas or separate lines)
- "›" or "→" appended to link text (a version range like "v4 → v5" is fine)
- gradient washes as decoration

**Mock details not to copy:** the gradient fade under the guest landing photo (board 05, screen 2); the `.fadeb` gradient under the tab bar in `kit.css`; the middle dots in board captions ("1 · Review"), which are board labels, not product UI. Use a plain edge or a solid surface instead.

**Copy:** sentence case; plain verbs. A button says what happens ("Request changes", "Copy invite link"), and the result uses the same verb.

## Routes

| Path | Screen (board · screen) |
|---|---|
| `/` | Review home (01·1; desktop 04·3) |
| `/projects` | Projects (01·2) |
| `/activity` | Activity (05·5) |
| `/:project` | A project: search, sort, filter tabs All / Your turn / Approved / Archived (01·3, 07·4) |
| `/:project/:artifact` | The artifact and its pages (01·4) |
| `/:project/:artifact/:page` | A page: canvas (02) or article (03); `?v=5` pins a version; `#frame=live-view`; `?c=<thread n>` opens a thread |
| `/:project/:artifact/v/:n` | Same as above, pinned to version n (SPEC §5.1 links) |
| `/:project/:artifact/compare?from=4&to=5` | Compare (02·6) |
| `/s/:token` | Share link landing: name entry, then the artifact (05·2) |
| `/join/:token` | Accept an invite (06·6) |
| `/reset/:token` | Set a new password |
| `/device` | Approve the CLI: type the code the CLI printed (06·7) |
| `/sign-in` | Sign in (06·2) |
| `/settings` | Settings index |
| `/settings/sign-in` | Passkeys, password, sessions (06·3) |
| `/settings/people` | People and invites (06·4, 06·5, 06·8) |
| `/settings/domains` | Domains, read-only (06·9) |
| `/settings/deleted` | Recently deleted (07·3) |
| `/settings/tokens` | Org tokens (admins) |
| `/settings/org` | Org name, default visibility, link sharing, limits |

**Reserved project slugs**, refused by the schema: `api`, `s`, `t`, `join`, `reset`, `device`, `sign-in`, `settings`, `projects`, `activity`, `setup`, `assets`, `internal`, `well-known`, `favicon.ico`, `manifest.webmanifest`, `sw.js`.

In setup mode, every route renders the "Almost ready" page (06·1).

## Screens, by board

### 01 · Find and open
1. **Review (home).**
   - **Data:** `GET /api/home`.
   - **Card:** cover thumbnails, title, "<agent> published vN, <time>", then coloured word counts: violet "3 frames changed" and "4 replies to you", yellow "5 open".
   - **Below:** recently viewed.
   - **Tab bar** (Review with a count badge, Projects, Activity, Search) floats above Safari's bar.
2. **Projects.** Search field, then rows with an initials tile (neutral, not per-project colours), artifact count and time, and a yellow count badge for open comments.
3. **A project.** Search, sort (Recent / Name), filter tabs, and a grid of artifact cards (cover, title, page count or kind, status word: Waiting on you, With Claude, Approved v2, Not reviewed yet). Status is computed (02 "Derived state").
4. **An artifact and its pages.**
   - **Header:** title, description, "vN by <agent>, <time>" and the status.
   - **"What changed in vN"** as plain text with a violet heading.
   - **"N pages"** list with violet dots for changed pages and yellow counts.
   - **Primary:** "Review changes" (opens the first changed page at its first change). Secondary: Approve.
5. **Page switcher.** Opened from the title bar on any page: a sheet listing every page grouped as in the manifest, with changed dots and open counts.
6. **Version history.** A sheet listing versions: number, name or date, who. Tapping a row expands it to Restore, Compare and Name. The current version is marked; approved ones say "Approved".

### 02 · Canvas review
1. **Overview.**
   - **Layout:** all boards on the canvas; board titles above each; frames as images.
   - **Changed frames:** violet outline.
   - **Pins:** yellow numbered pins.
   - **Title bar:** a floating capsule with the menu, page and artifact title, "v5" in violet, Share.
   - **Bottom toolbar:** Move, Comment | Frames, Comments (count).
2. **One frame.** Double-tap fits a frame; swipe for the next. "Try it" (Phase 2) in the title bar swaps in the live frame. Resolved pins turn grey.
3. **Comment.**
   - **Placing a pin:** Comment mode, then tap a spot to place a draft pin.
   - **The sheet:** sits on the keyboard, positioned with `visualViewport`, and never covers the toolbar.
   - **Panning:** the canvas pans so the pin stays visible above the sheet.
4. **Agent reply.** The thread sheet: the pin number, the frame name, "Fixed in v5" in violet; the comments; the crop of the changed area with "Compare v4 and v5"; then Reply and Resolve.
5. **Frames.** A sheet with All / Open / Changed tabs; rows with a thumbnail, name, violet dot and yellow count.
6. **Compare** (Phase 2). Side by side / Swipe / Changes. Changes outlines each changed region in violet with a numbered marker, plus the agent's `--note` text.

### 03 · Read and annotate
1. **Reading.** Serif column (about 68 characters); a banner offering "N sections changed since you read vK" with Show; title, meta; content.
2. **Changes and tables.**
   - **Changes:** with Changes on, edited paragraphs get a violet dot in the margin.
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
1. **Share:** link permission (View / View and comment), expiry, "Copy link"; live links, each revoked by its own row (links are stored hashed, so one can't be shown again); people with access.
2. **A guest arrives:** the cover; "Zahin shared this with you"; title, description, a "Your name" field, then "Start reviewing".
3. **Decide:** Approve or Request changes, a note field, the open comments that will go with it, and "Request changes". Fine print: "Claude sees this the next time it runs `artifacts status`".
4. **Notifications** (Phase 2): an iOS lock-screen example.
5. **Activity:** All / Agents / People; grouped by day.
6. **Install** (Phase 2): asked once after the first comment: "Tap ⋯ then Share, then Add to Home Screen". Verify the Safari menu path on a real iPhone; it's an open item.
7. **The agent's side:** terminal reference for `status`, `comments`, `publish` and `reply` (CLI, 07).

### 06 · Setup, sign-in and people
1. **Setup mode:** "Almost ready" with the `artifacts setup <url>` command and Copy.
2. **Sign in:** "Sign in with a passkey" first, then email and password. No sign-up. "Forgot your password? Ask an admin for a reset link."
3. **Sign-in settings:** passkeys (name, added, last used), Add a passkey (recent auth), Change password, "Signed in on" (sessions and CLI tokens, with End).
4. **People:**
   - **Tabs:** Organization N / Outside N.
   - **Rows:** members with role.
   - **Invited:** pending invites, each with Copy (the link again) and revoke.
5. **Invite:** email, role (Member / Reviewer / Admin), then "Copy invite link" (no email is sent).
6. **Accept:** "<name> invited you as a reviewer"; your name, email (fixed); "Create a passkey" or "Use a password instead".
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
  - mark changed blocks with a violet dot
- **Text-quote comments:** take the selection, find its block and character offsets, and build `{ exact, prefix (32 chars), suffix (32 chars) }`.
- **Reading position:** per page, sent with `POST /seen` at most every 10 seconds.
- **Settings:** size, theme and typeface in `localStorage` per device.

## Live frames and the bridge

See [08-micro-apps.md](08-micro-apps.md#try-it). Phase 2.

## Polling, realtime and the service worker

- **MVP polling:** poll with ETags: the open artifact's threads and versions every 10 seconds while the tab is visible; home and lists every 60 seconds.
- **Phase 2 realtime:** an open artifact uses `GET /api/events` (SSE) and refreshes on each event. With a stream open, its fast polls drop to one a minute as a safety net.
- **Service worker** (Phase 2, with the install prompt):
  - caches the app shell, plus renders and article HTML of versions you've opened (cache-first, since they're immutable). Renders are fetched with `?via=app`, because a bucket's answer can't be read without CORS. Video and audio aren't kept.
  - fetches API calls network-first, with the last response kept for offline reading. Search, sessions and sign-in answers are never kept.
  - keeps at most 1,500 files and 300 API answers, oldest out first
  - forgets everything but the app when the artifact or the session says this device has no access (401, 403, 404, 410), and at sign-out. A revoked device keeps its copies only until it next reaches the server.
  - handles Web Push

## Accessibility and Safari specifics

- **Touch and layout:** touch targets of at least 44 pt; safe-area insets; nothing hover-only; inputs at least 16 px so Safari doesn't zoom on focus.
- **Accessible names:** pins and frames have them ("Comment 3 on Live view"); sheets trap focus and close with Escape; the canvas has a "Frames" list as its keyboard and screen-reader route.
- **Safari's bar:** pages can sit under Safari's bottom bar, so fixed bottom UI uses `env(safe-area-inset-bottom)` and is checked on a real iPhone (user-only acceptance, see 10).
- **Contrast:** WCAG AA for text in both themes. Yellow text on white isn't used; light theme uses `#8a6a00` for yellow words.
