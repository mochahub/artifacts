# 07 · The CLI and the skill

**Contract document** for command names, flags, config files and the skill. Endpoints are in [03-api.md](03-api.md). Behaviour comes from SPEC §7.4, §7.8 and §10.

## Build and distribution

- **Code:** TypeScript in `packages/cli`, compiled with `bun build --compile` for macOS (arm64, x64), Linux (x64, arm64) and Windows (x64).
- **Release:** GitHub Releases attaches binaries and an `install.sh` that downloads the right one to `~/.artifacts/bin` and adds it to `PATH` (once, however often it runs). It checks the SHA-256 from the same release before the binary is put in place, accepts only a plain version number and an https release site (http on localhost, for tests), and needs no `sudo`. The npm package `@artifacts/cli` (with a `bin`) works with `bun add -g` and `bunx`.
- **Playwright WebKit and sharp** are not bundled. On first `render`, the CLI installs `playwright-core`, `sharp`, `mermaid`, `quickjs-emscripten` (for running backends locally; 08), the WebKit browser and its own render helper script into `~/.artifacts/playwright/` (`ARTIFACTS_HELPER_DIR` moves it, for tests). The helper's own web server (127.0.0.1, random port) serves only files that resolve to a place inside the artifact folder (a sibling folder or a symlink out is a 404, so it shows up as `files/missing`), and the helper's environment has no `ARTIFACTS_TOKEN`. It runs rendering, image encoding and pixel hashing by spawning **itself** as Bun on that helper (`BUN_BE_BUN=1 <cli binary> ~/.artifacts/playwright/render.mjs`), so nobody needs Bun or Node installed. Installs use the same trick: `BUN_BE_BUN=1 <cli> add playwright-core@<pinned> sharp@<pinned>`, then `BUN_BE_BUN=1 <cli> node_modules/playwright-core/cli.js install webkit`. Call `cli.js` directly, because `bun x` follows the package's `#!/usr/bin/env node` line and fails without Node. Spike S5 found that sharp can't load from inside a compiled binary, and that the binary doesn't resolve dependencies of packages loaded from another folder. The helper runs with normal module resolution, and this was verified on a Linux machine with no Bun or Node ([spikes.md](spikes.md#s5--the-compiled-bun-cli)).
- **Linux needs WebKit's system libraries,** installed once as root. Without them, Playwright's install stops at its host check. `artifacts doctor` and the first `render` print the exact command: `sudo env BUN_BE_BUN=1 <cli> ~/.artifacts/playwright/node_modules/playwright-core/cli.js install-deps webkit`. macOS needs nothing extra.
- **Version:** `artifacts --version`. Every request sends `Artifacts-CLI: <semver>`; a 426 from the server prints "Run artifacts upgrade". API requests give up after 60 seconds (`ARTIFACTS_TIMEOUT_MS` changes it), never follow redirects (the token would go along), and refuse an answer over 100 MB. A server address must be `http:` or `https:`.

## Files on disk

| Path | What |
|---|---|
| `~/.config/artifacts/config.json` | `{ servers: [{ url, name, default, railway?: { projectId, service: "artifacts", environment }, docker?: { dir } }] }` |
| `~/.config/artifacts/railway/<server name>/` | Folder the Railway CLI is linked in, so `railway init` never links the user's repo |
| OS keychain, service `artifacts`, account `<server url>` | The CLI token |
| `<repo>/artifact.json` | The manifest (05) |
| `<repo>/.artifacts/` | Renders, contact sheet, local data; the CLI adds it to `.gitignore` |
| `<repo>/fixtures/` | Fixtures for rendering (05) |

## Credentials

- **Where:** tokens go in the OS keychain via `Bun.secrets`, which works on macOS (spike S5). On Linux without a desktop session it throws `ERR_SECRETS_PLATFORM_ERROR` (no D-Bus), so the CLI falls back to the file below. Windows is untested. If `Bun.secrets` is missing or throws, the CLI uses the fallback.
- **Fallback:** `~/.config/artifacts/credentials.json` with mode 0600, and a warning.
- **CI:** `ARTIFACTS_TOKEN` and `ARTIFACTS_URL` environment variables override everything. The token is for one server: `ARTIFACTS_URL`, or the default server in config if that isn't set. A command aimed at any other server with `--server` doesn't get it (it looks in the keychain for that server's own token). Only when no server is known at all does `--server` receive it.
- **Tests:** `ARTIFACTS_CREDENTIALS=file` forces the file, and config honours `HOME` and `XDG_CONFIG_HOME`, so tests never touch the real keychain.
- **No prompts:** `ARTIFACTS_PASSWORD`, `ARTIFACTS_SETUP_TOKEN` and `--org`, `--name`, `--email` answer `setup`'s questions; `ARTIFACTS_NO_BROWSER=1` stops `login` opening a browser.

## Which artifact a command acts on

Commands about one artifact use the nearest `artifact.json` from the current folder up (its `project`/`slug`), unless a positional `<project>/<slug>` is given. **Which server:** `--server <url|name>`, else the default server in config. **For agents:** every command supports `--json` (machine output only on stdout, human messages on stderr), and exits 0 on success, 1 on a user-facing error, 2 on usage errors.

## Commands

### Setup and accounts

| Command | Does |
|---|---|
| `artifacts setup` | Interactive: Railway (recommended), Docker, or an existing server. Railway path below. |
| `artifacts setup --docker [--dir <path>] [--image <ref>] [--port <n>]` | Writes `docker-compose.yml` and `.env` (generated `SETUP_TOKEN`, `SESSION_SECRET`, `OPS_SECRET`, SeaweedFS keys) and `s3.json` into the folder, runs `docker compose up -d`, waits for `/api/health`, then claims. `--image` (or `ARTIFACTS_IMAGE`) replaces `ghcr.io/mochahub/artifacts:<cli version>`. `--port n` uses n for the viewer, n+1 for content and n+253 for the bucket. `--org`, `--name` and `--email` answer the questions about the organization and the owner, and `--no-skill` skips installing the skill (see "No prompts" above). |
| `artifacts setup <url>` | If `GET /api/health` says `setupMode`: read the token (Railway CLI, if this server is in config) or ask for it, then claim. Otherwise sign in with the device flow. Then offer to install the skill. |
| `artifacts recover <url>` | Asks for `SETUP_TOKEN` and an owner's email; prints a one-hour reset link (`POST /api/recover`). |
| `artifacts login [<url>]`, `logout`, `whoami` | Device flow; remove the token; show person, role and server. |
| `artifacts upgrade [--server] [--to <version>]` | Update the CLI binary (download, verify the SHA-256 from the release, swap atomically) and the skill. `--to` and the latest release's tag must be a plain version number (`0.2.0`), and `ARTIFACTS_RELEASES_URL` / `ARTIFACTS_LATEST_URL` must be https (http only on localhost, for tests). The checksum comes from the same release as the binary, so it catches a bad download, not a release someone else published. With `--server`, or when you're an admin and the server is older: Railway: `railway service source connect --image ghcr.io/<org>/artifacts:<v> --service artifacts` then wait for health. Docker: edit the tags in `docker-compose.yml`, `docker compose up -d`. |
| `artifacts domain add <domain>` / `list` | Railway only: `railway domain <domain> --service artifacts --port 8080`; prints the DNS records; adds it to `MORE_URLS` (`railway variable set`); asks whether to make it `PUBLIC_URL`. |
| `artifacts mcp` | A Model Context Protocol server on stdin and stdout, for tools without a shell. Its tools (`artifacts_status`, `_comments`, `_reply`, `_publish`, `_versions`, `_data_export`) each run one command with `--json`. |
| `artifacts doctor` | Checks the server is reachable, versions match, the token is valid, WebKit is installed, the skill is installed and current, and the Railway CLI if configured. Prints fixes. |
| `artifacts skill install [--claude] [--codex]` | Copies `skill/` into `~/.claude/skills/artifacts/` and into Codex's skills folder, `${CODEX_HOME:-~/.codex}/skills/artifacts/` (confirmed in spike S7). Not also into `~/.agents/skills/`, which Codex reads too; the skill would be listed twice. |
| `artifacts org invite <email> [--role member\|reviewer\|admin]` | Prints the invite link. |
| `artifacts org reset-link <email>` | Prints a one-hour reset link. |

**The Railway path** in `artifacts setup` (SPEC §7.4; every command exists in Railway CLI 5.71.0; spike S1 runs the whole sequence):
1. **The Railway CLI itself:** `railway --version`. If it's missing, offer `brew install railway` or `npm i -g @railway/cli`.
2. **Sign-in:** `railway whoami --json`. If not signed in, `railway login`.
3. **Workspace:** choose one if there are several (`railway list --json` shows projects; workspaces come from `whoami`).
4. **Project:** in `~/.config/artifacts/railway/<name>/`, run `railway init --name <name> --workspace <ws> --json`.
5. **Deploy the template:** `railway deploy --template <template code>`. The template generates the variables (09). Until it's published, the code comes from `ARTIFACTS_RAILWAY_TEMPLATE`.
6. **Wait:** poll `railway service status --service artifacts --json` until deployed (timeout 10 minutes, with progress), then `GET <url>/api/health`.
7. **URLs:** `railway domain list --service artifacts --json` → the viewer and content domains.
   Then `railway variable set CONTENT_URL=https://<content domain> --service artifacts`, and wait for the redeploy (spike S1).
8. **Token:** `railway variable list --service artifacts --json` → `SETUP_TOKEN` (never printed).
9. **Claim:** `POST /api/setup` with org name, your name, email and password (asked twice), client name and agent.
10. **Save:** write the server to config, and the token to the keychain.
11. **Finish:** offer to install the skill; print the passkey QR code (a terminal QR of `<url>/settings/sign-in`), the invite and domain hints.

### Writing and publishing

| Command | Does |
|---|---|
| `artifacts init [--project <slug>] [--slug <slug>] [--kind canvas\|article\|prototype]` | Writes `artifact.json`, a starter page, `fixtures/`, `.artifacts/` in `.gitignore`, and copies the kit (`@artifacts/kit`) into `vendor/artifacts-kit/` (pinned to the CLI's version, so bundles stay self-contained). |
| `artifacts dev [--port 4321]` | Local viewer and content host with hot reload, using the real viewer build bundled in the CLI, a local data folder, and local backends (08). No server needed. It listens on loopback only (`localhost` for the viewer, `127.0.0.1` for the content host on port + 1), answers only requests whose `Host` is one of those (so DNS rebinding gets nothing), and puts a random per-run secret in the content host's path, as the real host's signed token does, because that host answers any website with CORS `*` and runs the backend. |
| `artifacts lint [--json]` | Rules below. Errors fail; warnings print. |
| `artifacts render [--json]` | Renders (05), writes `.artifacts/contact-sheet.png` and prints its path. |
| `artifacts publish [-m <message>] [--name <label>] [--note <frame>=<text>]… [--json]` | lint → render → hash → prepare → upload → commit. Output below. |
| `artifacts open [<project>/<slug>] [--version <n>] [--page <key>]` | Opens the URL in the browser (prints it with `--json`). |

<a id="publish"></a>**`publish` output:**
```
✓ lint     26 frames, 8 articles, no problems
✓ render   26 frames in WebKit at 1x, 2x and 3x
✓ upload   7 new files (412 KB); 214 already stored
✓ v5       https://art.zahin.ca/camerabuddy/roadmap
  changed  Shoot / Live view, Shoot / Exposure picker, Plan § Phase 1
  threads on changed frames  #3, #4, #6, #8
```

### Review loop

| Command | Does |
|---|---|
| `artifacts status [<project>/<slug>] [--json]` | Latest decision (approved or changes requested, by whom, note), version, open and fixed-awaiting counts. The skill runs this first in every session. |
| `artifacts comments [--open\|--fixed\|--all] [--page <key>] [--json]` | Threads. JSON per thread: `{ id: n, page, frame?, x?, y?, block?, quote?, version, author, text, status, anchorState, crop: url, replies: [...] }`. With `--json`, crops are signed URLs the agent can download (they last about a day). |
| `artifacts reply <n> "<text>" [--fixed]` | Comment on thread n; `--fixed` marks it fixed in the latest version. |
| `artifacts versions [--json]` | Version list. |
| `artifacts versions name <n> "<label>"` | Name a version. |
| `artifacts diff <a> <b> [--json]` | What changed between two versions (frames and blocks). |
| `artifacts restore <n>` | Publish a copy of version n as the next version. |

### Sharing and lifecycle

| Command | Does |
|---|---|
| `artifacts visibility org\|me` | |
| `artifacts share --link [--comment] [--expires 1d\|7d\|30d]` | Prints the link. |
| `artifacts share --invite <email> [--comment\|--publish]` | Prints the invite link for an outside person, or adds an existing member. `--publish` lets a member publish new versions of this artifact (members only; 04). Access the CLI grants this way can comment but can't approve, request changes or resolve threads until a person confirms it in the viewer's Share sheet (04). |
| `artifacts archive [<project>/<slug>] [--undo]` | |
| `artifacts delete [<project>/<slug>] [--version <n>]` | To Recently deleted; prints the purge date and the undo command. |
| `artifacts undelete [<project>/<slug>] [--version <n>]` | |

### Micro apps (Phase 2)

| Command | Does |
|---|---|
| `artifacts data ls [--scope shared\|me]`, `get <key>`, `export`, `clear [--scope]` | The artifact's data (03, 08). |
| `artifacts logs [--follow] [--version <n>]` | The backend's console output and errors for the last 24 hours. |

## Lint rules (`packages/cli/src/lint/`)

Each rule has an id, a severity, and a message saying what's wrong and how to fix it. Project rules come from `lint.rules.js` next to the manifest (default export: an array of `{ id, severity, check(ctx) }`).

| Id | Severity | Checks |
|---|---|---|
| `manifest/schema` | error | The manifest against the zod schema. |
| `files/missing` | error | Referenced files exist. |
| `files/absolute` | error | No absolute paths or URLs to other hosts (fonts, CDNs). |
| `files/outside` | error | No paths outside the manifest folder, and no symlinks that lead out of it (the crawl resolves links, so a cloned repo can't publish `~/.ssh` through one). |
| `frames/ids` | error | Every frame has a unique `data-frame`; ids match `[a-z0-9-]+`. |
| `frames/renamed` | warning, or error if it has open comments | A frame or block id that existed in the latest published version is missing. Says what is gone and stops the publish when comments would be orphaned. It doesn't guess the rename. |
| `frames/overlap` | error | Interactive elements that overlap other interactive elements in a frame (bounding boxes, after layout). |
| `frames/clipped` | error | Text whose `scrollWidth > clientWidth` with `overflow: hidden`, or that is ellipsized when the author didn't set `text-overflow`. |
| `frames/home-indicator` | error | Text or controls under the iPhone home indicator area (bottom 34 pt) or the status bar. |
| `frames/offscreen` | error | Content outside the frame's box. |
| `frames/deterministic` | error | Two renders differ (05). |
| `weight/image` | warning | Images over 500 KB after conversion. |
| `weight/frame` | error | A frame's assets over 3 MB. |
| `weight/bundle` | warning | Over 50 MB. |
| `contrast/text` | warning | WCAG AA on rendered frames and articles. |
| `article/blocks` | error | Duplicate block ids. |
| `data/api` | error | Frontend code uses `localStorage`, `indexedDB`, `document.cookie` or `fetch` to anything but relative `api/` paths. |
| `data/fixtures` | error | Frames render differently with and without fixtures where the frame reads data, unless fixtures exist. |
| `backend/size` | error | Bundled backend over 1 MB. |
| `backend/network` | error | The backend calls `fetch` with absolute URLs, `connect()`, uses APIs the sandbox lacks (`fetch`, timers, Node built-ins, `import()`), or imports anything that isn't bundled (08). |

## The skill (`skill/SKILL.md` plus `skill/references/`)

The skill is what makes agents use Artifacts well. It ships with the CLI and is installed by `artifacts setup` and `artifacts skill install`.

**Frontmatter:** `name: artifacts`. The description triggers it on: publishing a plan, report, research, mock or prototype for review; "address the comments"; "check the artifact".

**Body, in order:**
1. **Start every session with `artifacts status --json`.** If changes were requested, read the note and the open comments before anything else.
2. **When to publish:** plans, research reports, mocks, comparisons, prototypes the user should read or review. Not throwaway output.
3. **Structure:**
   - one artifact per deliverable; pages for its parts (the plan as an article, research as articles grouped "Research", mocks as a canvas)
   - stable `data-frame` and heading ids, and never renaming ids that have comments
4. **The kit:** device frames, theme tokens, article components (`references/kit.md`).
5. **Writing style for articles:** `references/writing.md`.
6. **Micro apps:**
   - use `@artifacts/kit/data` for anything that must persist
   - add a backend only when the frontend store isn't enough
   - keep a `schema` number in stored values
   - provide fixtures
7. **Gate:** `artifacts lint`, then `artifacts render`, then **look at the contact sheet** (read `.artifacts/contact-sheet.png`), fix, repeat; publish only on a clean lint.
8. **Review loop on "address the comments":**
   1. `artifacts comments --open --json`, and download each crop and look at it
   2. fix the source
   3. `artifacts publish -m "…" --note frame=…` for each changed frame
   4. `artifacts reply <n> "<what changed>" --fixed` for each addressed thread

   Never resolve a person's thread. If a comment is ambiguous, reply with a question and leave the thread open.
9. **Lifecycle:** archive finished artifacts when asked; never delete without being asked; never try to purge.
10. **Report back:** the URL, the version, what changed, and which threads were marked fixed.

**References:**
- `references/manifest.md`: the schema with examples
- `references/kit.md`
- `references/writing.md`
- `references/micro-apps.md`: the data API and the backend handler, with examples
- `references/lint.md`: every rule with fixes
