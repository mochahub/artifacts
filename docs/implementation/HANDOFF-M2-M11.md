# Handoff prompt: build M2–M11 autonomously

The prompt below is for the next building agent's first message. It replaces the "stop at each milestone" rule in [HANDOFF.md](HANDOFF.md) for this run. Copy the whole block.

````text
You're taking over **Artifacts**, an open-source, self-hosted system for publishing and reviewing what coding agents make: plans, reports, design mocks and small micro apps. Work from this repository's root. M0 (spikes) and M1 (foundations) are finished.

**Your job is to build every remaining milestone, M2 through M11, autonomously and in order.** I'm not available to check in between milestones. Don't stop at milestone boundaries and don't wait for a go-ahead. Keep going until everything is done or a stop condition below is met.

## Read first, in this order

1. `docs/implementation/HANDOFF.md`: decisions, design rules and constraints. All of it applies, except "stop at each milestone boundary" and "never commit or push", which this prompt replaces.
2. `docs/implementation/spikes.md`: what M0 found. Its "original runbook" section is history and still mentions the runner; trust the sections above it and the contract documents.
3. `docs/SPEC.md`, then `docs/implementation/README.md` (the map, and what to do when documents disagree).
4. `docs/implementation/11-milestones.md`, then each contract document as a milestone needs it.
5. The mocks in `docs/mocks/boards/`, before any viewer work. They're the visual source of truth.

## First step: the M1 fixes are uncommitted

The working tree on branch `m1-foundations` holds the last M1 fixes: `org_id` on every table (the migration was regenerated), the three audit changes, and this file. Run `bun run lint`, `bun run test` and `bun run e2e`, commit them in plain English, push, and confirm CI is green before starting M2.

## Decisions already made (don't revisit)

Everything in HANDOFF.md, plus:
- **Bucket for Compose, dev and tests:** SeaweedFS, `chrislusf/seaweedfs:4.50`. Always set `-master.volumeSizeLimitMB` and `-volume.max` (09).
- **Backends:** QuickJS compiled to WebAssembly, in child processes of the app. No runner service.
- **`org_id` is on every table** except `org`, and a test enforces it. Every new table needs it, including the Phase 2 tables.
- **`me` data:** that person, plus the publisher and admins through the CLI, with the viewer saying so. Confirmed.
- **Passkeys:** user verification is required.
- **Deleted artifacts:** 410 and `slug_deleted` only for callers who could see the artifact; everyone else gets 404 and plain `conflict` (03, 04).
- **Article HTML route:** `text/plain`, `attachment` and `nosniff` (03). The viewer fetches it as text.
- **Publishing an artifact:** only its publisher, admins, and members added with the `publish` permission.
- **Pinned:** Bun 1.4.2. The S3 client always sets `requestChecksumCalculation` and `responseChecksumValidation` to `"WHEN_REQUIRED"`.
- **The repository** is `mochahub/artifacts` (private). CI runs on Blacksmith (`blacksmith-4vcpu-ubuntu-2404`). The image is `ghcr.io/mochahub/artifacts`.

## Git

- You may commit and push without asking, on your own branches only.
- One branch per milestone, each started from the previous one: `m2-sign-in`, `m3-publishing`, and so on. Small commits, plain English.
- Push when a milestone's checks pass, and confirm CI is green on that branch before moving on. If CI fails, fix it first.
- Don't merge to `main`, don't open pull requests, and don't force-push. I'll review and merge the stack.
- Before every commit, check that nothing secret or generated is staged. `docs/review/comments.json` and `.env` stay out.

## Outward-facing and billable: still off limits without me

You may not do any of these, even if a milestone lists them:
- deploy to Railway, create or change Railway projects or templates, or touch the `artifacts-spike` project
- push images to GHCR, publish to npm, create tags or GitHub Releases, or change anything outside this repository
- spend money, apart from normal CI on your branches

Build and test everything up to that line, then record the rest under "Needs you". For example, in M8: build the images and binaries locally, do a release dry run, and test `install.sh` and `artifacts setup --docker` in a clean container, but don't release. `@artifacts/cli` assumes an npm scope nobody has checked; list that too. The Railway path of `artifacts setup` gets unit tests against a fake `railway` binary, and "not run on Railway" goes under "Needs you".

## How to work

1. **For each milestone:** read its section in 11, plan briefly, build, test, update the docs, and run its agent checks yourself. A check passes only if you ran it and saw it pass.
2. **Tests come with the code.** The permission matrix (04) and API tests (03) aren't optional. Every route gets a test, and the route-list test in 01 must exist from M2.
3. **Keep the docs true.** If code must differ from a contract document, update the document in the same commit.
4. **Fix stale text when you reach it:** SPEC §7.9 and M9 in 11 still mention an advisory-lock fallback that 08 ruled out. Spikes.md still lists the Railway half of S3 as not run, though it passed.
5. **Prefer the boring option.** Few dependencies, and no new services beyond the app, Postgres and the bucket.
6. **Use the viewer's real design.** Before each viewer screen, read its mock and `06-viewer.md`. Compare your screenshots with the mock yourself and fix what differs. The forbidden patterns in HANDOFF.md are absolute. Save the screenshots next to the mock screens for me.
7. **Review your own work.** At the end of each milestone, read the whole diff as a reviewer would, looking for permission gaps, missing `org_id` filters and untested paths. After M6, M8, M10 and M11, get an independent review from a subagent that hasn't seen your reasoning, and fix what it finds.

## When something is unclear

I can't answer, so don't wait for me.
- Follow the order in `docs/implementation/README.md`, "When documents disagree".
- If it's still unclear, pick the option that's simplest, most secure and easiest to change later. Record it in the progress file under "Decisions to review", with what you chose, why, and what to change if I disagree. Then keep going.
- If a design doesn't survive contact with reality, change the design, update the documents, record it, and keep going.

## Not verified yet (test these, and don't claim them until you have)

- **The CSP `sandbox allow-scripts` directive** has never been tested. In M9, rerun `spikes/s8-live-frames.ts` with it in WebKit before relying on it. Check module scripts, fonts, relative `fetch`, preflighted `api/` calls and `frame-ancestors`. Also test media (`audio`, `video`, `track`).
- **The sandbox as designed in 08 hasn't been built.** At the start of M10, test each of these before building on it: `Bun.spawn` with `ipc` and an empty environment; pinning each backend to one child; freeing an instance with `env.DATA` calls in flight; and whether an emscripten `abort()` can be caught and leaves only that instance dead. If one fails, adapt the design and record it.
- **Safari keeping presigned GETs cached:** only I can check this on an iPhone. Add it to "Needs you".
- **S1 templates, S2 on desktop Chrome and the sign-in fallback, Windows, and the cost table in SPEC §7.5:** you can't verify these. Add them to "Needs you". Never describe them as working.

## Progress file

Keep `docs/implementation/progress.md` current and commit it with each milestone. A fresh agent must be able to resume from it alone:
- **Status:** each milestone, its branch, its last commit, and CI state.
- **Verified:** what you ran and what it showed.
- **Decisions to review:** the choices you made without me.
- **Needs you:** every check and action only I can do, as exact steps, gathered from each milestone's "User checks" and from `10-testing-and-acceptance.md`.
- **Known gaps:** anything unfinished, skipped or weak.

If you run low on context, or resume after a break, read this file first.

## When to stop

Stop early only if one of these is true:
- Every remaining milestone depends on something only I can do.
- The same problem has resisted three genuinely different approaches, and you can't work around it to make progress elsewhere. If later work doesn't depend on it, record it under "Known gaps" and carry on.
- Going further would need something off limits above, or would destroy data or work you didn't create.

Never weaken a test, skip a permission check, or mark something done to keep moving.

## When you finish

The job is done when M2–M11 are built, all tests pass, CI is green on the last branch, and every agent-verifiable item in the Phase 1 and Phase 2 acceptance lists in `10-testing-and-acceptance.md` has passed.

Then report once, plainly: what works, what you verified and how, the decisions you made for me, what's unfinished, and the "Needs you" list in the order I should do it. Leave no servers or containers running.
````
