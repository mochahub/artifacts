# CI execution and performance

`CI` still runs on branch and main pushes. The required job remains `check`.
It requires successful static/build, unit/API, and browser smoke jobs, running
on separate ephemeral Blacksmith runners. Each test job owns its compose stack;
unit and browser tests never reset each other's database. Failure, cancellation,
or unexpected skipping fails the aggregate. Superseded runs on the same branch
are cancelled. Release keeps its existing `workflow_run: CI` success trigger and
SHA selection; release publishing itself is never cancelled by CI concurrency.

## Default gate

- Static/build: Biome, TypeScript, migration/schema consistency, viewer and server
  builds, compiled CLI smoke and dotenv isolation, Docker build, viewer size budgets.
- Unit/API: the unfiltered `bun run test`, including the complete API route coverage
  check. Authentication, permission, atomicity and security boundary tests remain.
  Further reduction requires the separately reviewed test-quality changes; this
  workflow does not silently substitute a hand-picked subset for route coverage.
- Browser: `bun scripts/ci-browser-smoke.ts` preflights and runs
  `--project=desktop --grep @smoke`. Exactly one desktop flow in each of
  `sign-in.e2e.ts`, `viewer.e2e.ts`, and `editing.e2e.ts`, plus three claim/setup
  prerequisites, is required. These check session persistence, rendered artifact
  navigation/history, and editor typing/modes/suggestions/save. Missing tags fail
  before starting Docker. Integrate the companion smoke-tag changes with this workflow.

`Full browser matrix` runs nightly at 05:23 UTC and through Actions' manual
workflow dispatch. It runs the unchanged full Playwright configuration: iPhone,
desktop, iPad pointers, Chromium/passkeys/offline and setup. It uploads failure
traces independently and does not gate `check` or trigger Release. Failures remain
visible as failed scheduled/manual runs, rather than being swallowed.

A branch push changing only root Markdown and/or Markdown beneath `docs/` may
skip executable checks only when the cumulative diff from the merge base with
`origin/main` contains only those paths. A documentation follow-up push cannot
hide an earlier code change. New branches, missing/invalid diff bases, empty diffs and
all other paths run everything. Renames inspect both sides. Schema, migrations,
workflow/config, lockfiles, executable docs, skill Markdown and shipped template
Markdown always run everything. Main always runs the full default gate, even for
Markdown, so a release can never consume a docs-skipped main CI. Expensive main
validation is retained: a green branch SHA does not validate the merged main SHA.

## Caches and reuse

`setup-ci` uses official setup-bun and actions/cache. Bun's package download cache
is scoped by OS, architecture, pinned Bun version file and lockfile. Frozen install
always runs; node_modules is not restored. Browser binaries use the same scope,
which includes the locked Playwright version. System dependencies are installed
on every runner; a browser cache hit cannot supply those libraries.

`viewer-build` caches only `apps/viewer/dist`. Its exact key hashes tracked app,
package and script contents, root package/lock/Bun/TypeScript configuration and
its own action, plus OS/architecture. It deliberately has no prefix restore.
Generated dist, node_modules and local ignored files cannot contaminate the key.
The CLI build and e2e scripts accept `ARTIFACTS_PREBUILT_VIEWER=1` only when the
workflow has produced/restored that build, and reject a missing index. Their
normal local/release behavior still builds fresh. No auth state, tokens, fixture
credentials, prepared uploads, database state or test results enter any cache.
Fixture publication reuse belongs to the companion test-quality changes.

Cache content is executable build input, not a security boundary. Only repository
push workflows write these caches; release does not restore the viewer cache or
consume branch CI artifacts. Permissions are contents:read, with no release or
provider secrets in CI. GitHub branch cache scope still applies. No new hosted
service, provider call, or paid caching feature is enabled.

Official guidance reviewed:
[actions/cache](https://github.com/actions/cache),
[setup-bun](https://github.com/oven-sh/setup-bun),
[Blacksmith transparent caching](https://www.blacksmith.sh/blog/cache), and
[Playwright CI caching](https://playwright.dev/docs/ci#caching-browsers).
Blacksmith supports upstream actions transparently; its old cache fork is not
needed. Playwright cautions browser restore may cost as much as downloading;
measure cache transfer times before attributing savings to this cache.

## Timing evidence and limits

The supplied green run 42452121158 took **9m49s**: browser installation 31s,
unit/API 206s, full browser 330s, sequentially; Bun setup 0s, lint 4s and Docker
build 5s. This is the baseline, not a local remeasurement.

The new dependency graph is validated, but no new hosted run has been launched.
Its estimated critical path is:

`changes + max(static/build, install + 206s API, install + smoke) + aggregate`

If smoke takes less than the API branch and the supplied timings hold, the
uncached API branch is about **237s (3m57s)** plus checkout/install, path-gate,
aggregate and queue overhead. This is a conditional estimate, not a measured
4-minute CI result. The 330-second full browser phase leaves the default gate;
that changes coverage frequency and must not be described as faster execution of
identical coverage. Smoke duration remains to be measured. Unit/API still includes
real CLI rendering integration tests; caching does not make their runtime vanish.
The companion worker reports a separate local seven-test fixture improvement of
47.37s to 17.19s with 69 assertions retained, and 31 focused units in 175ms; these
are not hosted whole-suite timings and are not subtracted from this estimate.

Local validation: actionlint 1.7.7 on CI/full-browser/unchanged release (existing
Blacksmith labels allowed), full lint (82 existing warnings, no errors), changed-file Biome, TypeScript build, production
viewer/server builds, Linux CLI cross-compilation, native macOS CLI version smoke,
size budgets, migration generation with no diff, 21 private temporary-repository
path cases, and 192 aggregate result combinations. Local Bun was 1.4.2; CI pins
1.4.4. The integrated smoke selection is exactly three desktop flows plus three claim
prerequisites. Companion browser acceptance passed all six tests in 42 seconds;
the final focused verification does not reset that stack or rerun browsers.
