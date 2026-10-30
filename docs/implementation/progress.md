# Progress: building M2–M11

A fresh agent can resume from this file alone. Read [HANDOFF-M2-M11.md](HANDOFF-M2-M11.md) for the brief, then this.

## Status

| Milestone | Branch | Last commit | CI |
|---|---|---|---|
| M0 Spikes | `main` history | `fafc2f6` | n/a |
| M1 Foundations | `m1-foundations` | `9de1ffc` | green (run 41045711327) |
| M2 Sign-in and CLI skeleton | `m2-sign-in` | `e6b5af8` | green (run 41048009618) |
| M3 Publishing | `m3-publishing` | `ae1a852` | green (run 41050356260) |
| M4 Viewer | `m4-viewer` | in progress | |
| M5–M11 | not started | | |

## Verified

- **M1 fixes (2026-10-30):** `bun run lint` clean, `bun run test` 79 pass, `bun run e2e` 6 pass locally. CI green on `9de1ffc`.

- **M2 (2026-10-30):** 220 tests including the full permission matrix; every API route reached by a test (`scripts/route-coverage.ts`); 12 Playwright WebKit tests at iPhone and desktop size. `artifacts setup --docker` ran for real from a locally built image in a sandboxed home: compose up, claim, `whoami`, `doctor`, all passed, then torn down.
- **M3 (2026-10-30):** real WebKit: the CameraBuddy fixture (26 frames, 8 articles, 9 pages) publishes; republishing uploads 0 files and reports no changes; a shared-CSS edit reports only the frame whose pixels changed; a Markdown edit reports only that block. Lint catches seeded overlap, clipping, nondeterminism, home indicator, offscreen, contrast (warning), missing, absolute and outside references, bad ids and a bad manifest. Mermaid and chart SVG pass the article allowlist with no `<style>` or `foreignObject`.

- **M4 (2026-10-30):** Playwright WebKit at iPhone size and desktop against the real fixture: lists, search, filters, artifact page, page switcher, version history, 26 frames drawn with one changed, frames list, deep links, pinned versions, synthesized touch pan and pinch, double-tap, keyboard, article blocks, embeds, tables without page overflow, settings surviving a reload. Screenshots: `docs/mocks/shots/`. Compared by eye with boards 01–03; found and fixed the overview layout and cover crop.

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

## Needs you

Gathered as each milestone is reached. So far, from the brief:
1. **Safari and presigned GETs:** on an iPhone, open an artifact, reload, and check in Web Inspector that images come from cache on the same day.
2. **S1 templates:** `railway templates create` and `railway deploy --template` (spikes.md).
3. **S2:** desktop Chrome, and the "Sign in on the home domain" fallback.
4. **Windows:** the CLI, including credentials, is untested.
5. **SPEC §7.5 cost table:** measure on the first real deploy.

## Known gaps

- **`frames/renamed`, `data/*` and `backend/*` lint rules** aren't built yet: M5 and M9–M10.
- **The render tests** share one helper install in the temp folder and the machine's WebKit cache.
- **Reauth with a passkey** arrives in M6; until then `POST /api/auth/reauth` takes a password.
- **The reauth sheet** has no e2e test yet, because the e2e server's clock can't be moved. The API side is tested.
