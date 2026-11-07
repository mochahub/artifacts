# 07 · The CLI and the skill

**Contract document** for command names, flags, config files and the skill. Endpoints are in [03-api.md](03-api.md). Behaviour comes from SPEC §7.4, §7.8 and §10.

## Build and distribution

- **Code:** TypeScript in `packages/cli`, compiled with `bun build --compile` for macOS (arm64, x64), Linux (x64, arm64) and Windows (x64).
- **Release:** GitHub Releases attaches binaries and an `install.sh` that downloads the right one to `~/.artifacts/bin` and adds it to `PATH` (once, however often it runs). It checks the SHA-256 from the same release before the binary is put in place, accepts only a plain version number and an https release site (http on localhost, for tests), and needs no `sudo`. The npm package `@artifacts/cli` (with a `bin`) works with `bun add -g` and `bunx`.
- **Playwright WebKit and sharp** are not bundled. On first `render`, the CLI installs `playwright-core`, `sharp`, `mermaid`, `quickjs-emscripten` (for running backends locally; 08), the WebKit browser and its own render helper script into `~/.artifacts/playwright/` (`ARTIFACTS_HELPER_DIR` moves it, for tests). The helper's own web server (127.0.0.1, random port) serves only files that resolve to a place inside the artifact folder (a sibling folder or a symlink out is a 404, so it shows up as `files/missing`), and the helper's environment has no `ARTIFACTS_TOKEN`. It runs rendering, image encoding and pixel hashing by spawning **itself** as Bun on that helper (`BUN_BE_BUN=1 <cli binary> ~/.artifacts/playwright/render.mjs`), so nobody needs Bun or Node installed. Installs use the same trick: `BUN_BE_BUN=1 <cli> add playwright-core@<pinned> sharp@<pinned>`, then `BUN_BE_BUN=1 <cli> node_modules/playwright-core/cli.js install webkit`. Call `cli.js` directly, because `bun x` follows the package's `#!/usr/bin/env node` line and fails without Node. Spike S5 found that sharp can't load from inside a compiled binary, and that the binary doesn't resolve dependencies of packages loaded from another folder. The helper runs with normal module resolution, and this was verified on a Linux machine with no Bun or Node ([spikes.md](spikes.md#s5--the-compiled-bun-cli)).
- **Linux needs WebKit's system libraries,** installed once as root. Without them, Playwright's install stops at its host check. `artifacts doctor` and the first `render` print the exact command: `sudo env BUN_BE_BUN=1 <cli> ~/.artifacts/playwright/node_modules/playwright-core/cli.js install-deps webkit`. macOS needs nothing extra.
- **Version:** `artifacts --version`. Every request sends `Artifacts-CLI: <semver>`; a 426 from the server prints "Run artifacts upgrade". API requests give up after 60 seconds (`ARTIFACTS_TIMEOUT_MS` changes it), never follow redirects (the token would go along), and refuse an answer over 100 MB. A server address must be `https:`, so a password or token is never sent in the clear. The exception is this machine: `localhost`, `*.localhost`, `127.0.0.1` and `[::1]` may use `http:`, for `setup --docker`, `dev`, local trials and tests. Any other `http://` address is refused with an error pointing at the README's HTTPS section, before anything is sent, whether it came from `login`, `setup <url>`, `--server`, `ARTIFACTS_URL`, or a server an older CLI stored in the config. There is no setting to turn the check off.

## Files on disk

| Path | What |
|---|---|
| `~/.config/artifacts/config.json` | `{ servers: [{ url, name, default, railway?: { projectId, service: "artifacts", environment }, docker?: { dir } }] }` |
| `~/.config/artifacts/railway/<server name>/` | Folder the Railway CLI is linked in, so `railway init` never links the user's repo |
| OS keychain, service `artifacts`, account `<server url>` | The CLI token |
| `<repo>/.artifacts/work/<slug>/` | A working folder: `artifact.json` and its sources. The default place for a new artifact. |
| `~/.config/artifacts/brand/<server>/` | The org's brand and font files, cached at each render, so rendering works offline |
| `<repo>/artifact.json` | The manifest (05), when an artifact lives in the repo (`init --in-repo`) |
| `<repo>/.artifacts/` | Working folders, renders, contact sheet, local data; the CLI adds it to `.gitignore` |
| `<artifact folder>/fixtures/` | Fixtures for rendering (05) |

## Credentials

- **Where:** tokens go in the OS keychain via `Bun.secrets`, which works on macOS (spike S5). On Linux without a desktop session it throws `ERR_SECRETS_PLATFORM_ERROR` (no D-Bus), so the CLI falls back to the file below. Windows is untested. If `Bun.secrets` is missing or throws, the CLI uses the fallback.
- **A replaced binary:** macOS ties an item to the binary that wrote it, so a new build opens a dialog on its first read. Keychain calls give up after 30 seconds with instructions, and don't fall back to the file. Unsigned builds show that dialog once per upgrade.
- **Fallback:** `~/.config/artifacts/credentials.json` with mode 0600, and a warning.
- **CI:** `ARTIFACTS_TOKEN` and `ARTIFACTS_URL` environment variables override everything. The token is for one server: `ARTIFACTS_URL`, or the default server in config if that isn't set. A command aimed at any other server with `--server` doesn't get it (it looks in the keychain for that server's own token). Only when no server is known at all does `--server` receive it.
- **Tests:** `ARTIFACTS_CREDENTIALS=file` forces the file, and config honours `HOME` and `XDG_CONFIG_HOME`, so tests never touch the real keychain.
- **No prompts:** `ARTIFACTS_PASSWORD`, `ARTIFACTS_SETUP_TOKEN`, `ARTIFACTS_GOOGLE_CLIENT_ID`, `ARTIFACTS_GOOGLE_CLIENT_SECRET` and `--org`, `--name`, `--email` answer `setup`'s questions; `ARTIFACTS_NO_BROWSER=1` stops `login` opening a browser.

## Which artifact a command acts on

Commands about one artifact use the nearest `artifact.json` from the current folder up (its `project`/`slug`), unless a positional `<project>/<slug>` is given. With none on the way up, they use the working folder in the nearest `.artifacts/work/` if there's exactly one, and otherwise list the choices. `lint`, `render` and `publish` take a `<slug>` to pick one. **Which server:** `--server <url|name>`, else the default server in config. **For agents:** every command supports `--json` (machine output only on stdout, human messages on stderr), and exits 0 on success, 1 on a user-facing error, 2 on usage errors.

## Commands

### Setup and accounts

| Command | Does |
|---|---|
| `artifacts setup` | Interactive: Railway (recommended), Docker, or an existing server. Railway path below. |
| `artifacts setup --docker [--dir <path>] [--image <ref>] [--port <n>]` | Writes `docker-compose.yml` and `.env` (generated `SETUP_TOKEN`, `SESSION_SECRET`, `OPS_SECRET`, SeaweedFS keys) and `s3.json` into the folder, runs `docker compose up -d`, waits for `/api/health`, then claims. `--image` (or `ARTIFACTS_IMAGE`) replaces `ghcr.io/mochahub/artifacts:<cli version>`. `--port n` uses n for the viewer, n+1 for content and n+253 for the bucket. `--org`, `--name` and `--email` answer the questions about the organization and the owner, and `--no-skill` skips installing the skill (see "No prompts" above). `--stageshow` answers yes to Stageshow. |
| `artifacts setup <url>` | If `GET /api/health` says `setupMode`: read the token (Railway CLI, if this server is in config) or ask for it, then claim. Otherwise sign in with the device flow. Then offer to install the skill, and after it Stageshow, a third-party skill. Stageshow is the only install that defaults to no, says it's third party, and is asked once: never by an agent, and not again once it's there. `--no-skill` skips both. |
| `artifacts recover <url>` | Asks for `SETUP_TOKEN` and an owner's email; prints a one-hour reset link (`POST /api/recover`). |
| `artifacts login [<url>]`, `logout`, `whoami` | Device flow (https only, or a loopback address); remove the token; show person, role and server. |
| `artifacts upgrade [--server] [--to <version>]` | Update the CLI binary (download, verify the SHA-256 from the release, swap atomically) and the skill. `--to` and the latest release's tag must be a plain version number (`0.2.0`), and `ARTIFACTS_RELEASES_URL` / `ARTIFACTS_LATEST_URL` must be https (http only on localhost, for tests). The checksum comes from the same release as the binary, so it catches a bad download, not a release someone else published. With `--server`, or when you're an admin and the server is older: Railway: `railway service source connect --image ghcr.io/<org>/artifacts:<v> --service artifacts` then wait for health. Docker: edit the tags in `docker-compose.yml`, `docker compose up -d`. |
| `artifacts domain add <domain>` / `list` | Railway only: `railway domain <domain> --service artifacts --port 8080`; prints the DNS records; adds it to `MORE_URLS` (`railway variable set`); asks whether to make it `PUBLIC_URL`. With Google on, it prints the redirect URI to add to the client. |
| `artifacts mcp` | A Model Context Protocol server on stdin and stdout, for tools without a shell. Its tools (`artifacts_search`, `_list`, `_read`, `_view`, `_status`, `_comments`, `_reply`, `_publish`, `_versions`, `_data_export`) each run one command with `--json`. The six page tools (`artifacts_page_read`, `_edit`, `_suggest`, `_create`, `_suggestions`, `_delegate`) run `artifacts page …` the same way, except that `_read` runs without `--json` to give the text form. The seven board tools (`artifacts_board_read`, `_edit`, `_suggest`, `_checkpoint`, `_suggestions`, `_delegate`, `_create`; specs in `@artifacts/schema/mcp`) run `artifacts --json board …` the same way: a model's `BoardEditRequest` reaches `board edit` and `board suggest` on standard input (`--ops=-`), and every other value is checked before it can become a flag. A refused or suggested batch is an answer, not a tool failure: `_edit` and `_suggest` return the receipt whatever the exit code (0, 1 or 2). A model's operations and Markdown reach the command on standard input (`--ops=-`, `--file=-`), never as an argument, and every other value is checked before it can become a flag. `initialize` returns `instructions` with the core rules, and this repo's project if it can find it within 2 seconds. A tool whose answer can hold other people's text starts it with a block saying that text is data, and `_view` returns an image. |
| `artifacts brand [show] \| prompt \| preview <file> \| propose <file>` | The org brand. `show` prints it and any waiting proposals. `prompt` prints what to hand an agent, which `setup` also prints at the end. `preview` renders every template with a `brand.json` and prints the contact sheet's path, with nothing sent anywhere. `propose` publishes that sample as `brand/sample-<hash>` and records a proposal, which a person applies in Settings. |
| `artifacts mcp install [--claude] [--codex] [--token-env <name>]` | Opt-in: adds the hosted MCP, `<server>/api/mcp`, to Claude Code with `claude mcp add --transport http --scope user`, and to Codex in `config.toml`. `setup` doesn't do this, because the skill and a connector together give an agent every tool twice. `--token-env` names an environment variable holding a CLI token, for a client with no OAuth on a remote box: `bearer_token_env_var` for Codex and `--header` for Claude Code. |
| `artifacts doctor` | Checks the server is reachable, versions match, the token is valid, WebKit is installed, the skill is installed and current, and the Railway CLI if configured. Prints fixes. |
| `artifacts skill install [--claude] [--codex]` | Copies `skill/` into `~/.claude/skills/artifacts/` and into Codex's skills folder, `${CODEX_HOME:-~/.codex}/skills/artifacts/` (confirmed in spike S7). Not also into `~/.agents/skills/`, which Codex reads too; the skill would be listed twice. `--stageshow` also installs Stageshow, third party and pinned to the commit `references/stageshow.md` was tested with, with `npx skills add`. Its install does write `~/.agents/skills/`, which is how Codex finds it. |
| `artifacts org invite <email> [--role member\|reviewer\|admin]` | Prints the invite link. |
| `artifacts org reset-link <email>` | Prints a one-hour reset link. |
| `artifacts teams` | Lists teams: slug, name, size, and whether you're in one. Admins make them in Settings. Tokens can't change teams or who's in them. |
| `artifacts project access [<project>]` | Who has a project and why. Read-only, for someone who manages it: tokens can't change project access. Uses the nearest `artifact.json` if no project is named. |

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
9. **Claim:** `POST /api/setup` with org name, your name, email and password (asked twice), client name and agent. At a terminal it also prints the Google redirect URIs and asks for a client ID and secret, and Enter skips. Without a terminal, Google is only used if the two variables above are set. It's stored and stays off until an admin tests it in Settings.

10. **Save:** write the server to config, and the token to the keychain.
11. **Finish:** offer to install the skill; print the passkey QR code (a terminal QR of `<url>/settings/sign-in`), the invite and domain hints.

### Wikis

| Command | Does |
|---|---|
| `artifacts wiki create <slug> [--name <name>] [--only-me | --team <slug>]` | Calls `POST /api/wikis`. Name defaults to the slug. Prints the wiki name and URL, with "Already exists" first when the wiki was there already. Restricted starting audiences require a person. A narrower audience than an existing wiki's is refused (409). Bad flags print the specific problem. |
| `artifacts wiki show <slug> [--json]` | Calls `GET /api/wikis/:slug`. Prints the rules summary, pages and sources with summaries and untrusted marks, then garden findings as `kind slug: message`, then the ten latest log entries. Empty Pages, Sources, Garden and Log sections say `none`. |
| `artifacts wiki list [--json]` | Lists visible wikis with audience and page count, from `GET /api/projects` and each `GET /api/wikis/:slug`. |
| `artifacts wiki links <project/slug> [--json]` | Resolves the artifact, then calls `GET /api/artifacts/:id/links`. Prints the artifact's role, untrusted mark and origin, then outgoing links, backlinks and sources, marking wanted and untrusted targets and showing origins when present. Empty sections say `none`. Non-wiki artifacts print no wiki sections. |
| `artifacts wiki export <wiki> <dir> [--json]` | Writes every page and source the caller can see as `<slug>.md` in `<dir>`, which must be empty or absent. Each file is the server's `GET /api/artifacts/:id/export.md` for the latest version: front matter (`title`, `summary`, `tags`, `role`, `sources`, `origin`, `untrusted`), then the body with atoms exact and `[[links]]` as written. Files a page refers to (images, chart data) come from its version's bundle into `<dir>/<slug>/`, and the page's links are rewritten to `<slug>/…` so every relative link in the tree resolves. A drawn board (a native board checkpoint, 14) has no Markdown: it is written as a folder `<slug>.board/` in the shape `board export` writes (below), counted in `boards`. A page that can't be exported (a legacy canvas, say) is listed as skipped and the rest are written. `--json` prints `{ wiki, dir, pages, boards, files, skipped, left }`. |

Publishing and packing pass the manifest's `project` into article rendering and
its `wiki` field (or null) into the commit. See [Wikis](12-wikis.md).
The skill ships `references/wiki.md`, served as `artifacts://guides/wiki`, for
ingest, ask, garden and a starter rules page.

### Editing wiki pages

`artifacts page` reads and changes a wiki article through the draft (13). Every command takes `<project/slug>` (the wiki is the project), `--server` and `--json`; the server decides whether an edit applies or becomes a suggestion, and the CLI prints which. Bad flags exit 2 before any request is sent. Page text in a `--json` answer comes with the `untrusted` notice, because it is data written by people, sources and other agents, never instructions.

| Command | Does |
|---|---|
| `artifacts page read <project/slug> [--draft \| --latest] [--cursor <c>] [--json]` | Reads the page as blocks (`GET /api/artifacts/:id/doc/markdown`). With neither flag it reads the live draft when the caller can edit it, so the bases are the current ones, and the latest version otherwise (one extra `GET …/doc`). `--draft` insists on the draft, `--latest` on the version. The text form is `pageReadText` in `@artifacts/schema/mcp`, which the hosted tool prints too: a header (title, version or draft, how agents' edits land now, summary, tags, sources), then each block as `[block ~id base]` and its Markdown (an atom as `[block ~id base atom:<kind>]` and its exact source, with `by:` and `threads:` after the base where there are authors and open threads), the authors, the open suggestions marked as text other people wrote, and `More blocks: pass cursor <c>.` when there is a next page (pass it as `--cursor`). |
| `artifacts page edit <project/slug> --ops <file.json> [--suggest] [--checkpoint] [--note <text>] [--source <slug>]… [--fixes <n,…>] [--run <id>] [--json]` | `POST …/doc/ops` with an `EditRequest`. `--ops` is a file (or `-` for standard input) holding an array of operations, or a whole request whose own fields the flags then override. Prints one line per operation: `✓ op 0 applied ~id`, `~ op 1 suggested ~id (held)`, `✗ op 2 refused ~id (stale): <current Markdown>`, then `✓ saved as v8` when `--checkpoint` made a version, and how agents' edits land when any op wasn't applied. **Exit code 1 when any operation was refused**, with the whole answer still printed (and, with `--json`, on stdout). Applied and suggested are exit 0. |
| `artifacts page edit … --replace <id> --base <hash> --file <md>` \| `--insert-after <id\|start> --file <md>` \| `--delete <id> --base <hash>` | Shorthands for a single operation. `--file` is a path or `-`. `--insert-after start` puts the block first. They can't be mixed with `--ops`; meta changes (title, summary, tags, sources) go through `--ops`. |
| `artifacts page suggest <project/slug> …` | The same as `edit --suggest`: every operation becomes a suggestion or is refused. `--checkpoint` isn't accepted. |
| `artifacts page save <project/slug> [--name <name>] [--message <text>]` | `POST …/doc/checkpoint`. Prints `✓ v8 saved`, or says there was nothing new and names the latest version. |
| `artifacts page suggestions <project/slug> [--status open\|accepted\|rejected\|stale\|expired\|withdrawn\|all] [--run <id>] [--cursor <c>]` | Lists suggestions with their decision. |
| `artifacts page delegate <project/slug> --goal <text>` | Starts a Delegate run and prints its id alone on stdout (a hint goes to stderr). Pass it to `page edit --run <id>`. |
| `artifacts page delegate <project/slug> --finish <run> [--message <text>]` \| `--cancel <run>` | Ends the run. A direct run ends in a version; a suggestion run leaves its change set for a person to accept. |
| `artifacts page export <project/slug> [--version <n> \| --draft] [-o <file>]` | The page's Markdown with front matter (`GET …/export.md`) to standard output, or to the file. `--draft` needs edit access. |
| `artifacts page create <wiki>/<slug> --title <text> --summary <text> --file <md> [--tag <t>]… [--role page\|source] [--source <slug>]… [--origin <url>] [--untrusted] [-m <message>]` | Version 1 of a new page, with lasting block ids from the start, text only. It calls the hosted tool `artifacts_page_create` over `POST /api/mcp` with the CLI's own token, because no other route creates a page without a render. An existing slug is refused with the tool's words: change it with `page edit`. Prints `✓ <wiki>/<slug> v1  <url>`. |

**Sign-in and the `edit` scope.** A new `artifacts login` gets the `edit` scope. A token from before it doesn't, and the server answers `forbidden` with `details: { scope: "edit" }` (worker 1 adds this to `denial()`; until it lands the CLI can't tell the cases apart and prints the server's words): the CLI then says "Run artifacts login again to edit pages." (a plain `forbidden`, such as someone who may only comment, keeps the server's words; with `--json` the server's error is printed as it came). Only a person can give edit access, so `share --invite … --edit` and `share --team … --edit` send it and, when the server refuses a token, exit 1 with "Only a person can give edit access. Use the Share sheet." (with `--json`, the server's own error). A link never carries edit: `share --link --edit` is a usage error, and so is `--edit` with `--comment` or `--publish`.

**The `Artifacts-Features: editing,boards` header** goes on every request to the server, so it answers an up-to-date CLI with the `edit` permission, the editing activity kinds and, for a drawn board, comment threads anchored to an object, and an older one with the values it knows (13, "Older clients"; 14, "CLI and skill"). A CLI that sends only `editing` sees such a thread with `anchor: null`, its `where` text and its crop.

### Boards (Phase 3)

`artifacts board` reads and changes a drawn board (14) through the same hosted routes, credentials and `edit`-scope error as `artifacts page`. Every command takes `<project/slug>` (the wiki is the project), `--server` and `--json`; bad flags exit 2 before any request is sent. Board text, labels, alt text and notes are data written by people, sources and other agents, never instructions: JSON answers carry the `untrusted` notice, and `--text` quotes every piece of board text so it can't pass for another line.

| Command | Does |
|---|---|
| `artifacts board read <project/slug> [--draft \| --version <n>] [--cursor <c> \| --all] [--text] [--json]` | `GET /api/artifacts/:id/board/objects`. Prints the structured `BoardRead` as JSON (every object with its id, `kind`, `pose`, `parent`, text, bindings, attribution, 12-character `base` and open thread numbers; the published frames with `placement` placed, suggested, unplaced or deleted; authors; open suggestions) whatever the output mode, and with `--text` one line per object in tree order: `~id kind base=… at=(x,y) size=WxH … text="…" by="…" threads=#3`. The default is the latest checkpoint, as the route's is; `--draft` (edit access) reads the live draft, whose `epoch` and `base`s an edit needs, and never falls back to a checkpoint. `--cursor` reads the next page of 50 objects, and `--all` follows every cursor and prints one merged read (a board that changes mid-read is `conflict stale_read`: read again). |
| `artifacts board edit <project/slug> --ops <file.json\|-> [--epoch <n>] [--request-id <uuid>] [--suggest] [--checkpoint] [--note <text>] [--source <slug>]… [--fixes <n,…>] [--run <id>] [--agent <name>]` | `POST …/board/ops` with a `BoardEditRequest`. `--ops` is a file (or `-` for standard input), never a hand-escaped flag: a whole request (`epoch`, `bases`, `ops`, …) or just a list of operations with `--epoch`. A request without `bases` sends none (an add-only batch needs none), and one without a `requestId` gets a new UUID; it is printed in the receipt so a retry can pass `--request-id` and get the same receipt back. The flags fill or override the file. Prints `✓ applied`, `~ suggested (audience)` or `✗ refused (stale): <current base>`, the suggestion id, one line per operation with the lasting ids it touched, the `$ref` → id map, `✓ saved as v8` when `--checkpoint` made a version, and how agents' edits land when the batch wasn't applied. **Exit 0 only when the batch was applied, 2 when it became a suggestion, 1 when it was refused or failed**, with the whole answer still printed (and, with `--json`, on stdout). A stale epoch says to read again with `--draft`. |
| `artifacts board suggest <project/slug> --ops <file.json\|-> …` | The same as `edit --suggest`: the batch becomes a ghost suggestion or is refused. `--checkpoint` isn't accepted. Exit 2 when it became a suggestion. |
| `artifacts board place-frame <project/slug> --frame <key> (--near <object> \| --region <x,y,w,h>) [--side right\|below\|left\|above] [--gap <px>] [--suggest \| --checkpoint] [--note <text>] [--request-id <uuid>]` | The typical "turn this sketch into mocks" step. It reads the draft (`BoardState`, then every page of `board/objects?draft=1`, restarted once if the board moved), finds the published frame by its key, takes the epoch and the bases it needs from that read (the `--near` object, and the frame's own object when it is already placed), and sends one `place_frame` operation (`ref: "$frame"` when the frame has no object yet). `--gap` is 16 to 2000, default 80; `--side` defaults to `right`; `--region` is a world rectangle with angle 0. A frame that was never published, one a person deleted, or one already waiting in a suggestion stops with the reason before anything is sent. Receipts and exit codes are `board edit`'s. The picture comes from `artifacts publish`; this command never uploads one. |
| `artifacts board save <project/slug> [--epoch <n>] [--name <name>] [-m <message>]` | `POST …/board/checkpoint` with `{ epoch, name?, message? }`. Without `--epoch` it uses the draft's, and says so if there is no draft. Prints `✓ v8 saved` and `pictures pending: a browser fills them in when someone opens the board`: the CLI has no browser, so a checkpoint made here is JSON until an authorized browser captures its thumbnail and comment crops, without a new version. `--json` adds `"pictures": "pending"`. |
| `artifacts board suggestions <project/slug> [--status <s> \| --preview <id>] [--cursor <c>]` | `GET …/board/suggestions` (status as for `page suggestions`), or with `--preview` the paginated ghost objects of one proposal (`GET /api/board-suggestions/:id/preview`): each ghost's id, kind and proposed base, and the ids it would delete. There are no accept or reject flags: only a person decides. |
| `artifacts board delegate <project/slug> --goal <text> [--agent <name>]` \| `--finish <run> [-m <message>]` \| `--cancel <run>` | The run lifecycle of `page delegate` (`POST …/doc/runs`, `/api/runs/:id/finish`, `/cancel`); the hint names `board edit --run`. |
| `artifacts board create <wiki>/<slug> --title <text> --summary <text> [--tags <a,b>] [--sources <a,b>]` | `POST /api/boards`: an empty native board as version 1 of a new wiki page. Prints `✓ <wiki>/<slug> v1  <url>`. |
| `artifacts board asset add <project/slug> <file>` | Checks the file here (PNG, JPEG or still WebP, at most 10 MiB, 8,192 on a side, 16 million pixels; SVG, GIF and animated files are refused), then `POST …/board/assets/prepare`, a `PUT` to the presigned URL (retried; skipped when the server already holds the bytes), and `…/assets/commit`. Prints the validated `BoardImage` (`{ hash, type, bytes, width, height }`). It never places the picture: add it with an `add` operation of kind `image`. |
| `artifacts board export <project/slug> <dir> [--version <n>] [--json]` | One checkpoint (the latest unless `--version`; never a draft) in an empty or new folder: `board.json` (the immutable schema-1 scene, source tuples of rendered frames included), `outline.txt` (the objects as plain text in tree order), `assets/<hash>.<ext>` (each picture, checked against its hash; the route redirects to storage and the redirect is followed without the token) and `frames/<page>-<frame>.webp` (each rendered frame's @2x picture, from the library view route). A picture that can't be fetched is listed under `skipped` and doesn't fail the export. |

**Publish, then place.** Rendered frames still come from `artifacts publish`, which on a native board prints where the server put each one: `placed on the board`, `waiting as N placement suggestions for a person to accept`, or `not on the board yet` with the `board place-frame` command to run (these are `PublishResult.board`: `placed`, `suggestions`, `unplaced`). The whole loop: `board read --draft` (the sketch) → `publish` (the mocks) → `board place-frame --frame login --near ~sketch --side right` → `board save`.

### Writing and publishing

| Command | Does |
|---|---|
| `artifacts init [--project <slug>] [--slug <slug>] [--kind canvas\|article\|prototype] [--template <name>] [--in-repo]` | Makes `.artifacts/work/<slug>/` in the repo root, or the current folder outside a repo, with `artifact.json`, a starter page and `fixtures/`, copies the kit (`@artifacts/kit`) into `vendor/artifacts-kit/` (pinned to the CLI's version, so bundles stay self-contained), and adds `.artifacts/` to `.gitignore`. `--in-repo` writes them to the current folder instead, to commit them. `--template` copies an editable starter instead of a blank page: `design-review`, `presentation`, `case-study`, `prd`, `rfc`, `research-report` or `weekly-status`. It can't be used with `--kind`, and its slug defaults to its name. `publish` warns if the template's placeholder `summary` is still there. |
| `artifacts dev [--port 4321]` | Local viewer and content host with hot reload, using the real viewer build bundled in the CLI, a local data folder, and local backends (08). No server needed. It listens on loopback only (`localhost` for the viewer, `127.0.0.1` for the content host on port + 1), answers only requests whose `Host` is one of those (so DNS rebinding gets nothing), and puts a random per-run secret in the content host's path, as the real host's signed token does, because that host answers any website with CORS `*` and runs the backend. |
| `artifacts lint [<slug>] [--json]` | Rules below. Errors fail; warnings print. |
| `artifacts render [<slug>] [--json]` | Renders (05), writes `.artifacts/contact-sheet.png` and prints its path. With no frames there's no sheet, and `--json` says `null`. |
| `artifacts publish [<slug>] [-m <message>] [--name <label>] [--note <frame>=<text>]… [--json]` | lint → render → hash → prepare → upload → commit. Output below. |
| `artifacts pack [<slug>] [-m <message>] [--name <label>] [--json]` | Lint and render, then write a publish to `.artifacts/pack/` and print the arguments for `artifacts_publish_prepare`. Needs no sign-in, because the hosted MCP has that. It does need this CLI and WebKit, which is the one thing a connector can't do without. |
| `artifacts pack [<slug>] --upload <plan>` | Uploads what a plan from `artifacts_publish_prepare` lists, straight to the bucket. Files go only to the plan's own origin, and only hashes in this pack. |
| `artifacts open [<project>/<slug>] [--version <n>] [--page <key>]` | Opens the URL in the browser (prints it with `--json`). |

<a id="publish"></a>**`publish` output:**
```
✓ lint     26 frames, 8 articles, no problems
✓ render   26 frames in WebKit at 1x, 2x and 3x
✓ upload   7 new files (412 KB); 214 already stored
✓ v5       https://art.zahin.ca/camerabuddy/roadmap
  changed  Shoot / Live view, Shoot / Exposure picker, Plan § Phase 1
  visible to  Design team and 2 people
  threads on changed frames  #3, #4, #6, #8
```

`artifacts status` and the MCP status tools say who can see it too, for whoever can share it. Agents publish more than people do, so this is where a wrong default gets caught.

### The library

These work anywhere: none reads an `artifact.json`. `--json` output carries an `untrusted` notice, because summaries, snippets and articles can come from other people.

| Command | Does |
|---|---|
| `artifacts search <words> [--project <slug>] [--repo <remote>] [--here] [--limit <n>] [--cursor <c>] [--json]` | Compact cards (03). `--here` uses this folder's `origin` remote. |
| `artifacts list [<project>[/<slug>[/<page>]]] [--repo <remote>] [--here] [--limit <n>] [--cursor <c>] [--json]` | Projects, a project's artifacts, an artifact's pages, or a page's frames: only as deep as the path. |
| `artifacts read <project>/<slug> [--page <key>] [--version <n>] [--cursor <c>] [--chars <n>] [--json]` | Full text, in pieces. Follow `nextCursor`. |
| `artifacts view <project>/<slug> [--page <key>] [--frame <key>] [--size thumb\|1x\|2x] [--version <n>] [--out <file>] [--json]` | Saves a picture and prints its path. A thumbnail unless asked for more. |
| `artifacts pull <project>/<slug> [--version <n>] [--dir <path>] [--force] [--json]` | Restores a working folder, to `.artifacts/work/<slug>/` unless `--dir` says otherwise. Refuses a folder that isn't empty unless `--force`. Every file's hash is checked, generated files are left out, and so is anything whose path could leave the folder, plus `lint.rules.js`, which the CLI would run. A version from before manifests were stored gets a rebuilt `artifact.json`, and pull says so. |
| `artifacts export <project> [--dir <path>] [--json]` | Writes every artifact you can see in a project: `card.json`, `versions.json`, `comments.json`, `decisions.json`, and each version's files in `v<n>/`, to `<project>-export/` unless `--dir` says otherwise. Frame renders aren't included; `artifacts render` makes them again. |

### Review loop

| Command | Does |
|---|---|
| `artifacts status [<project>/<slug>] [--json]` | Latest decision (approved or changes requested, by whom, note), version, open and fixed-awaiting counts. The skill runs this first in every session. |
| `artifacts comments [--open\|--fixed\|--all] [--page <key>] [--json]` | Threads. JSON per thread: `{ id: n, page, frame?, x?, y?, block?, quote?, object?, version, author, authorKind, untrusted: true, text, status, anchorState, crop: url, replies: [...] }`. `object` (with `x`, `y` as the pin's position on it) is a pin on a native board object; it keeps working while the object moves, and the thread is `orphaned` if it is deleted. With `--json`, crops are signed URLs the agent can download (they last about a day). |
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
| `artifacts share --invite <email> [--comment\|--edit\|--publish]` | Prints the invite link for an outside person, or adds an existing member. `--publish` lets a member publish new versions of this artifact (members only; 04). `--edit` asks for the `edit` level, which only a person can give (04): the server refuses it from a token, and the CLI says so. Access the CLI grants this way can comment but can't approve, request changes or resolve threads until a person confirms it in the viewer's Share sheet (04). |
| `artifacts share --team <slug> [--comment\|--edit]` | Shares with a team, at `view` or `comment`. Only a person can give a team `edit` or `publish`. Like `--invite`, it can't approve or resolve until a person confirms it. |
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
| `manifest/schema` | error | The manifest against the zod schema, including the caps on `summary` and `tags`. |
| `manifest/summary` | error | The manifest has a `summary`. Discovery depends on it. `lint` and `publish` check it; `render` doesn't, so a draft can still be looked at. |
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

**Frontmatter:** `name: artifacts`. The description triggers it on: publishing a plan, report, research, mock or prototype for review; "address the comments"; "check the artifact"; and checking hosted artifacts before research, design or prototyping.

**Body, in order:**
1. **Start every session with `artifacts status --json`.** If changes were requested, read the note and the open comments before anything else.
2. **Check what's already there:** `artifacts search` before research, design or prototyping.
3. **Publish by default:** publishing to the org's hosted library needs no approval. Plans, research reports, mocks, comparisons and prototypes someone should read or review get published without asking, and the agent hands over the artifact link, not a local one, unless the user asks for local. Work that needs motion or interaction is a `prototype` page. Not throwaway output. `share --link`, `share --invite`, changing visibility, deleting and `data clear` still need an explicit request.
4. **Structure:**
   - one artifact per deliverable; pages for its parts (the plan as an article, research as articles grouped "Research", mocks as a canvas)
   - stable `data-frame` and heading ids, and never renaming ids that have comments
5. **The kit:** device frames, theme tokens, article components (`references/kit.md`).
6. **Writing style for articles:** `references/writing.md`.
7. **Micro apps:**
   - use `@artifacts/kit/data` for anything that must persist
   - add a backend only when the frontend store isn't enough
   - keep a `schema` number in stored values
   - provide fixtures
8. **Gate:** `artifacts lint`, then `artifacts render`, then **look at what you made** (read `.artifacts/contact-sheet.png` if there are frames, and run each prototype in `artifacts dev`), fix, repeat; publish only on a clean lint.
9. **Review loop on "address the comments":**
   1. `artifacts comments --open --json`, and download each crop and look at it
   2. fix the source
   3. `artifacts publish -m "…" --note frame=…` for each changed frame
   4. `artifacts reply <n> "<what changed>" --fixed` for each addressed thread

   Never resolve a person's thread. If a comment is ambiguous, reply with a question and leave the thread open.
10. **Lifecycle:** archive finished artifacts when asked; never delete without being asked; never try to purge.
11. **Sharing:** `artifacts teams`, and `share --team` for its own work.
12. **Report back:** the URL, the version, what changed, and which threads were marked fixed.

**References:**
- `references/manifest.md`: the schema with examples
- `references/kit.md`
- `references/writing.md`
- `references/micro-apps.md`: the data API and the backend handler, with examples
- `references/lint.md`: every rule with fixes
- `references/theme.md`: the theme fields and tokens
- `references/brand.md`: fitting Artifacts to a brand guide, `brand.json`, and font licensing
- `references/stageshow.md`: publishing scenes made with Stageshow, a third-party skill, to a canvas
- `references/templates/<name>.md`: when to use each template, and how to structure it. Structure only, and agents may skip them.
