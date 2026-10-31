# 01 · Repo and tooling

## Layout

The SPEC §11 layout, in more detail:

```
apps/
  server/           Bun + Hono. src/{index.ts, server.ts, env.ts, s3.ts, http/, auth/, api/, content/, internal/, publish/, review/, data/, sandbox/, realtime/, push/, jobs/, db/}
                    drizzle/ (generated migrations), test/
  viewer/           Preact + Vite. src/{routes/, components/, canvas/, article/, live/, styles/}, e2e/
packages/
  schema/           zod: src/{manifest.ts, api.ts, messages.ts, sanitize.ts}; exported types
  cli/              src/{commands/, railway/, docker/, bundle/, article/, render/, lint/, dev/, credentials/, skill/}, test/
  kit/              src/{frames/, tokens.css, article.css, data.js, backend.js}: plain JavaScript and CSS, vendored as they are by `artifacts init`
  sandbox/          src/{host.js, child.js, prelude.js}: the backend sandbox (08), shared by the server, `artifacts dev` and `render`
skill/              SKILL.md, references/
deploy/
  railway/          README.md, template notes
  compose/          docker-compose.yml (prod), docker-compose.dev.yml, docker-compose.test.yml
fixtures/           camerabuddy-roadmap/, micro-app-poll/, micro-app-poll-backend/, gallery/
docs/               SPEC.md, evaluations, implementation/, mocks/, review/
.github/workflows/  ci.yml, release.yml
scripts/            dev.ts, test.ts, e2e.ts (behind the root scripts); build-cli.ts, route-coverage.ts, install.sh, clean-install-test.sh
```

## Tooling

| Need | Choice |
|---|---|
| Runtime and package manager | Bun (pinned in `.bun-version`), with workspaces in the root `package.json` |
| Language | TypeScript, `strict: true`, project references per package |
| Lint and format | Biome (one config at the root; it skips ignored files, like Playwright's `.auth.json`) |
| Dependency updates | Dependabot: bun, Docker, Compose and Actions, weekly, minor and patch grouped |
| Server framework | Hono on `Bun.serve`, one app per port |
| Database | Postgres 17 (Railway Postgres in production), Drizzle ORM and drizzle-kit, the `postgres` driver |
| Object storage | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| Public suffixes | `tldts`: the "same site" warning needs real Public Suffix List data, because a last-two-labels check fires on every Railway deploy |
| Images | `sharp` (spike S5) |
| WebAuthn | `@simplewebauthn/server`, `@simplewebauthn/browser` |
| Markdown | unified, remark-parse, remark-gfm, remark-directive, remark-rehype, rehype-slug, rehype-sanitize |
| Crawling bundles | htmlparser2, postcss, es-module-lexer |
| Rendering | `playwright-core` with WebKit (CLI only) |
| Viewer | Preact, @preact/signals, preact-iso, Vite, size-limit |
| Icons | lucide (per-icon imports) |
| Tests | `bun test`; Playwright Test for viewer e2e |
| Backends | `quickjs-emscripten` (pinned), in child processes of the app (08); `bun build` for bundling artifact backends |

Keep dependencies few and well known. A new dependency needs a reason in the PR description.

## Conventions

- **Errors:** route handlers throw `ApiError(code, message, details)`, and one middleware formats them as in 03.
- **Validation:** every request body is parsed with the zod schema from `packages/schema` at the edge. Handlers receive typed input.
- **Permissions:** every handler calls `can()` before touching data. A test asserts every route is registered with an action (a route list compared to an allowlist of public routes).
- **Queries:** all go through `db/` helpers that require `orgId`.
- **Time:** `now()` comes from an injectable clock, so tests can move time (purge, expiry, sessions).
- **Commits:** small and focused, with messages in plain English. Never commit or push unless the user asked (see HANDOFF).

## Scripts (root `package.json`)

| Script | Does |
|---|---|
| `bun run dev` | Starts the compose dev services, the server with watch (on `.env.example`), and Vite on 5173 |
| `bun run test` | Starts the test stack (`docker-compose.test.yml`), then runs unit, data-model, permission and API tests |
| `bun run e2e` | Starts the test stack, builds the viewer, runs Playwright (files are `*.e2e.ts`, so `bun test` skips them) |
| `bun run lint` | Biome and typecheck |
| `bun run build` | Builds every package and app |
| `bun run size` | Checks the viewer size budget |
| `bun run format` | Biome, writing the fixes it can make |
| `bun run db:generate` | Generates a migration from `apps/server/src/db/schema.ts` |
| `bun run cli -- <args>` | Runs the CLI from source (from M2) |

## Working with the mocks

The mock boards are HTML in `docs/mocks/boards/` that use `docs/mocks/kit.css` and `kit.js`. To view them, and to read and leave comments:

```
cd docs && python3 -I review/server.py --port 8788
# phone review over Tailscale (the user does this):  tailscale serve --bg --https=8788 http://127.0.0.1:8788
```

- `review/comments.json` holds review comments (git-ignored).
- `GET /comments.md` lists them as Markdown.
- `docs/mocks/tools/shoot.mjs <playwright package dir> <out dir> <board…>` screenshots boards. Install Playwright first: `bun add -d playwright-core` (or `npm i playwright`) and `bunx playwright install webkit`. Pass the package's folder as the first argument.
