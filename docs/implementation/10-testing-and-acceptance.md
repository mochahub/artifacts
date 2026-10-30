# 10 · Testing and acceptance

## Test layers

| Layer | Tool | Where | What |
|---|---|---|---|
| Unit | `bun test` | next to the code (`*.test.ts`) | Schema validation, re-anchoring, quote matching, status derivation, token formats, limits, lint rules |
| Permissions | `bun test` | `apps/server/test/permissions.test.ts` | The full matrix in [04](04-auth-and-permissions.md#test-matrix) |
| API | `bun test` against a real server | `apps/server/test/api/` | Every route in [03](03-api.md): happy path, auth failures, read-only archived, deleted, limits. Uses Postgres and SeaweedFS from `deploy/compose/docker-compose.test.yml`. |
| CLI end to end | `bun test` | `packages/cli/test/e2e/` | Against a local server: `setup --docker`-like claim, `init`, `lint`, `render`, `publish`, `comments`, `reply --fixed`, `status`, `archive`, `delete`, `undelete`, `data`. Uses a fixture artifact (below). |
| Viewer end to end | Playwright **WebKit**, iPhone 15 viewport (393×852, DPR 3), and desktop 1440×900 | `apps/viewer/e2e/` | Sign-in (password; passkeys with a virtual authenticator where Playwright supports it in WebKit, otherwise Chromium for that test), home, project, artifact, canvas pan/zoom/pin, comment sheet over the on-screen keyboard (simulated with `visualViewport`), thread, resolve, decide, article quote comment, share link guest, archive/delete/restore |
| Visual | Playwright screenshots | `apps/viewer/e2e/visual/` | Each viewer screen at iPhone size, compared with the matching mock board screen **by a person**, not pixel-diffed (the mocks are drawings) |
| Sandbox | `bun test` | `apps/server/test/sandbox/` | Load by hash, isolation between two artifacts, no network or globals, `env.DATA` only and scoped by the app, read-only for viewers and archived artifacts, timeout (busy loop), memory (typed-array, string and heap floods, deep recursion), eviction of grown instances, teardown with `env.DATA` calls in flight, a crashed child restarting, log and size caps, the child's empty environment |
| Load (manual) | `oha` or k6 | `docs/implementation/` notes | 50 concurrent viewers polling, 20 publishes, 100 backend requests/s in the sandbox; record RAM and CPU to update SPEC §7.5 |

## Fixtures

- `fixtures/camerabuddy-roadmap/`: a copy of the CameraBuddy roadmap shape: a plan (article), 7 short research articles, 4 canvas boards with 26 frames using the captured screens in `docs/mocks/img/cb/`. Use it for e2e and the Phase 1 acceptance.
- `fixtures/micro-app-poll/`: a frontend-only poll (shared and me data) and a backend version (votes with caller identity). Use it for Phase 2.

## Acceptance

Each milestone in [11-milestones.md](11-milestones.md) lists its checks in two groups. The building agent runs and reports the first group. The second is for the user, so the agent prepares it and asks.

**The agent can verify:**
- all test layers above pass in CI
- the e2e flows at iPhone size in WebKit
- the permission matrix
- `artifacts setup --docker` from a clean machine image
- the size budget
- the measured local timings

**Only the user can verify:**
- the viewer on a real iPhone in Safari over cellular (5G), including the comment sheet over the real keyboard and Safari's bottom bar
- passkeys on a real device, across two domains (Related Origin Requests)
- `artifacts setup` against their real Railway account (it creates billable resources, so ask first), and the real monthly bill
- where Share sits in iOS Safari's ⋯ menu (board 05, screen 6 text)
- that the look matches the mocks and avoids the forbidden patterns ([06](06-viewer.md#design-rules-keep-the-look-avoid-generic-patterns))

### Phase 1 acceptance

From SPEC §12:

1. The CameraBuddy roadmap fixture is published, reviewed on the user's iPhone over 5G, and an agent completes a full comment → fix → republish → reply round trip from a fresh session using only the skill.
2. On a machine with only the CLI installed, `artifacts setup` deploys to Railway, claims the server and installs the skill in under 10 minutes.
3. A teammate joins through an invite and sees organization artifacts but not the user's private ones.
4. Someone outside comments through a share link.
5. Archive, delete, restore and purge work as SPEC §5.5 says, including links stopping and the slug rule.

### Phase 2 acceptance

1. Comments show up live on a second device; a push notification arrives when the agent replies (installed PWA on iPhone).
2. The poll fixture works frontend-only and with a backend; two people's `me` data stay separate; the agent reads results with `artifacts data export`.
3. A backend can't reach the network, other artifacts' data, or anything but `env.DATA` (sandbox tests).
4. Outside teams deploy the template and publish within 15 minutes.
