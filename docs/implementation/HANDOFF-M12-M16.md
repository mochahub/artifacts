# Handoff prompt: build M12–M16

The prompt below is for the next building agent's first message. It extends [HANDOFF.md](HANDOFF.md), and it replaces that file's "stop at each milestone" rule for this run. Copy the whole block.

````text
You're taking over **Artifacts**, an open-source, self-hosted system for publishing and reviewing what coding agents make. Build milestones M12 through M16 in order, autonomously. Don't stop at milestone boundaries unless a stop condition below applies.

## The product direction

Agents stay free to build any UI. Artifacts adds three things around that freedom:

1. **A hosted library.** Content lives on the server by default, and committing it to git is optional. A later agent can find, skim and open it almost as easily as local files.
2. **Good starting points.** Beautiful, editable templates for daily work, which fit a company's brand. They're never required.
3. **A connector.** A hosted MCP server, signed in with our own login, makes remote boxes easy to set up in tools like Claude Code and Codex.

## Read first

1. `CONTRIBUTING.md`, all of it. The contract-document, migration, route-coverage and viewer design rules all apply.
2. `docs/implementation/HANDOFF.md`, then `docs/SPEC.md`, then `docs/implementation/README.md`.
3. `docs/implementation/progress.md`, for decisions and known gaps.
4. Each contract document (02 to 09) before you change what it owns.
5. These files:
   - `apps/server/src/api/lists.ts`: `/api/search` and `visible()`
   - `apps/server/src/publish/routes.ts`: `prepare` and `commit`
   - `apps/server/src/api/device.ts`: the device flow
   - `apps/server/src/auth/can.ts` and `resolve.ts`: callers, scopes and agent limits
   - `packages/cli/src/commands/mcp.ts`, `write.ts`, `packages/cli/src/skill/install.ts`
   - `packages/schema/src/manifest.ts`
   - `skill/`, `packages/kit/src/`

## Decisions by the user (don't revisit)

- Never prescribe content. Subject matter and screens are the agent's call. Templates and guides cover structure only, and agents may skip them. Board guidance is suggestive, with no lint rule.
- `artifacts init --template <name>` copies editable starters, with a guide per template.
- Theme tokens are wired up, and templates fit a company's design guide.
- Setup gives a sane default, plus a prompt the user hands to their agent to fit the brand guide.
- Content lives on the server by default. Git is optional.
- `artifacts pull` and a whole-project export ship in the same release as that default.
- The MCP and skill let agents search, browse and read hosted content.
- **Selective disclosure:** every artifact has a small, length-capped frontmatter that tells an agent what the full document holds without loading it. Many can be paged through without blowing up context.
- There's a hosted MCP, usable as a connector from Codex and Claude Code.
- The hosted MCP can publish. The client renders and the server stays browserless.
- OAuth runs on our existing email, password and passkey login.

## Proposed defaults (use them, but they aren't the user's decisions)

If evidence goes against one, change it and record why in `progress.md`.

- Postgres full-text search, with no new service. No semantic search yet.
- New artifacts live in a gitignored `.artifacts/work/<slug>/`, and `--in-repo` keeps today's layout.
- Git remote matching finds a repo's project. The session pointer is unproven: the user said it "might work".
- `artifacts mcp install` is opt-in, and setup doesn't register the MCP by default, to avoid duplicate tools.
- Org brand is the default and a project's `theme` overrides it.
- First templates: design review, presentation, case study, PRD, RFC, research report, weekly status.
- Presentations are canvas boards of 16:9 frames, with no `deck` page kind yet.
- Text contrast stays a warning for existing artifacts, but every template must pass it. Ask before making it an error.
- `summary` is at most 280 characters, and `tags` at most 8 of at most 32 characters.

## Rules that are easy to miss

- **Slugs:** `/:project` is a catch-all, so new top-level viewer paths collide with project slugs. Prefer paths under `/api/` or an already reserved word such as `device`. If you add a reserved word, check for existing projects using it. `.well-known` paths can't be slugs.
- **Origins:** MCP and OAuth go on viewer origins only, never the Live-preview origin. An OAuth issuer and resource must match the origin the client used, including `MORE_URLS` and the home domain.
- **Route tests:** every new route needs a `can()` action, an entry in the permission matrix test, and a test that reaches it. Otherwise a full `bun run test` fails. That includes public metadata routes.
- **Migrations:** only add. Run `bun run db:generate`, and never edit a generated migration. Every new table has `org_id`.
- **Binary packaging:** the CLI is one compiled binary. A new skill file ships only when it's in `FILES` in `packages/cli/src/skill/install.ts`. Template text needs text imports, as `write.ts` does for the kit. Binary template assets need another route: prefer SVG and CSS.
- **Search visibility:** every search, list and read goes through the same `can()` checks as the viewer. A hidden artifact must not leak through a count, snippet or summary. `visible()` loads every artifact on each search, so check its cost.
- **Agent limits:** agent tokens stay limited to undoable actions. Only people resolve and decide.
- **Untrusted text:** comments, summaries and articles can come from other people, including guests. Tool results must mark them as untrusted data, never instructions.
- **Context cost:** keep the MCP to a small tool set, with short descriptions.
- **Design:** follow the forbidden patterns in `CONTRIBUTING.md`. Also avoid frosted glass, pills on every label and violet for agent-related template UI, even though `SPEC.md` lists glass material. Templates should have a distinct identity, not the kit's iOS blue.
- **Public repo:** before every commit, grep what's staged for `/Users/`. Never publish a local path or macOS username.

## M12: The hosted library

**Frontmatter**
- Add optional `summary` and `tags` to the manifest. Enforce the caps in `packages/schema`, and store them per version.
- A missing `summary` is a new lint error, `manifest/summary`, because discovery depends on it. Old versions stay valid on the server, and fall back to a truncated first block of text.
- Update `artifacts init`, the skill and `references/manifest.md`. The skill should tell agents to write what the artifact holds and why it mattered, because image-only work such as art style studies has little other text.

**Search**
- Extend `/api/search` to article text in `blocks`, frame titles, summaries, tags, version notes and comments, on each artifact's latest version.
- Add an index with an additive migration. Keep the viewer's ⌘K working, and let it show body matches.

**Disclosure tiers**
- `search` and `list` return only compact cards: project, slug, title, summary, tags, status, outcome, latest version, updated time and a match snippet.
- Results use a cursor, with a default page of 20 and a maximum of 50.
- `outcome` shows approval, requested changes, open comment count and archived state, so an agent can tell whether an experiment won or was dropped.
- `list` goes from projects to artifacts to pages and frames, only as deep as asked.
- `read` and `view` are the only tools returning full content. `read` is paged. `view` returns a thumbnail by default, and a larger render on request.
- Add a test that fixes a maximum response size per card.

**Tools in both the local MCP and CLI**
- `search`, `list`, `read`, `view`, as `artifacts_*` tools and CLI commands with `--json`.
- They work without `artifact.json`.

**Project matching**
- Publish already sends `repo`. Normalize SSH and HTTPS remotes, strip credentials, and look up projects by it.
- Tools accept an optional `repo`.

**Discovery**
- Widen the skill's description so it covers checking hosted artifacts before research, design or prototyping, and add that step to `SKILL.md`.
- Add `instructions` to the MCP's `initialize` response, with the core rules.
- The local MCP can read the git remote, so it may name the project and artifact count.
- A hosted connector can't see the client's repo. Its instructions stay generic and tell the agent to call `artifacts_search` with its git remote.
- Don't rely on syncing into a gitignored folder: ripgrep skips those by default.

**Server-first storage**
- `init` writes to the gitignored working folder by default, and `--in-repo` keeps today's layout.
- `status`, `publish`, `comments` and the rest must still find the artifact from the repo root.
- `artifacts pull <project>/<slug> [--version <n>]` restores a working folder. Check whether `artifact.json` is in stored bundles. If it isn't, store it from now on, and rebuild a manifest for old versions.
- `artifacts export <project>` writes every artifact in a project with its versions, comments and decisions.
- Pull and export must ship in the same PR stack as the new default.

**Tests**
- Fixture: an art style project of image-only frames, with summaries and tags. An agent-style script finds it by search from a different folder, reads the card, views a frame, and pulls it.
- Pull, then publish unchanged, makes no content change.
- Permission tests for search hits, snippets and counts, across member, reviewer, outside, guest, org token and CLI token.
- Search works in a fresh clone with no `artifact.json`.
- A context-budget test: 100 search results across pages stay under a fixed size.

## M13: Templates, guides and theme

- Add missing kit components as the templates need them: navigation, tab bar, sheet, toggle, icons, plus article callouts, stats and comparisons that work from Markdown. Check how the article sanitizer and directives work first.
- Put templates under `packages/kit/src/templates/<name>/`. `artifacts init --template <name>` copies them in. `--kind` keeps working.
- Add a guide for each in `skill/references/templates/`: when to use it, and how to structure it. For boards: one board per journey, frames in flow order and titled, variants side by side, and the decision the reviewer is being asked for.
- Wire up `theme`. Extend it to neutrals, radius and type where needed, with validated values. The CLI turns it into tokens at render. Articles get the allowed values through page meta, and the viewer applies them only inside the article body. The review UI keeps its own look.
- Fix the `tokens.css` comment if it's still inaccurate.

**Tests**
- Every template initializes, lints with no errors or warnings, renders and publishes.
- Change one accent: every template follows it. Compare renders.
- A malicious theme value can't inject CSS into the viewer.
- Add contact sheets to the PR description. Look at them yourself. Beautiful is a requirement here, not a nice-to-have.

## M14: Brand setup

- A sane default ships for everyone.
- `artifacts setup` ends by printing a prompt the user can hand to their agent, to fit Artifacts to their brand guide.
- `artifacts brand` reads, previews and proposes an org brand. It publishes a sample artifact of the templates for review.
- A person applies it in Settings. An agent token can't change it, in line with "only undoable" and the lack of `manage` scope.
- The CLI fetches and caches the org brand for rendering, and works offline from the cache. Project `theme` wins over it.
- Brand fonts ship in the bundle, because lint bans external fonts. The prompt and guide must mention licensing.

**Tests:** brand precedence, a stale cache, permissions, and an agent-driven run from a sample design guide to a reviewed sample.

## M15: OAuth, hosted MCP and publishing

**OAuth**
- Run our server as its own OAuth 2.1 authorization server, using the existing email, password and passkey sign-in, plus a consent screen in the viewer's style.
- Implement Protected Resource Metadata, authorization server metadata, PKCE S256, resource indicators with audience-bound tokens, the `iss` response parameter, refresh with rotation, and revocation.
- Accept both Client ID Metadata Documents and Dynamic Client Registration. Clients vary, and DCR is deprecated but retained for compatibility.
- Build against the latest released MCP specification, not the draft, and read it first. Read its security considerations in full, including open redirects, confused deputies and SSRF when fetching client metadata.
- Reuse the `tokens` table and scopes: `read`, `comment` and `publish`, never `manage`. Sessions appear in Settings, and can be revoked.
- Existing CLI tokens work as a static bearer fallback. Codex supports `bearer_token_env_var`, and Claude Code supports `--header`. A token from a provider we don't issue is never accepted.

**Hosted MCP**
- Streamable HTTP, on a path that avoids slug collisions, such as `/api/mcp`.
- Tools: `search`, `list`, `read`, `view`, `status`, `comments`, `reply`, `versions` and the publish tools below. They call the same server functions as the API, with `can()` on each.
- Serve the templates and guides as MCP resources, so a connected agent has guidance with no local skill.
- `artifacts mcp install` writes the URL to Claude Code and Codex config, opt-in.

**Publishing through MCP**
- The client renders. The server never runs a browser.
- Add `artifacts pack`: lint and render, then write a publish payload to a local folder.
- Tools mirror the API: one returns signed upload URLs, and one commits. Files never pass through MCP. The client uploads straight to the bucket.
- Commit payloads hold frames and block text, and can be large. Upload that payload as a blob too, and commit by hash, rather than passing it in tool arguments. Verify it as strictly as `/api/publish/commit` does today.
- The remaining box requirement is the CLI and WebKit for canvases. Say so plainly in the docs.

**Tests**
- A scripted OAuth client covers the full flow with no browser: discovery, registration, PKCE, code exchange, refresh and revocation.
- Negative tests: wrong audience, wrong PKCE, redirect mismatch, expired code, reused code, reused refresh token, wrong origin.
- An OAuth token can't resolve, decide, delete permanently or manage.
- The full loop through the hosted MCP, on a box with no login: search, read, pack, upload, commit, read comments, reply.
- MCP over multiple origins issues the right metadata.
- Guest text in tool results is marked untrusted.

## M16: Articles without the CLI

- Move article building to code the server can share. It already sanitizes article HTML.
- An MCP tool publishes Markdown with a required `summary`, with no CLI and no renderer. Size limits and sanitizing match the normal path.
- Limit it to article-only artifacts with no local images, or define how images upload.

**Tests:** publish from a client with no filesystem or shell, then read it through the viewer and `read`. An XSS payload is sanitized the same way as a CLI publish.

## Throughout

- Docs change with code: `SPEC.md` where behaviour changes, each contract document, `11-milestones.md` (add M12 to M16 first, in its format), `progress.md`, `README.md`, the skill and `SECURITY.md`.
- State the changed spec behaviour in the PR description.
- Run `bun run lint`, `bun run test`, `bun run size` and `bun run e2e` when you touch the viewer.
- Use the injectable clock in tests. Fix each bug with a test that fails without the fix.
- New dependencies need a reason in the PR. Prefer none for OAuth primitives Bun already provides, but don't hand-write what's easy to get wrong.

## Git

- Work in a new worktree under `.claude/worktrees/`, based on `origin/main`. Never switch branches in the main checkout, and check `git log origin/main` and `ListAgents` for other sessions first.
- First commit this handoff file, which is untracked in the main checkout, to your branch.
- Use one branch per milestone, each started from the previous, with Conventional Commits and scopes from `CONTRIBUTING.md`.
- Push when a milestone's checks pass, and confirm CI is green. Open a PR for each milestone, stacked on the previous one.
- **Don't merge to `main`.** Any merge outside docs cuts a release. The user reviews the stack and decides.
- Don't force-push, and don't skip hooks.

## Off limits without the user

- Deploying to or changing the hosted Railway server, the local Docker server, or the user's real config, Keychain or skills. Test with a scratch `XDG_CONFIG_HOME`, `HOME` and `ARTIFACTS_CREDENTIALS=file`.
- Releases, publishing packages, or anything that announces the work.

## Stop and ask only if

- A user decision above turns out to be impossible or unsafe.
- A change would break existing published artifacts, or need a migration that isn't additive.
- A security requirement can't be met.

For anything else, make the call, record it in `progress.md`, and continue.

## Needs the user

Add these to "Needs you" in `progress.md`. Don't claim they passed.

- `claude mcp add --transport http` and sign-in, in real Claude Code.
- Adding the server and `codex mcp login` in real Codex, and `bearer_token_env_var` on a remote box.
- Whether connectors reach cloud or remote sessions. This wasn't verified for any client.
- Passkey consent on a real iPhone.
- A taste review of template contact sheets on a phone.

## When you finish

Report the PR for each milestone, CI state, what you tested and how, what you didn't test, every default you changed, and the "Needs the user" list.
````
