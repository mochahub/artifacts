# Contributing

Thanks for helping. This file covers how to run the project, how to write a commit, and the rules that keep the docs and the code in step. For how the system fits together, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). To report a vulnerability, follow [SECURITY.md](SECURITY.md) and don't open a public issue.

## Prerequisites

- **Bun**, the version in [`.bun-version`](.bun-version). Install it with `curl -fsSL https://bun.sh/install | bash -s "bun-v$(cat .bun-version)"`, or use `oven-sh/setup-bun` in CI.
- **Docker**, running. `bun run dev`, `bun run test` and `bun run e2e` start Postgres 17 and SeaweedFS in containers.
- Nothing else. The CLI downloads WebKit the first time it renders, and the e2e script builds the viewer itself.

## Commands

```sh
bun install --frozen-lockfile
bun run dev      # Postgres, SeaweedFS, the server (watching) and Vite on 5173
bun run test     # unit, data-model, permission and API tests (needs Docker)
bun run e2e      # Playwright in WebKit, at iPhone size and desktop (needs Docker)
bun run lint     # Biome and the TypeScript build
bun run format   # Biome, fixing what it can
```

Also: `bun run build`, `bun run size` (the viewer's JavaScript budget), `bun run db:generate` (a migration from `apps/server/src/db/schema.ts`) and `bun run cli -- <args>` (the CLI from source).

`bun run dev` serves the viewer on `http://localhost:5173` and the server on 8080, with Live previews on 8081. The first visit shows the setup page. Claim it with `bun run cli -- setup http://localhost:8080`, using `SETUP_TOKEN` from [`.env.example`](.env.example).

### Running one test

`bun run test` and `bun run e2e` both recreate the test stack so every run starts from nothing, which also resets a stack another run is using. For one file, start the stack once and call the runner yourself:

```sh
docker compose -f deploy/compose/docker-compose.test.yml up -d --wait
bun test --timeout=30000 apps/server/test/permissions.test.ts
bun test --timeout=30000 -t "purge" apps/server    # by test name
```

A full `bun run test` also checks that every API route was reached by a test (`scripts/route-coverage.ts`), which a single file can't.

For one e2e file, pass it to the script, which hands its arguments to Playwright:

```sh
bun run e2e review.e2e.ts
bun run e2e --grep "comment sheet"
```

Files that end in `.e2e.ts` are Playwright tests. `bun test` skips them.

## Layout

```
apps/server/      Bun + Hono: the three ports, auth, publish, review, data store, sandbox pool, jobs, Drizzle migrations
apps/viewer/      Preact + Vite: shell, canvas, article, comments, settings. e2e/ holds the Playwright tests
packages/schema/  zod schemas for the manifest, API and bridge messages, shared by everything
packages/cli/     the artifacts CLI (Bun, compiled to one binary): setup, publish, lint, render, dev
packages/kit/     the design kit, plain JavaScript and CSS, copied into artifacts by `artifacts init`
packages/sandbox/ the QuickJS backend sandbox: child process, prelude, parent side
skill/            SKILL.md and its references, installed for Claude Code and Codex
deploy/           railway/ (the template) and compose/ (Docker Compose, dev and test stacks)
fixtures/         artifacts used by tests and acceptance: camerabuddy-roadmap, micro-app-poll, gallery
docs/             SPEC.md, ARCHITECTURE.md, implementation/, mocks/, review/
scripts/          the scripts behind the root commands, the CLI build and the installer
```

Details are in [01 Repo and tooling](docs/implementation/01-repo-and-tooling.md).

## Commits

Commit messages must be [Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject`. The subject is in the imperative mood and plain English, under 72 characters.

```
fix(viewer): keep the comment sheet above the keyboard
feat(cli): add artifacts versions name
docs: explain the content domain
```

| Type                                      | Use it for                           |
| ----------------------------------------- | ------------------------------------ |
| `feat`                                    | A new feature                        |
| `fix`                                     | A bug fix                            |
| `perf`                                    | A change that makes something faster |
| `docs`, `test`, `refactor`, `chore`, `ci` | What the name says                   |
| `revert`                                  | Undoing an earlier commit            |
| `build`, `style`                          | Also fine                            |

Scopes are `server`, `viewer`, `cli`, `schema`, `sandbox`, `kit`, `deploy` and `docs`. A scope is optional.

Releases are automatic. After green CI on `main`, [`release.yml`](.github/workflows/release.yml) releases the next patch, with notes generated from the merged pull requests. So:

- A merge that only changes `docs`, Markdown files or `.github` releases nothing. Any other merge releases a patch, whatever its commit type.
- For a minor or a major, run the Release workflow by hand and pick the bump.
- CI doesn't check commit messages, so the conventions above are yours to keep.

Don't edit version numbers. They are stamped at build time, and `package.json` stays as it is.

## Keep the contract documents in step

[docs/implementation/](docs/implementation/README.md) holds the documents the code is built from. Seven of them are contracts, which own names and shapes:

| Document                                                                     | Owns                                                                 |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [02 Data model](docs/implementation/02-data-model.md)                        | Tables, columns, enums, bucket prefixes                              |
| [03 HTTP API](docs/implementation/03-api.md)                                 | Ports, paths, shapes, headers, error codes                           |
| [04 Sign-in and permissions](docs/implementation/04-auth-and-permissions.md) | Callers, cookies, tokens, scopes, the permission matrix, rate limits |
| [05 Publishing and storage](docs/implementation/05-publish-and-storage.md)   | The manifest, renders, block ids, re-anchoring, clean-up             |
| [07 The CLI and the skill](docs/implementation/07-cli-and-skill.md)          | Commands, flags, config, lint rule ids                               |
| [08 Micro apps](docs/implementation/08-micro-apps.md)                        | Bridge messages, data store limits, the sandbox                      |
| [09 Deploying](docs/implementation/09-deploy.md)                             | Images, environment variables, the template, releases                |

**A change to code that a contract describes changes the contract in the same commit.** That covers a route, a flag, an environment variable, a table or a column, a lint rule id or a limit. If the two disagree, a reader can't tell which is right. [SPEC.md](docs/SPEC.md) wins on behaviour, and the contract wins on names. If you need to change behaviour that the spec states, say so in the pull request.

Schema changes go through `bun run db:generate`, and CI fails if the committed migrations don't match `schema.ts`. Migrations only add: a new table, a nullable column or an index. Never edit a generated migration.

## Tests

- Every route calls `can()` before it touches data, and a test compares the route list to an allowlist. A new route needs an action in the permission matrix test.
- Every API route must be reached by some test.
- Fix a bug with a test that fails without the fix.
- Time comes from the injectable clock, so tests can move it.
- A new dependency needs a reason in the pull request. Keep them few.

## Viewer design rules

The look comes from the mock boards in [`docs/mocks/boards/`](docs/mocks/boards/). The rules are in [06 The viewer](docs/implementation/06-viewer.md#design-rules-keep-the-look-avoid-generic-patterns). In short:

- The canvas is dark (`#1b1d22` with a faint dot grid). Pages follow the system theme.
- **Yellow `#ffd84d`** is a person's mark: pins, highlighted text, open counts, Resolve and Post.
- **Violet `#8f7cff`** is an agent's change: version numbers, changed-frame outlines, changed-paragraph dots, agent replies.
- Titles use the system serif. Everything else uses the system UI font.
- Copy is in sentence case, and a button says what happens ("Request changes").

**Forbidden patterns.** These were rejected on purpose. A change that adds one will be sent back.

- A coloured bar down the edge of a card, thread or quote.
- Sparkle icons for AI or agents. Agents sign with initials in a violet rounded square ("Cl", "Cx").
- Tinted pill backgrounds on word labels. Labels are coloured words, and only numeric counts get a filled badge.
- Middle dots joining text ("A · B"). Use commas or separate lines.
- "›" or "→" appended to link text. A version range such as "v4 → v5" is fine.
- Gradient washes as decoration.

The viewer's first route must stay at or under 80 KB of gzipped JavaScript (`bun run size`). Touch targets are at least 44 pt, nothing depends on hover, and inputs are at least 16 px so Safari doesn't zoom.

## Pull requests

- Title the pull request as a Conventional Commit, and write every commit in it the same way: CI checks each one, and the commits on `main` set the release.
- Keep it small and focused, and run `bun run lint` and `bun run test` first. Run `bun run e2e` if you touched the viewer.
- Fill in the checklist in the pull request template.

## More

[docs/implementation/README.md](docs/implementation/README.md) lists every guide, says which document wins when two disagree, and has a glossary. [progress.md](docs/implementation/progress.md) records decisions, known gaps and what hasn't been tested on real devices.
