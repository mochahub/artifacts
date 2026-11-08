# Final integration verification, 2026-11-08

The staged merge combines Phase 4 head `3b77448` with main `393d06097ada3b9cf1a26856e3114d41cdf4a3e6` (boards epoch diagnostics). Git merged without conflicts. No merge commit, push, PR, review delegation or deployment was performed. Production remains OFF; no real provider credentials or paid calls were used.

## Corrections in this verification

The content staging regression previously grouped eighteen edit/Delegate storage and fencing scenarios plus continuation acceptance under one thirty-second test deadline. Each staging scenario and continuation acceptance now has its own test and unchanged deadline/assertions. Failure messages identify branch and mode. Production preparation deadlines and behavior are unchanged. The root Librarian README now describes the actual rollback-before-storage preparation algorithm, matching the runner README and contract.

Browser acceptance adds assertions for the run log to proposal review navigation and absence of horizontal overflow. Eight inspected captures cover OFF Settings, accepted queue, sanitized log and untrusted proposal at phone and desktop sizes: `docs/mocks/shots/19-{1-settings-off,2-queue,3-log,4-proposal}-{phone,desktop}.png`. These are deterministic mocked client surfaces; they do not claim deployed extractor acceptance.

## Evidence

- Host full unit/API/CLI run before splitting the long test: **2,153 pass, 3 skip, 1 fail**, 21,148 assertions, 128 files. The failure is the existing fifteen-second content preparation deadline on Docker Desktop host-forwarded database operations. This is a failed full run, not a green acceptance claim.
- Route instrumentation from that complete run: **202/202 registered API routes reached**.
- Corrected private Linux content file: **24 pass, 0 fail**, 288 assertions. This covers unseeded read→replace/delete, direct checkpoint/Delegate replay, storage failure/corruption, stale generation/fence/lease/cancellation, storage outside content locks, retained human changes, canonical continuation and Unicode source pagination.
- Separate-process private fixed-URL mock using the corrected content file: **23 pass, 0 fail**, 271 assertions. Text/file mocks are included in the 24-test content file. A filtered URL attempt was invalid because the fixture depends on the preceding setup test; the complete fixture above supersedes that attempt.
- Linux WebKit Librarian: **14 pass, 0 fail**, phone and desktop, including new log/proposal capture assertions.
- Local extractor qualification: **5 pass, 0 fail**, 120 assertions, three files; actual parser and denied network/root write/resource fixtures. Immutable local image exercised: `sha256:c63a695793927b0af90b0528b74324289019414a79eb04cdf372b490e219157b`.
- Remote executor/client qualification: **4 pass, 0 fail**, 27 assertions, two files.
- Installed SDK denied-network boundary passed in the full unit run: explicit synthetic key, no ambient auth/tracing, exactly one denied count transport, no provider egress.
- Build, repository lint/TypeScript, migration generation and diff whitespace: **pass**. Lint reports 82 warnings and one informational diagnostic; zero errors. Migration generation reports no schema changes and the migration directory is unchanged.
- Gzip budgets: initial reader **60.54/80 KB**, article editor **118.42/120 KB**, board editor **53.11/160 KB**.

The three host unit skips are optional container/parser qualification cases without an injected image; all three are covered by the separate five-test qualification above. Linux platform-specific skips and complete Linux/browser outcomes are recorded below. The earlier ENOSPC run is invalid evidence and is superseded only for checks explicitly reported here.

### Full browser result

**166 pass, 5 fail, 9 skip**, 180 scheduled tests, 14.3 minutes. Required acceptance is **not green**. Failures:

- iPhone and desktop lifecycle version-history/restore: click actionability timeout.
- Desktop lifecycle compare: Swipe actionability timeout.
- Chromium notification navigation.
- Chromium offline reading: first image absent after reload.

The nine skips are intentional project-specific exclusions: the organization-changing brand test runs once, phone-only install/comment/keyboard/reader/touch behavior is omitted on desktop, and keyboard shortcuts are omitted on phone. Core boards and article specs ran. The additional final Librarian file run passed all 14 tests. No browser failures were hidden by filtered reruns.

### Full Linux unit result

The final dedicated Linux stack uses the corrected test file and the existing browser image without a rebuild. Two MCP pack tests fail because the private S3 URL uses a compose service hostname over HTTP, which the CLI correctly rejects outside loopback. The brand guide→sample test hits its unchanged 180-second deadline; three dependent brand tests subsequently fail. No HTTPS guard or timeout was weakened. Final summary: **2,164 pass, 6 skip, 6 fail, 1 unhandled error**, 21,260 assertions, 2,176 tests across 128 files (462.02 seconds). The unhandled error is the timed-out brand command returning exit 143 between tests. **202/202 registered routes reached** again in this final run. All split content cases pass in the full run.

Linux skips: the three image-dependent parser/container tests (covered by dedicated qualification), plus three macOS-keychain-only cases (covered by the host full run). No required SDK, private mock, staging/fence, route, migration or bundle check was skipped. An earlier Linux attempt sharing the temporary browser runner is not passing evidence and is superseded by this dedicated attempt.

## Operational gates

Hosted extractor provisioning, private TLS/routing/firewall and deployed launcher/restart/daemon-outage qualification remain open, as do parser supply-chain review and adversarial corpus/fuzz qualification described in the extractor qualification record. Local Docker fixtures do not satisfy these deployment gates. Paid enablement approval and provider account entitlement are absent. Keep production OFF and do not provision or discover ambient credentials for QA.

## Handoff state

The merge is mechanically ready for the lead: HEAD remains `3b77448`, MERGE_HEAD is `393d06097ada3b9cf1a26856e3114d41cdf4a3e6`, all twenty changed files are staged, no unmerged index entries and no unstaged changes remain. **Final integration verification is blocked by the full-suite failures above.** This is not an assertion that all required tests are green. No second adversarial review was performed. The reviewed implementation remains in scope; verification introduced only test structure/client coverage and documentation changes, plus eight screenshots.

Own private compose stacks and the temporary browser runner image tag were removed after completion. No broad prune, shared reset, Docker restart, paid call, commit or push occurred. Disk availability fell from about 16 GiB to about 8 GiB during the runs and recovered to about 10 GiB after cleanup; no ENOSPC occurred in these runs. Detailed logs and browser traces are retained privately outside the repository.

## Staged files

- `apps/server/src/boards/read.ts`
- `apps/server/src/librarian/README.md`
- `apps/server/test/librarian-content-tools.test.ts`
- `apps/viewer/e2e/librarian.e2e.ts`
- `docs/implementation/14-boards.md`
- `docs/implementation/15-librarian.md`
- `docs/mocks/shots/19-1-settings-off-desktop.png`
- `docs/mocks/shots/19-1-settings-off-phone.png`
- `docs/mocks/shots/19-2-queue-desktop.png`
- `docs/mocks/shots/19-2-queue-phone.png`
- `docs/mocks/shots/19-3-log-desktop.png`
- `docs/mocks/shots/19-3-log-phone.png`
- `docs/mocks/shots/19-4-proposal-desktop.png`
- `docs/mocks/shots/19-4-proposal-phone.png`
- `docs/research/phase4-librarian/final-integration.md`
- `packages/cli/src/commands/board.ts`
- `packages/cli/test/board.e2e.test.ts`
- `packages/cli/test/board.test.ts`
- `packages/schema/src/boards.ts`
- `skill/references/boards.md`
