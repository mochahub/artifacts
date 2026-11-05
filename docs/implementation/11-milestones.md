# 11 · Build order: spikes and milestones

Build in vertical slices. Each milestone ends with something working end to end, its tests green, and a short report to the user. **Stop at each milestone boundary and check in before starting the next.** Phase 1 is M1–M8; Phase 2 is M9–M11.

Each milestone lists:
- **Build:** what to make
- **Agent checks:** what the building agent verifies itself
- **User checks:** what only the user can verify; prepare these and ask

## M0 · Verification spikes

Several design claims come from documentation and were never run. Test each before building on it. Write results to `docs/implementation/spikes.md`: what was tried, what happened, and what changes in the design. Spikes that need the user's Railway account or a real iPhone are prepared by the agent (scripts, steps) and run with the user's go-ahead; they create billable resources.

| Spike | Question | Design depends on it in | If it fails |
|---|---|---|---|
| **S1** Railway provisioning | Does `railway init` → `railway deploy --template <code>` provision a template that has an image service, Postgres and a bucket into the new project? Does the template give one service two generated domains (ports 8080 and 8081)? What variable names does a bucket expose? Do `${{secret()}}` functions work for image services? Which private hostnames do services get? | 07 setup, 09 template | Provision piece by piece with `railway add --image`, `railway add --database postgres`, `railway bucket create`, `railway domain --port`, `railway variable set`. All are in Railway CLI 5.71.0's help. |
| **S2** Passkeys across domains | On a real iPhone (iOS 18+) and in desktop Chrome: does a passkey made on the home domain sign in on a second viewer domain via `/.well-known/webauthn`? Does the fallback (sign in on the home domain) work? | 04 passkeys | Make passkeys per domain (already supported: `passkeys.rp_id`), and drop the "carry over" promise from SPEC §7.3. |
| **S3** Conditional writes | Do Railway's bucket endpoint and the MinIO image honour `If-Match` and `If-None-Match: *` on `PutObject` (412 on mismatch)? Are presigned GETs cached by Safari as expected? | 08 data store | Use the advisory-lock path in 08 (already specified). |
| **S4** workerd worker loader | In a self-hosted workerd container: load a module from a string at runtime, cache by name, unload when idle. Can per-request bindings (`env.DATA` for one `dataKey`) be passed? Does `globalOutbound: null` block `fetch`? Are CPU and memory limits enforced? Can console output be captured? | 08 runner | Deno runner (08), same module contract. |
| **S5** Compiled Bun CLI | From a `bun build --compile` binary: can it drive Playwright WebKit installed under `~/.artifacts/playwright/`? Does `Bun.secrets` exist and work on macOS, Linux and Windows? Does sharp work under Bun (CLI and server)? | 07, 05 | Renderer as a subprocess script; platform keychain commands; a WebAssembly image library (`@jsquash/*`) for sharp. |
| **S6** Runner wake on Railway (moot: there's no runner service since 2026-10-30) | With Serverless on, does a private-network request wake the runner? How long does it take, and do the first requests 502? | 08, 09 | Keep the runner always on (adds RAM cost; update SPEC §7.5), or retry the first request in the app. |
| **S7** Codex skills folder | Where does Codex CLI load user skills from (the `CODEX_HOME` layout)? | 07 skill install | Install to the documented folder; print instructions otherwise. |
| **S8** Live frames in WebKit | In Playwright WebKit, can a `sandbox="allow-scripts"` iframe served from the content port load a module script, an `@font-face` font and a relative `fetch`, and call `api/`, with the CORS and CSP in 03? Does `'self'` match anything for an opaque origin? | 03 content host, 08 | Adjust the CSP sources and CORS headers until the test passes; record the working set in 03. |

**Agent checks:** S3 (MinIO half), S4, S5, S7 and S8 run locally, with results written up.
**User checks:** S1, S3 (Railway half) and S6 on their Railway account; S2 on their iPhone.

## M1 · Foundations

**Build:**
- **The monorepo** per [01](01-repo-and-tooling.md): workspaces, Biome, TypeScript configs, CI (`ci.yml`), and `deploy/compose/docker-compose.dev.yml` (Postgres and SeaweedFS).
- **`packages/schema`:** manifest (05), API types (03), message types (08), with zod.
- **`apps/server` skeleton:**
  - environment validation and the three ports with host routing (03)
  - JSON logging, request ids, the error format
  - `GET /api/health` and `/api/meta`
  - Drizzle schema for **all** Phase 1 tables in [02](02-data-model.md), with migrations at boot
  - the S3 client wrapper (put, get, head, list, delete, presign), with conditional-write support as found in S3
- **`apps/viewer` skeleton:** Vite, Preact, the router, and tokens ported from `docs/mocks/kit.css`; served by the server.

**Agent checks:** CI is green; `docker compose -f deploy/compose/docker-compose.dev.yml up` and `bun run dev` serve health on 8080 and 404 on 8081; migrations apply to an empty database twice without error.

## M2 · Setup, sign-in and the CLI skeleton

**Build:**
- Setup mode and `POST /api/setup`, `POST /api/recover` (04).
- Password sign-in, sessions, `GET /api/me`, sign-out, the sign-in page, the "Almost ready" page.
- `can()` with the actions needed so far, and the permission-matrix test scaffold.
- **CLI skeleton:** config, credentials (S5), `--json`, `setup --docker` (compose with generated `.env`), `setup <url>` (claim or device flow), `login`, `logout`, `whoami`, `doctor`.
- The device-flow API and the `/device` approval page.

**Agent checks:** a fresh `artifacts setup --docker` claims a local server; `whoami` works; the matrix test runs.
**User checks:** none yet; a short report.

## M3 · Publishing

**Build:**
- **`artifacts init`**, with the kit copied in. Start `packages/kit` from the CameraBuddy-style device frames (port from `docs/mocks/kit.js` and CameraBuddy's `mock.js`).
- **The bundle crawler** and **static lint rules** (files, ids, manifest, weight).
- **`artifacts render`:** WebKit, deterministic, three scales, thumbnails, the contact sheet and the OG image (05). Then **render-based lint**: overlap, clipping, home indicator, offscreen, deterministic, contrast.
- **The article pipeline:** blocks, sanitized HTML, embeds, Mermaid and charts.
- **Publish endpoints:** `prepare` and `commit`, with versions, pages, frames and blocks, and the change summary. **The CLI's `publish`**, with the output format in 07.
- **File serving:** render and file redirects (presigned GETs, rounded to the day), and the content host serving bundle files with its headers (03).

**Agent checks:**
- The CameraBuddy fixture publishes; publishing again uploads nothing and makes v2 with no changes.
- Changing one CSS file reports the right changed frames.
- Lint catches seeded overlap, clipping and nondeterminism examples.

## M4 · The viewer

**Build:**
- **Lists:** home, projects, a project (search, sort, filters), and the artifact page with pages and status.
- **The page switcher** and the **version picker**.
- **The canvas engine** (06): layout, level of detail, virtualization, gestures, frames list, deep links.
- **The article view:** outline, settings, changed-since-last-read.
- **Polling** with ETags.
- **Responsive layout** for desktop (board 04).

**Agent checks:**
- Playwright WebKit at iPhone size: pan, pinch (synthesized), double-tap fit, deep links.
- The size budget passes.
- Screenshots of each screen are laid next to the matching mock screens for the user.

**User checks:** the look against the mocks on a real iPhone.

## M5 · The review loop

**Build:**
- **Threads and comments** (API and UI): pins, the comment sheet over the keyboard, thread sheets, Fixed in vN, resolve and reopen.
- **Article comments:** quote comments and block comments, with highlights.
- **Crops**, and **re-anchoring** on publish (05).
- **Decisions** (Approve, Request changes) and the status endpoint.
- **CLI:** `status`, `comments`, `reply --fixed`.
- **Skill v1** (07), with `artifacts skill install`.

**Agent checks:** an automated round trip on the fixture:
1. Comment as a person.
2. Run an agent session script: `status`, `comments`, edit the source, `publish`, `reply --fixed`.
3. Resolve as a person.

Plus the re-anchoring unit tests.

**User checks:** one real round trip with Claude Code using the skill.

## M6 · People, passkeys and sharing

**Build:**
- **People:** org invites (roles), the people page, reset links, removing people, outside invites and `artifact_access`.
- **Visibility:** visibility and default visibility.
- **Share links:** guests (`art_guest`, `guest_links`), and the guest landing page.
- **Passkeys** (registration and sign-in), with `/.well-known/webauthn` and the fallback (04), plus the sign-in settings page.
- **Tokens:** the org tokens page.
- **Domains:** the domains page (read-only).
- **CLI:** `org invite`, `org reset-link`, `share`, `visibility`.
- **The full permission matrix test.**

**Agent checks:** the matrix is all green; Playwright passkey tests with a virtual authenticator (Chromium if WebKit lacks it); a guest flow e2e.
**User checks:** S2 on a real iPhone.

## M7 · Versions, lifecycle and activity

**Build:**
- **Version history:** name, preview and restore, with basic compare by hash (no pixel regions yet).
- **Archive and unarchive**, with read-only enforcement on every write path (03).
- **Delete, undelete and purge** for artifacts and single versions; the Recently deleted page; tombstones; the deleted-link page.
- **Activity:** the feed and its page.
- **Clean-up jobs:** purge, garbage collection and expiry (05).
- **CLI:** `versions`, `versions name`, `diff`, `restore`, `archive`, `delete`, `undelete`.

**Agent checks:**
- API tests for every lifecycle transition.
- GC deletes only unreferenced blobs older than a day.
- Purge removes data and crops.
- The slug rule holds.

## M8 · Distribution and Phase 1 acceptance

**Build:**
- Dockerfiles and the release workflow (09).
- The Railway template (with the user, after S1).
- The `artifacts setup` Railway path, `upgrade`, `domain`.
- `install.sh` and npm publishing.
- The README: install, setup, Docker, upgrading, backups.

**Agent checks:** a release dry run builds the images and binaries; a clean VM runs `install.sh` and then `artifacts setup --docker`, ending with a working server.
**User checks:** the Phase 1 acceptance list in [10](10-testing-and-acceptance.md#phase-1-acceptance), on their Railway account and iPhone.

## M9 · Micro apps I: Try it and the data store

**Build:**
- Content tokens and live frames: Try it on canvas frames and the `prototype` page kind.
- The bridge (08).
- The data API, with limits, usage, conditional writes, and files.
- `@artifacts/kit/data`, fixtures in render, and the dev data folder.
- `artifacts data`.
- The `data/*` lint rules, and the viewer notices ("Saved for you", "Its author can see what's saved").

**Agent checks:** the poll fixture works frontend-only; two people's `me` data stay separate; archived is read-only; limits are enforced; bridge security tests (messages from other windows are ignored).

## M10 · Micro apps II: backends

**Build:**
- **The sandbox** (08): QuickJS child processes, one capped WebAssembly instance per backend, the pool and its limits.
- **Backend publishing:** bundling, the backend lint rules, and `backend_hash`.
- **The content-port proxy**, `env.DATA` over IPC, and caller pseudonyms (`org.pseudonym_key`).
- **`artifacts logs`.**
- **Local backends** in `artifacts dev` and `render`.

**Agent checks:**
- Sandbox tests (10): isolation, no network, timeouts, memory, read-only for viewers and archived artifacts.
- The backend version of the poll fixture.
- Old versions run their own backend.

**User checks:** the app's memory on Railway with backends in use.

## M11 · Live review and the rest of Phase 2

**Build:**
- **Realtime:** SSE with `LISTEN/NOTIFY`.
- **Notifications:** Web Push with VAPID; the install prompt; the service worker (offline versions).
- **Compare:** pixel regions and Swipe.
- **The `gallery` page kind.**
- **⌘K search.**
- **An MCP server** wrapping the CLI's API calls.
- **OG unfurls.**
- **Phase 2 acceptance** ([10](10-testing-and-acceptance.md#phase-2-acceptance)).

## M12 · The hosted library

**Build:**
- **Frontmatter:** optional `summary` and `tags` in the manifest, stored per version, with the new `manifest/summary` lint error and a fallback for old versions.
- **Search:** Postgres full-text search over article text, frame titles, summaries, tags, version notes and comments, on each artifact's latest version, with body matches in ⌘K.
- **Disclosure tiers:** compact cards from `search` and `list`, paged `read`, and `view` with a thumbnail by default. `outcome` shows how the review ended.
- **Tools:** `search`, `list`, `read` and `view` in the CLI and the local MCP, which work without `artifact.json`.
- **Project matching:** normalized git remotes, and an optional `repo` on every tool.
- **Discovery:** a wider skill description, a step in `SKILL.md`, and `instructions` from the MCP.
- **Server-first storage:** `init` writes to the gitignored `.artifacts/work/<slug>/`, `--in-repo` keeps today's layout, and `artifacts pull` and `artifacts export` ship in the same stack.

**Agent checks:**
- An art style fixture of image-only frames: found by search from another folder, read as a card, viewed and pulled.
- Pull, then publish unchanged, makes no content change.
- Search permissions for hits, snippets and counts, across member, reviewer, outside, guest, organization token and CLI token.
- Search in a fresh clone with no `artifact.json`.
- A fixed maximum size per card, and 100 results across pages under a fixed budget.

## M13 · Templates, guides and theme

**Build:**
- **Kit:** navigation, tab bar, sheet, toggle and icons, plus article callouts, stats and comparisons that work from Markdown.
- **Templates:** design review, presentation, case study, PRD, RFC, research report and weekly status under `packages/kit/src/templates/`, copied by `artifacts init --template <name>`.
- **Guides:** one in `skill/references/templates/` per template.
- **Theme:** validated accent, neutrals, radius and type. The CLI turns them into tokens at render, and the viewer applies allowed values only inside the article body.

**Agent checks:** every template initializes, lints with no errors or warnings, renders and publishes; one accent change reaches every template; a malicious theme value can't inject CSS into the viewer; contact sheets in the pull request, looked at by the agent.
**User checks:** a taste review of the contact sheets on a phone.

## M14 · Brand setup

**Build:**
- `artifacts setup` ends with a prompt for fitting Artifacts to a brand guide.
- `artifacts brand` reads, previews and proposes an org brand, and publishes a sample artifact for review.
- A person applies a proposal in Settings. Tokens can't.
- The CLI fetches and caches the org brand for rendering, and a project's `theme` wins over it.
- Brand fonts ship in the bundle.

**Agent checks:** brand precedence, a stale cache, permissions, and an agent-driven run from a sample design guide to a reviewed sample.

## M15 · OAuth, hosted MCP and publishing

**Build:**
- **OAuth 2.1:** our server as its own authorization server, on the existing sign-in, with a consent screen, PKCE, audience-bound tokens, rotation and revocation.
- **Hosted MCP:** Streamable HTTP on `/api/mcp`, with the same server functions and `can()` as the API, and templates and guides as resources.
- **`artifacts mcp install`:** opt-in, for Claude Code and Codex.
- **Publishing through MCP:** `artifacts pack` renders on the client, files go straight to the bucket, and a commit payload is uploaded as a blob and committed by hash.

**Agent checks:** a scripted OAuth client, with the negative cases; the full loop through the hosted MCP on a box with no login; metadata per origin; guest text marked untrusted.
**User checks:** real Claude Code and Codex, connectors in remote sessions, and passkey consent on an iPhone.

## M16 · Articles without the CLI

**Build:**
- Article building moves to code the server shares.
- An MCP tool publishes Markdown with a required `summary`, with no CLI and no renderer.

**Agent checks:** publish from a client with no filesystem or shell, then read it through the viewer and `read`; an XSS payload is sanitized the same way as a CLI publish.

## M17 · Teams

**Build:**
- **Data:** `teams`, `team_members` and `artifact_team_access`, with grants expanded when an artifact is loaded and one `effective()` in `can.ts`.
- **API:** team routes, people search for members and up in a browser, and teams on organization invites.
- **Viewer:** Settings, Teams, and teams in the Share sheet, with the source of each person's access.
- **CLI:** `artifacts teams`, `share --team`.
- **Realtime:** event streams check access again on each heartbeat.

**Agent checks:** the existing matrix unchanged, new team rows, `via_token` on team grants, removal and revocation.
**User checks:** create a team and share with it from a phone.

## M18 · Project access

**Build:**
- **Data:** `project_access`, `projects.restricted`, `defaultProjectAccess`, and creators getting `manage`.
- **Publishing:** `project.publish` in `target()`, with a refusal that says no more than a taken name.
- **Viewer:** the project Share sheet, the restrict confirmation, project invites and the team filter.
- **Rules:** links and outside invites in restricted projects, organization tokens, and the audience line in `publish` and MCP.

**Agent checks:** the leak tests in the scope, across every caller; open projects matching M17's matrix exactly.
**User checks:** restrict a real project, then confirm from a second account that it's gone from search and from the connector.

## M19 · Google sign-in

**Build:**
- **Sign-in:** `identities`, the code flow, sign-in and invite buttons, and the linking step.
- **Setup:** Google in `artifacts setup` and Settings, Sign-in, with Test.
- **Re-authentication:** through Google, bound to the session.
- **Clean-up:** reset and removal delete identities.

**Agent checks:** a scripted fake Google through every row of the flow table, with the negative cases.
**User checks:** a real Google client on the Railway server, and passkey and Google on the same account on an iPhone.
