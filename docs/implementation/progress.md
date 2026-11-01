# Progress: building M2–M19

A fresh agent can resume from this file alone. Read [SCOPE-teams-projects-google.md](SCOPE-teams-projects-google.md) for the current brief, then this.

## Status

| Milestone | Branch | Last commit | CI |
|---|---|---|---|
| M0 Spikes | `main` history | `fafc2f6` | n/a |
| M1 Foundations | `m1-foundations` | `9de1ffc` | green (run 41045711327) |
| M2 Sign-in and CLI skeleton | `m2-sign-in` | `e6b5af8` | green (run 41048009618) |
| M3 Publishing | `m3-publishing` | `ae1a852` | green (run 41050356260) |
| M4 Viewer | `m4-viewer` | `530c18a` | green (run 41052782581) |
| M5 Review loop | `m5-review` | `84a68ad` | green |
| M6 People and sharing | `m6-people` | `d79e2a1` | green |
| M7 Lifecycle | `m7-lifecycle` | `7c59d9e` | green |
| M8 Distribution | `m8-distribution` | `9356dac` | green |
| M9 Micro apps I | `m9-micro-apps` | `0eb0aeb` | green |
| M10 Micro apps II | `m10-backends` | `7708f14` | green |
| M11 Live review | `m11-live` | `b4977b5` | green |
| M12 The hosted library | `m12-library` | PR #21 | see the PR |
| M13 Templates, guides and theme | `m13-templates` | PR #22 | see the PR |
| M14 Brand setup | `m14-brand` | PR #23 | see the PR |
| M15 OAuth, hosted MCP and publishing | `m15-connector` | PR #24 | see the PR |
| M16 Articles without the CLI | `m16-articles` | PR #25 | see the PR |
| M17 Teams | `m17-teams` | PR #29 | see the PR |
| M18 Project access | `m18-project-access` | PR #33 | see the PR |
| M19 Google sign-in | `m19-google` | see the PR | see the PR |

## Verified

- **M1 fixes (2026-10-30):** `bun run lint` clean, `bun run test` 79 pass, `bun run e2e` 6 pass locally. CI green on `9de1ffc`.

- **M2 (2026-10-30):** 220 tests including the full permission matrix; every API route reached by a test (`scripts/route-coverage.ts`); 12 Playwright WebKit tests at iPhone and desktop size. `artifacts setup --docker` ran for real from a locally built image in a sandboxed home: compose up, claim, `whoami`, `doctor`, all passed, then torn down.
- **M3 (2026-10-30):** real WebKit: the CameraBuddy fixture (26 frames, 8 articles, 9 pages) publishes; republishing uploads 0 files and reports no changes; a shared-CSS edit reports only the frame whose pixels changed; a Markdown edit reports only that block. Lint catches seeded overlap, clipping, nondeterminism, home indicator, offscreen, contrast (warning), missing, absolute and outside references, bad ids and a bad manifest. Mermaid and chart SVG pass the article allowlist with no `<style>` or `foreignObject`.

- **M4 (2026-10-30):** Playwright WebKit at iPhone size and desktop against the real fixture: lists, search, filters, artifact page, page switcher, version history, 26 frames drawn with one changed, frames list, deep links, pinned versions, synthesized touch pan and pinch, double-tap, keyboard, article blocks, embeds, tables without page overflow, settings surviving a reload. Screenshots: `docs/mocks/shots/`. Compared by eye with boards 01–03; found and fixed the overview layout and cover crop.

- **M5 (2026-10-30):** the automated round trip passes with the real CLI and fixture: a person comments and requests changes; `status` and `comments --open --json` show it, with a crop that downloads; the agent edits and publishes, and `threadsOnChanged` names the thread; `reply --fixed`; a token can't resolve, a person can. Re-anchoring has unit tests for frames, blocks, moved quotes, repeated quotes and the threshold. Renaming a commented frame stops the publish. Skill install writes both folders under a sandboxed home.

- **M6 (2026-10-30):** full permission matrix, 328 tests, every one of 70 routes reached. Passkeys: a software authenticator covers registration, sign-in, re-auth, Related Origin Requests, and refuses no user verification, foreign origins, the content host, replayed and expired challenges; a Chromium virtual authenticator covers the real browser flow. WebKit e2e covers invites, guests, revocation and settings.
- **M6 independent review (subagent, 2026-10-30):** 15 findings, all fixed with tests. The worst: passkey-only accounts accepted the dummy password in the source.

- **M7 (2026-10-30):** API tests for every lifecycle transition, purge erasing rows, data and crops while leaving one tombstone, the slug rule, GC keeping referenced, young and removed-version blobs, the 30-day job. `versions`, `diff`, `restore`, `archive`, `delete` and `undelete` via the real CLI. WebKit e2e for the menu, delete sheet, deleted link, Recently deleted, version history and Activity.
- **M8 (2026-10-30):** the release dry run built the image (with sharp loading and encoding inside it) and all five CLI binaries, with `SHA256SUMS`. The compiled macOS binary renders in WebKit via `BUN_BE_BUN`. **Clean machine (`scripts/clean-install-test.sh`):** a bare Debian trixie container with its own Docker daemon, a non-root user, no Bun or Node: `install.sh` verified the checksum and installed, then `artifacts setup --docker` claimed a working server, and `whoami` and `doctor` passed. The Railway path passes against a fake `railway` binary only; **it has not run on Railway.**

- **M7–M8 independent review (subagent, 2026-10-30):** 12 findings plus 4 small ones, all fixed. It also removed `oven/bun:1.4.2` and `seaweedfs:4.50` from the local Docker cache; they re-pull when needed.

- **M9 (2026-10-30):** `spikes/s8-csp-sandbox.ts` in WebKit: the CSP's `sandbox allow-scripts` with module scripts, fonts, relative `fetch`, preflighted `api/`, `audio`, `video` and `track`, `frame-ancestors`, and an opaque origin at the top level all pass. The data API has tests for conditional writes, racing writers, separate `me` data, keys, limits, files, export, clear, archived and guests. WebKit e2e: the poll works with no backend, two people's `me` stay apart, Try it and Done, and a second window can't use the bridge.
- **M10 (2026-10-30):** the four design checks in `spikes/s10/`. 24 sandbox tests: isolation, no globals, timeouts, floods and recursion, teardown in flight, a dead child, empty environment, read-only for viewers and archived, old versions run their own code, log and size caps, rate limit, queue limit. A real backend ran **inside the Docker image**, via `setup --docker`, publish, a vote and `artifacts logs`. `artifacts dev` serves the real viewer and a backend with no server.
- **M10 independent review (subagent, 2026-10-30):** 12 findings, all fixed, with tests for each that could fail. The worst: a frame could reach any `/api/*` route with the viewer's session through `..` in a data key.
- **M11 (2026-10-30):** 432 tests, 74 Playwright tests plus 4 that apply to one device only. SSE across a real server, including inside the Docker image; a listener recovering from a cut Postgres connection through a TCP proxy. Web Push against a local fake push service: payloads decrypted by a separate RFC 8291 implementation in the test, VAPID signature and claims verified; the reviewer also matched RFC 8291's Appendix A vector byte for byte. The Chromium e2e reloads a version with no network, then signs out and checks the kept data is gone. **Web Push has not reached a real push service or a real device.** Load figures: [load-notes.md](load-notes.md), local only.
- **Compiled binary (2026-10-30):** a final check found `bun build --compile` had been failing since M10, because `host.js` was imported as both code and text; CI didn't build the binary. Fixed, and CI now builds and runs it. On the macOS binary: `artifacts mcp` spawned itself correctly, and `artifacts dev` installed its helpers, served the viewer and ran a backend.
- **M11 independent review (subagent, 2026-10-30):** 12 findings and one spec gap, all fixed. The worst: a model-supplied MCP argument could send the token to another server.

- **M12 (2026-10-31):** 774 tests, every one of 108 routes reached; Playwright 75 passed. `packages/cli/test/library.e2e.test.ts` is the agent-style script, with the real CLI against a real server: the art style fixture of image-only frames is found by search from an unrelated folder, its card and pages read, a frame viewed as a real WebP at two sizes, and pulled; publishing the pull uploads 0 files and changes no frame. A fresh clone with no `artifact.json` finds its project from an `https://user:password@` remote. The local MCP returns cards, text and an image block, and starts with no server. Search permissions cover owner, member, reviewer, outside, guest, organization token and anonymous. `bun run e2e` passed 75 of 76 in one full run: the backend poll failed on iPhone, then passed alone on both devices with no change, so it looks like load on one machine. Watch it in CI.

- **M13 (2026-10-31):** every template initializes, lints with no errors or warnings, renders in WebKit and publishes, through the real CLI. One accent changed pixels in at least one frame of all seven, and reached the article page's `meta.theme`. Hostile theme values are refused by the manifest and dropped by the code that writes CSS. A WebKit e2e checks the theme lands on the article body and nowhere else. The agent looked at all seven contact sheets, and changed the slides after that.

- **M14 (2026-10-31):** `packages/cli/test/brand.e2e.test.ts` runs the real CLI from a sample `brand.json` to a preview, a published sample every template appears in, a reviewer's comment on it, and a person applying it. Tokens, including the owner's, get 403 on applying and on clearing. Precedence, taking a brand off, a font that isn't in the sample, and rendering from the cache with the server stopped are all covered. The font file in the test is a stand-in, so no real font has been drawn through this path.

- **M15 (2026-11-01):** a scripted OAuth client, with no browser, covers discovery from a 401, registration, PKCE, code exchange, refresh, revocation, and every negative case in the brief (`apps/server/test/api/oauth.test.ts`). `packages/cli/test/connector.e2e.test.ts` runs the whole loop with a real CLI that has no sign-in: pack, upload, commit, search, read, view, read comments, reply. **No real client has connected:** nothing here has met Claude Code or Codex.

- **M16 (2026-11-01):** `apps/server/test/api/articles.test.ts` publishes from a plain HTTP client with no filesystem or shell, then reads it through the viewer's route, `read`, search and `pull`'s bundle. An XSS payload comes out as a CLI publish's does, and the stored HTML is unchanged by sanitizing it again. That test also found that M13's `:::stats`, `:::compare` and `:::steps` never survived the allowlist, because the attribute name didn't match. Fixed on `m13-templates`, with a test.

- **M13 follow-up (2026-11-01):** rendering a template's article by eye found what no test had: `:::steps` collapsed to one word a line, and a `:::` after a table showed on the page. The second was Biome, which formats Markdown and had rewritten the fence into a table cell, so `packages/kit/src/templates` and `skill/references/kit.md` are now outside it, and a test checks every template. **Don't run `biome check --write` on Markdown that uses directives.**

- **M17 (2026-11-01):** the existing matrix is unchanged: all 3,828 results for the old callers and actions were dumped from `5400f6e` and compared after the change, with no differences. New rows cover team grants at each level, the role cap, token-made rows alone and tied, and who runs a team. `apps/server/test/api/teams.test.ts` and `events.test.ts` cover every team route, sharing, `via_token`, removal, revocation, and streams closing within a heartbeat for a session and a token. `packages/cli/test/teams.e2e.test.ts` runs the real CLI. A WebKit e2e makes a team and shares with it at iPhone size and desktop, with screenshots in `docs/mocks/shots/08-*`.

- **M18 (2026-11-01):** open projects match M17 exactly: all 7,524 results dumped from M17 compared with no differences. The matrix now has an open and a restricted dimension, and a second table of every caller against a project. `apps/server/test/api/projects.test.ts` covers the leak list across session and token: search, snippets, counts, project lists, activity, home, push digest, MCP and bundle. An independent review (subagent) raised eight findings and three smaller issues. Six were fixed with a test that failed first. The commit race and the permission checks outside `can()` were changed without one. What's left is under Known gaps.

- **M19 (2026-11-01):** `apps/server/test/api/google.test.ts` runs a scripted fake Google, injected through `Deps`, through every row of the flow table and the negative cases: wrong, reused, expired and other-browser `state`, wrong `nonce`, `aud`, `azp` and `iss`, an expired token, `email_verified` false or missing, re-auth with a different `sub` or from another session, Workspace auto-join including `gmail.com` and a removed person, and reset and removal deleting identities. An independent review (subagent) found no high-severity bugs and two medium ones. Those two and three low ones were fixed with a test that failed first. The re-auth message and the device code were fixed in the viewer, with no failing test first. **It has never met the real Google.** Nothing here was run against a real client, and the Google screens in the e2e use mocked answers.

## Decisions to review

1. **M2, Docker image before M8.** `setup --docker` needs an image that can't be pushed yet, so `apps/server/Dockerfile` came forward from M8 and `--image`/`ARTIFACTS_IMAGE` overrides the default `ghcr.io/mochahub/artifacts:<version>`. To change: nothing needed once images are released.
2. **M2, `Secure` cookies.** Left off only on plain-http viewer origins, or local Compose and e2e couldn't sign in. HTTPS origins always get it. To change: `isSecureRequest` in `apps/server/src/auth/sessions.ts`.
3. **M2, tokens and invites.** 04 said no token manages people, but SPEC §10 has `artifacts org invite` and `org reset-link`. SPEC wins on behaviour: a new action, `people.invite`, lets an admin's CLI token print those links. Role changes and removal stay people-only. To change: drop `people.invite` from `canOnOrg` and remove the CLI commands.
4. **M2, the "Approve the CLI?" copy.** Board 06 says "Can't invite, share outside or change settings", which isn't true: the CLI shares, and an admin's invites. The page says "Can't resolve threads, approve versions or delete anything for good", which is. To change: `apps/viewer/src/routes/device.tsx`.
5. **M2, member added with `view`.** 04 lists members as commenters, but that would make `view` meaningless on a private artifact, so `view` wins. To change: `mayComment` in `can.ts`.
6. **M2, org tokens need `read` to publish.** 04's actions apply "after visibility", so a CI token needs `read` and `publish`, and can't reach `me` artifacts. Org tokens can't comment, as 04's table says, so a CI agent can't reply. To change: `mayComment` and `seesArtifact`.
7. **M2, Keychain fallbacks.** 07 listed `security`, `secret-tool` and PowerShell fallbacks. `Bun.secrets` already uses those stores, so the CLI goes straight to the 0600 file if it throws. To change: `packages/cli/src/credentials/index.ts`.
8. **M2, client IP.** Taken from the socket, or from the last `X-Forwarded-For` entry when the peer is a private address (Railway, a local proxy). Without a proxy in front of Compose, a client could vary that header to dodge per-IP limits. To change: `clientIp` in `server.ts`.
9. **Screenshots** go in `docs/mocks/shots/<board>-<screen>-<name>.png`, written by the e2e run.

10. **M3, a `blobs` table (new, not in the design).** Blobs are shared by hash, so "the bucket has this key" isn't proof of content: anyone with a presigned PUT could store junk under a hash a later publish would then reuse. Now a hash counts as stored only once the server has hashed it, and presigned PUTs carry `If-None-Match: *`. Each blob is read once at commit. To change: drop the table and trust the bucket, in `apps/server/src/publish/blobs.ts`.
11. **M3, upload ids carry state.** `uploadId` is a signed ticket rather than a row, so an abandoned publish leaves nothing in Postgres, and a new artifact's row only appears at commit.
12. **M3, no `<style>` in articles.** 05 allowed `style` without `url()`, but a `<style>` applies to the whole viewer page. The helper copies Mermaid's styles onto attributes instead, and the allowlist drops `style` entirely.
13. **M3, charts.** `::chart` takes `{ type: "bar"|"line", labels, series }` and the CLI draws plain SVG, with no browser. 05 had said WebKit, without a format.
14. **M3, no render cache.** Publishing always re-renders. Output is deterministic, so unchanged frames still upload nothing. To change: add a cache keyed by input hashes in `render.ts`.

15. **M4, two-column canvas on tall screens.** 06 said left to right, but board 02 draws 2×2, and looks beat the text (README). Wide screens keep one row.
16. **M4, "changed" compares with the previous version,** not the version you last read. Board 03 says "since you read v3". Doing that needs a comparison base per person, which arrives with compare in M7.

17. **M5, `frames/renamed` has no rename guess.** 07 asked for the likely rename by pixel similarity. It says what's gone and stops if comments would be orphaned, which is the part that protects anything.
18. **M5, a comment on a resolved thread leaves it resolved.** SPEC only says a reply to a *fixed* thread reopens it. Reopen is an explicit button.
19. **M5, crop links last about a day, not an hour.** They use the same day-stable presigned URL as renders, so phones keep them cached.

20. **M6, "Copy" on a pending invite makes a new link.** 06 says copy "the link again", but 02 stores only a hash, so it can't be shown again. Copying rotates it and the old link stops. Share links work the same way: shown once, revoked by row.
21. **M6, the Share sheet has no "Nothing" option.** Links are many per artifact, so "nothing" means no live links; each has a Revoke.
22. **M6, an admin can't reset an owner's password.** Otherwise an admin could take over an owner account. Owners use `artifacts recover`.

23. **M6 review, turning link sharing off stops existing links** at once, and turning it back on restores them. SPEC only says admins can turn it off. To change: remove the check in `liveLink` and `guestCaller`.
24. **M6 review, an admin's token can invite only members and reviewers,** and can't issue a reset link for an admin or itself; otherwise a token could mint itself a browser session, which 04 forbids. The viewer has no such limit.

25. **M8, `artifacts setup` on Railway needs `ARTIFACTS_RAILWAY_TEMPLATE` until the template exists.** There's no piecewise fallback. To change: add `railway add` steps in `packages/cli/src/railway/setup.ts`.
26. **M8, no Windows installer,** only the binary in the release, because Windows is untested.
27. **M8, `ARTIFACTS_RAILWAY_HTTP`** exists only so tests can reach a fake server over http.

28. **M10, the Web APIs live in the sandbox, not in each backend.** 08 had them bundled per backend. A prelude means smaller backends and one copy to fix. Agents see the same globals.
29. **M10, `env.DATA` covers `get`, `put`, `delete` and `list`, not files yet.** SPEC says "the same calls as the built-in store". Files through a backend need binary over IPC, and no fixture needs it. To add: the `files.*` cases in `applyData` and the prelude.
30. **M10, backend bodies are text.** Binary request and response bodies aren't supported, for the same reason.
31. **M9, `artifacts dev` is read-only for review.** Comments need a server. It runs pages, live frames, the data store and backends.

32. **M10 review, `env.DATA` caps:** 8 calls at once and 200 per request, in the child, plus `writesPerSecond`. 08 asked for the write limit; the rest is new. Logs get 1 MB per artifact per minute.
33. **M10 review, inline files are a list:** PNG, JPEG, GIF, WebP, AVIF, any audio or video, and PDF. Everything else downloads.

34. **M11, `?c=` holds the thread number, not a comment id.** SPEC says `?c=<commentId>`, but M5 built numbers, and they're readable in a URL. Thread numbers are per artifact, so links stay short.
35. **M11, unfurls come only from share links.** SPEC says every link has a preview, but crawlers have no cookie, so a preview of a private link would hand its title and picture to anyone who pastes the address. `/<project>/<artifact>` shows the org's name. To change: `apps/server/src/http/unfurl.ts`.
36. **M11, the VAPID keys are made on first use,** not first boot: on first boot there's no org row. Same keys, same place.
37. **M11, push goes to the publisher and thread participants,** including the person whose token an agent used. SPEC doesn't say who. There's no per-artifact mute.
38. **M11, pushes belong to a session.** New column `session_id`: signing out, or a session ending, stops that device's pushes.
39. **M11, the service worker fetches renders through the app** (`?via=app`) rather than from the bucket, because an opaque answer can't be checked and would keep a failure forever. First open of each picture uses app bandwidth when a worker is active.
40. **M11, limits nobody asked for:** 10 streams per caller, 5 minutes per stream, 60 searches and 30 compares with new diffs a minute, 10 devices per person.
41. **M11, compare diffs at most 40 frames** per pair; more changed frames are still listed, without pictures.
42. **M11, the install sheet has no "Show me where" button** from board 05, screen 6: there's nothing yet for it to show. And the data events aren't passed on to frames, so a frame doesn't update live; it reloads what it needs.
43. **`GITHUB_RELEASES_REPO` defaults to `mochahub/artifacts`,** so the notice needs no setup; `none` turns it off, and it stays silent while the repo is private. To change: the default in `apps/server/src/env.ts`.
44. **Releases are automatic.** Green CI on `main` releases the next patch, unless only docs or workflows changed. The version comes from the latest tag and is stamped at build time, so there are no version commits and `package.json` stays at the version of the first release. To choose a version, raise it in `packages/cli/package.json`, or run the workflow by hand. To go back to deliberate releases: remove `workflow_run` from `release.yml`.
45. **A release tries itself first:** the new binary runs `setup --docker` against the new image, and nothing is published if that fails. A failure after the image is pushed is safe to re-run.

46. **M12, the library is a separate set of routes.** `/api/search` keeps its shape for ⌘K and gains `content`; agents use `/api/library/*`, which `/api` keeps out of the way of project slugs. The hosted MCP (M15) calls the same functions in `apps/server/src/library/`.
47. **M12, archived artifacts in search.** SPEC §5.5 hides them from search, and `/api/search` didn't, which was a bug, now fixed. But `outcome.archived` exists so an agent can see a dropped experiment, so `/api/library/search` includes them unless `archived=false`. SPEC §5.5 now says so. To change: the filter in `librarySearch`.
48. **M12, `repo` stays `owner/name`.** The handoff said to normalize remotes, and existing rows hold `owner/name`, so that's the form, lowercased: two hosts with the same owner and name would match each other. To change: `normalizeRepo`, and migrate the rows.
49. **M12, no search index beyond blocks and comments.** Titles, summaries and notes are read through each artifact's latest version, a primary-key join, so an index wouldn't be used. Stemming is English only: other languages match whole words, and CJK text mostly doesn't match. See Known gaps.
50. **M12, `manifest/summary` doesn't stop `render`.** A draft can still be looked at. `lint` and `publish` fail on it. Whether the summary is any good isn't checked.
51. **M12, cursors are offsets, not keysets.** Rank has no stable key, so a publish between two pages can repeat or skip a card. An agent reading a list loses nothing important.
52. **M12, `pull` restores what was published, not the working folder.** `artifact.json`, the backend's source and `fixtures/files/` are now stored with each version so it can; versions from before that keep none of them. Files nothing references were never uploaded. Converted images come back as WebP under their old name, which is what publishing would make again.
53. **M12, the bundle route presigns everything.** Bucket URLs need no token, so the CLI downloads directly, and that's why `pull` needs no content-host change. Anyone with `artifact.read` could already see these files through a frame, including `__backend.js`.
54. **M12, `export` leaves out frame renders.** `artifacts render` makes them again, and a project's worth is gigabytes. To add: the renders are listed by `/api/artifacts/:id/versions/:n`.
55. **M12, `isBundlePath` applies at commit from now on,** so a new publish with `../` or `.git` in a path is refused. Older rows are filtered by the bundle route and again by the CLI.

56. **M13, `templateTheme` is new.** A template's look has to lose to a brand and to `theme`, so it can't live in `theme`, and articles only get what's in the manifest, so it can't live in `style.css`.
57. **M13, article templates carry a cover frame.** A contact sheet only shows frames, and the handoff wants renders compared. The cover is a one-frame canvas page, embedded at the top of the article with `::frame`, and it's what cards and share links show.
58. **M13, `font` stays a free name, within a pattern.** Tightening it to a list would fail manifests that say `"inter"`, as SPEC's example did. A name we don't know becomes a family with a system fallback, which M14's bundled brand fonts use.
59. **M13, an article's accent is an underline and a rule, never text colour.** A brand colour has to read on both of the viewer's themes.
60. **M13, a reader's font choice wins** over an article's `font`, once they've made one.
61. **M13, SPEC §8's "glass material" is gone.** The handoff bans it for templates, and the kit never had it.

62. **M14, a proposal is a row, and the sample is an ordinary artifact.** Applying copies the brand to `org.brand`. That's no extra machinery for review: people use the viewer as they always do.
63. **M14, no activity row for applying a brand.** `activity_kind` has no value for it, and a feed entry can wait.
64. **M14, the sample drops each template's own palette.** Its pages share one manifest, so `templateTheme` can't differ per page; a brand with no neutrals shows on the kit's. A real template keeps its neutrals until the brand sets them.
65. **M14, brand fonts don't reach articles.** The viewer's CSP loads fonts from its own origin, and serving a publisher's font files from there isn't worth widening it. An article names the family and shows a fallback. To change: add a route that serves them, and `font-src`.
66. **M14, a brand applies to every render,** including artifacts that aren't from a template. Only CSS that reads the tokens changes, and article accents.

67. **M15, built on MCP `2026-07-28`, with the older handshake kept.** That revision dropped `initialize`, but clients in use may not have moved, and the handoff has to work with them. The server does both, and sessions don't exist in either.
68. **M15, publishing has two plans, not one list.** Prepare is called twice: once to get the payload up, once to read it. A list of signed URLs in a tool result would cost a model thousands of tokens, and it would have to copy each one, so plans live in the bucket and the model passes one link.
69. **M15, `artifacts_publish_prepare` takes the file list from the payload.** The handoff asked only for the commit payload to be a blob; the file list has the same problem.
70. **M15, access tokens are opaque rows in `tokens`,** not JWTs. Revocation is immediate, and there's one code path for every bearer.
71. **M15, every code and refresh failure on a matched code burns it.** A wrong PKCE verifier revokes the grant.
72. **M15, connectors sign as "Connector" in replies.** The token carries no agent name. To change: send a client's name.
73. **M15, consent needs a recent sign-in,** like approving a device. On a phone that's one more passkey prompt.
74. **M15, a connector is listed per consent,** so reconnecting a client adds a row rather than replacing one.
75. **M15, no CORS on the token endpoint.** A browser-only client couldn't finish. Native and server-side clients are unaffected.
76. **M15, the local MCP** answers `server/discover` as well as `initialize`.

77. **M16, no images through the article tool.** A client with no files has no way to give them, and the brief allowed limiting it. `artifacts pack` covers them.
78. **M16, article-only means one page called `doc`.** Anything else would lose its other pages, so it's refused.
79. **M16, the pipeline moved to `packages/schema`,** which already held the sanitizer. Its packages moved with it; there are no new ones.
80. **M16, Mermaid is refused,** because drawing it needs a browser, which the server doesn't run.

81. **M15, `Origin` is checked at `/api/mcp` even with a good token.** The transport requires it, and the CSRF rule exempts bearer requests.
82. **M15, declining a connector needs no recent sign-in.** Only approving does.

83. **The stack ships as 0.2.0, not a patch.** It changes `init`'s default and adds a lint error, and raising `packages/cli/package.json` is how `release.yml` takes a chosen version.

84. **Every token is shown as an agent.** A comment from a token with no detected agent used to read as the person's own. Now the server marks it, and shows it as "Zahin's agent". Rows from before this have no mark, and can't be told apart. Pushes for a publish stay tied to a named agent, so someone at their own terminal isn't told what they just did.

85. **M17, a publisher keeps managing after a demotion.** The scope applies the role cap to rule 2, but today a member made a reviewer still manages what they published, and "nothing changes on upgrade" wins. The cap holds for every grant, which is what the rule is for. To change: the publisher line in `effective()`.
86. **M17, a team lead must be a member or above.** The scope doesn't say. Leading hands out the team's access, including project `manage`, and a role capped at commenting shouldn't do that. The route refuses it, and `can()` also ignores a lead who has since become a reviewer.
87. **M17, people search includes outside people.** A lead has to find one to add them to a team, and the user decided outside people can join.
88. **M17, a token sees a team's name, size and shared work, but not its members.** The user's decision keeps the directory in the browser, and a member list is the same data by another route.
89. **M17, a team's page lists only shared work the caller can see.** Anything else would name a private artifact to any member.
90. **M17, `inherit()` lives in `can.ts`.** Both loaders call it, so what a grant adds up to is pure, and the matrix runs through it.
91. **M17, `/api/activity` and the digest load artifacts in one batch.** The scope expected up to 200 extra lookups; the batch is fewer queries than before.
92. **M17, a token can't refresh an invite that has teams,** as well as not making one. A fresh link is the same way in.
93. **M17, team rows an agent added show "Confirm so they can approve"** in the Share sheet, which grants the same level again as a person.

94. **M18, project "Can publish" counts as a comment on an artifact,** worked out in `inherit()`, so `can()` needs no special case and the matrix covers it.
95. **M18, a new action, `artifact.share_outside`.** The scope wants links and outside invites to need `manage` in a restricted project, and `artifact.share` is also true for the publisher. It covers adding an existing outside person, and sharing with a team that has one in it, which the M18 review found was a way round.
96. **M18, purging stays with the publisher and admins, and so does `data.export`.** The scope's list for `manage` stops at archive and delete, and purging can't be undone. A project manager who deletes can restore.
97. **M18, a new route, `POST /api/projects/:slug/access`.** The scope says an unknown email becomes an outside invite, and `POST /api/invites` is for admins, while project managers can be members. Invite kind `project` is new too.
98. **M18, a token can read project access, as `artifacts project access` needs, without addresses or team members.** A member list and addresses are the directory, which the user kept in the browser. The same goes for `inherited` on an artifact's access; a reviewer who published loses it in the browser too.
99. **M18, `audience` on status goes to those who can share the artifact,** and organization tokens. Anyone else needn't learn who was let in. A publish always gets it. `Only the publisher` leaves out admins, who can see everything anyway.
100. **M18, `findOrg` fills in defaults instead of casting.** It didn't parse `settings` at all, so a stored row without `defaultProjectAccess` had no value. `PatchOrg` no longer uses `OrgSettings.partial()`, because Zod fills a `.default()` inside `.partial()`, and saving one setting would have reset this one to `org`.
101. **M18, the Tokens page gained a project chooser.** A restricted project has to be named on a token, and Settings had no way to name one.
102. **M18, brand proposals hide a sample the caller can't see,** and proposing one answers the same for a hidden artifact as for none. Neither was in the scope; both named restricted artifacts.
103. **M18, a token can't issue a reset link for someone who leads a team or manages a project.** A session is what a token may never have for those powers. This extends 24.
104. **M18, the commit checks `project.publish` again inside its transaction** for a new artifact, because a project can appear or be restricted after `target()` looked. A concurrent first publish to an open project still works, as it did.

105. **M19, three columns beyond the scope on `org`:** `google_enabled` and `google_tested_by`, because "only after a round trip by that admin" has to be stored somewhere, and new credentials clear both.
106. **M19, a new route, `POST /api/auth/reauth/check`.** The re-auth sheet retries a call, and a redirect isn't one, so the viewer confirms someone first and then follows the link.
107. **M19, `email_verified` is required on every path, including a known `sub`.** The scope requires it for a match by email; the brief says to match on `sub` and require it, so a known account whose email Google no longer vouches for is refused.
108. **M19, a test links nobody and signs nobody in.** It proves the credentials. An admin connects their own account afterwards.
109. **M19, one Google account per person,** by a unique index. The scope's Settings lists "the linked account".
110. **M19, a linked Google account can have any address.** The person has just proved they hold the account, so it needn't match.
111. **M19, session-bound round trips refuse a request from another site** by `Sec-Fetch-Site`. Sign-in has to start with a link because of CSP, and a link can be followed from anywhere. Linking stays safe without this, because of `state`, but a forced re-auth shouldn't be possible.
112. **M19, auto-join refuses anyone with a removed person's email.** Otherwise an open door on the domain would undo offboarding. To re-add them, invite them.
113. **M19, an invite's name comes from Google,** not the field on the page, because a link can't carry it.
114. **M19, the invite secret isn't kept in `google_states`,** so a failed invite round trip lands on `/sign-in`, not back on the invite. The link still works.
115. **M19, auto-join's teams can be set by the API, not yet in Settings,** which sets the domain only, as a member. Choosing a role and teams there can come later.

116. **M19, a new table, `removed_identities`.** The scope has removal delete identities, and it does. But a Google account can have any address (110), so the email check alone would let someone removed back in through auto-join. It holds only a hash of `sub`, and only auto-join reads it.
117. **M19, someone with no password or passkey can't turn Google off, replace the client or remove it.** They'd be unable to confirm it's them, or undo it.
118. **M19, a test only counts for the credentials it used,** so ones saved while it ran stay unproved.
119. **M19, `google_states` cascades from invites,** and the daily job clears expired rows. Without that, an abandoned invite round trip would have blocked purging that invite's artifact.

## Needs you

In this order. Nothing here has been done or tested by the agent.

**Before anyone can install it**
1. **Merge, which is also the first release:** `git push origin m11-live:main` (a fast-forward; the branches are stacked and no pull requests were opened). When CI passes, `release.yml` publishes 0.1.0: the image to `ghcr.io/mochahub/artifacts`, the binaries and `install.sh`. From then on every merge that changes what ships releases the next patch. For a minor or major: `gh workflow run release.yml -f bump=minor`.
2. **Go public, when you want strangers to install it:** `gh repo edit mochahub/artifacts --visibility public --accept-visibility-change-consequences`, then set the `artifacts` package to public in its GitHub settings. While the repo is private, `install.sh` and the upgrade check can't reach releases, and each release warns if the image needs a sign-in.
3. **npm, optional:** `bun add -g` won't work until this is done, and the installer doesn't need it. Make sure you control the `@artifacts` scope (the package name is free, the scope's owner wasn't checked) or rename in `packages/cli/package.json`, then `gh secret set NPM_TOKEN`. The next release publishes; until then the step skips.

**Railway (it creates billable resources)**
4. **S1 templates:** `railway templates create` per `deploy/railway/README.md`, then `railway deploy --template`. Check that one service gets two generated domains, what a bucket's variables are called, and that `${{secret()}}` works. The Railway path has only passed against a fake `railway`.
5. **Phase 1 acceptance 2:** on a machine with only the CLI, `export ARTIFACTS_RAILWAY_TEMPLATE=<code>`, then `artifacts setup`. Time it: the target is under 10 minutes.
6. **Bill and memory:** after a few days, compare the real bill and app memory with SPEC §7.5 and update its table. [load-notes.md](load-notes.md) has the local numbers.
7. **Phase 2 acceptance 4:** have someone outside deploy the template and publish, within 15 minutes.

**On a real iPhone, over 5G**
8. **Phase 1 acceptance 1:** publish `fixtures/camerabuddy-roadmap` and review it in Safari, including the comment sheet over the real keyboard and Safari's bottom bar. Then, in a fresh agent session, using only the skill: comment, fix, republish, reply.
9. **The look:** compare with `docs/mocks/boards/` and the forbidden patterns (06). Screens are in `docs/mocks/shots/`.
10. **Safari and presigned GETs:** open an artifact, reload, and check in Web Inspector that images come from cache on the same day.
11. **The Share path:** check "Tap More, then Share" against where Share sits in Safari's ⋯ menu (board 05 screen 6, `apps/viewer/src/components/install.tsx`).
12. **Passkeys:** add one on the home domain, sign in on a second domain (Related Origin Requests), and try the "Sign in on the home domain" fallback. Repeat in desktop Chrome (S2).
13. **Phase 2 acceptance 1:** add the site to the Home Screen, open it, allow alerts after a comment. Leave a comment from a second device and watch it arrive live. Have an agent reply with the app closed: a push should arrive, and tapping it should open that comment. This is the first time Web Push meets Apple's service.
14. **Offline:** in the installed app, open an artifact, turn on Airplane Mode, reopen it.
15. **Real media:** publish a gallery with a video and play it in Safari; it depends on the bucket answering Range requests.

**Other**
16. **Phase 1 acceptance 3 and 4 by hand:** invite a teammate, and comment through a share link from outside. Both pass in tests.
17. **Link previews:** paste a share link into iMessage and Slack.
18. **Windows:** the CLI, including credentials, is untested.
19. **MCP:** add `artifacts mcp` to a real client. It's tested against the protocol, not a client.

**Teams, project access and Google (M17 to M19; none of this has been checked by you yet)**
20a. **A real Google client on the Railway server,** including the redirect URIs. Settings, Sign-in, Google sign-in lists them. Then press Test, and turn it on.
20b. **App verification:** whether a client using only `openid`, `email` and `profile` needs Google's verification, and how Internal and External consent screens differ.
20c. **Hosts:** whether `*.up.railway.app` and `*.ts.net` hosts pass Google's redirect rules. A LAN address won't, and localhost is an exception.
20d. **Passkey and Google on the same account on a real iPhone,** including an app added to the Home Screen, which may open Google somewhere that doesn't share its cookies.
20e. **Restrict a real project,** then confirm from a second account that it's gone from search and the connector.
20f. **A taste review of the Share sheet and Teams settings on a phone.** Screens are in `docs/mocks/shots/08-*`, `09-*` and `10-*`.

**Connectors (none of this has been tried with a real client)**
20. **Claude Code:** `claude mcp add --transport http artifacts <url>/api/mcp`, then sign in with `/mcp`.
21. **Codex:** add the server, run `codex mcp login artifacts`, and try `bearer_token_env_var` on a remote box.
22. **Remote sessions:** whether connectors reach cloud or remote sessions. This wasn't verified for any client.
23. **Passkey consent** on a real iPhone: approving a connector when a recent sign-in is needed.
24. **Template taste:** review `docs/images/templates.webp` and the contact sheets on a phone.

## Known gaps

- **Two admins saving settings at the same moment** can overwrite each other, because `PATCH /api/org` writes the whole JSON.
- **An invite to a removed person's address stays live.** That's true of passwords too.
- **Starting a second Google round trip in the same browser** ends the first: there's one `art_google` cookie.

- **Auto-join and Google round trips can't be retried:** the re-auth redirect returns to the page, and the person taps again (04).
- **Turning Google off leaves Google-only people with no way in** until an admin issues a reset link.

- **A project manager can't make a link for their own `me` artifact in a restricted project.** Project grants don't reach `me`, so `can()` doesn't see them there. An admin can, or they can make it `org`. It fails closed.
- **`/api/deleted` shows what someone deleted, after they lose access to it,** until it's purged: only the title of something they could already see.
- **Taking `manage` from someone leaves their pending project invites live.** An admin sees them in Settings, People, and can revoke them.
- **A few body-dependent token guards sit in routes, not `can()`:** a token giving a team `publish`, inviting into a team, and the reset-link guard. They follow `guardTokenInvite`, because `can()` doesn't see a request's body.

- **Search is English-stemmed, and rows are read for every search.** Numbers are in [load-notes.md](load-notes.md).
- **Working folders are per git worktree.** `.artifacts/work/` isn't shared between worktrees of one repo. `artifacts pull` is the way across.

- **Backends sharing a child stall each other.** A busy loop in one backend blocks the others pinned to the same child until its deadline, up to 10 seconds. SPEC says "without slowing others". 08's pinning makes this true per child, not per backend; more `sandboxProcesses` reduces it.
- **The render tests** share one helper install in the temp folder and the machine's WebKit cache.
- **The reauth sheet** has no e2e test yet, because the e2e server's clock can't be moved. The API side is tested.
- **A view-only stream outlives lost access by up to 5 minutes.** Events hold no content, so it learns only that something changed.
- **The worker's revocation is blunt:** a 404 on any artifact address, a mistyped one included, clears everything kept offline on that device. It costs a re-download, nothing else. Guests' `/api/me` answer clears it too, so guests get almost no offline copies.
- **Offline has only been tested in Chromium,** not WebKit or Safari: Needs you 15.
- **A device offline when its access ends keeps its copies** until it next reaches the server. A cached render opens without asking the server.
- **The digest is one count, with no time zone:** it goes out when the daily job runs.
- **Service-worker revocation and the sign-out push path** have no e2e test: the first needs losing access mid-session, the second a real push subscription.
