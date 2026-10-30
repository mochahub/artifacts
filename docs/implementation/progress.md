# Progress: building M2–M11

A fresh agent can resume from this file alone. Read [HANDOFF-M2-M11.md](HANDOFF-M2-M11.md) for the brief, then this.

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
| M11 Live review | `m11-live` | see git log | see the last line of Verified |

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
43. **M11, `GITHUB_RELEASES_REPO` has no default,** and the notice can't work while the repo is private.

## Needs you

In this order. Nothing here has been done or tested by the agent.

**Before anyone can install it**
1. **Merge:** the branches are stacked, `m1-foundations` through `m11-live`. Merge `m11-live` into `main`. No pull requests were opened.
2. **npm scope:** check `@artifacts/cli` is free on npm, or pick another name in `packages/cli/package.json`.
3. **Release:** push a tag, which runs `.github/workflows/release.yml` to publish the image to `ghcr.io/mochahub/artifacts`, the binaries and `install.sh`. Check the image is public: `docker pull ghcr.io/mochahub/artifacts:<version>` signed out. If the repo stays private, `install.sh` and the upgrade check can't reach releases.
4. **`GITHUB_RELEASES_REPO`:** set it in the compose file and the template once releases are public.

**Railway (it creates billable resources)**
5. **S1 templates:** `railway templates create` per `deploy/railway/README.md`, then `railway deploy --template`. Check that one service gets two generated domains, what a bucket's variables are called, and that `${{secret()}}` works. The Railway path has only passed against a fake `railway`.
6. **Phase 1 acceptance 2:** on a machine with only the CLI, `export ARTIFACTS_RAILWAY_TEMPLATE=<code>`, then `artifacts setup`. Time it: the target is under 10 minutes.
7. **Bill and memory:** after a few days, compare the real bill and app memory with SPEC §7.5 and update its table. [load-notes.md](load-notes.md) has the local numbers.
8. **Phase 2 acceptance 4:** have someone outside deploy the template and publish, within 15 minutes.

**On a real iPhone, over 5G**
9. **Phase 1 acceptance 1:** publish `fixtures/camerabuddy-roadmap` and review it in Safari, including the comment sheet over the real keyboard and Safari's bottom bar. Then, in a fresh agent session, using only the skill: comment, fix, republish, reply.
10. **The look:** compare with `docs/mocks/boards/` and the forbidden patterns (06). Screens are in `docs/mocks/shots/`.
11. **Safari and presigned GETs:** open an artifact, reload, and check in Web Inspector that images come from cache on the same day.
12. **The Share path:** check "Tap More, then Share" against where Share sits in Safari's ⋯ menu (board 05 screen 6, `apps/viewer/src/components/install.tsx`).
13. **Passkeys:** add one on the home domain, sign in on a second domain (Related Origin Requests), and try the "Sign in on the home domain" fallback. Repeat in desktop Chrome (S2).
14. **Phase 2 acceptance 1:** add the site to the Home Screen, open it, allow alerts after a comment. Leave a comment from a second device and watch it arrive live. Have an agent reply with the app closed: a push should arrive, and tapping it should open that comment. This is the first time Web Push meets Apple's service.
15. **Offline:** in the installed app, open an artifact, turn on Airplane Mode, reopen it.
16. **Real media:** publish a gallery with a video and play it in Safari; it depends on the bucket answering Range requests.

**Other**
17. **Phase 1 acceptance 3 and 4 by hand:** invite a teammate, and comment through a share link from outside. Both pass in tests.
18. **Link previews:** paste a share link into iMessage and Slack.
19. **Windows:** the CLI, including credentials, is untested.
20. **MCP:** add `artifacts mcp` to a real client. It's tested against the protocol, not a client.

## Known gaps

- **Backends sharing a child stall each other.** A busy loop in one backend blocks the others pinned to the same child until its deadline, up to 10 seconds. SPEC says "without slowing others". 08's pinning makes this true per child, not per backend; more `sandboxProcesses` reduces it.
- **The render tests** share one helper install in the temp folder and the machine's WebKit cache.
- **The reauth sheet** has no e2e test yet, because the e2e server's clock can't be moved. The API side is tested.
- **A view-only stream outlives lost access by up to 5 minutes.** Events hold no content, so it learns only that something changed.
- **The worker's revocation is blunt:** a 404 on any artifact address, a mistyped one included, clears everything kept offline on that device. It costs a re-download, nothing else. Guests' `/api/me` answer clears it too, so guests get almost no offline copies.
- **Offline has only been tested in Chromium,** not WebKit or Safari: Needs you 15.
- **A device offline when its access ends keeps its copies** until it next reaches the server. A cached render opens without asking the server.
- **The digest is one count, with no time zone:** it goes out when the daily job runs.
- **Service-worker revocation and the sign-out push path** have no e2e test: the first needs losing access mid-session, the second a real push subscription.
