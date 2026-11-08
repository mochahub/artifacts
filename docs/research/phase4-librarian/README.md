# Phase 4 librarian API spike

Recommend a bounded client-tool Messages API loop behind an OFF deployment ceiling, using the existing org-token, wiki, editing and jobs abstractions. The contract is ready to implement privately. No feature source, dependency, database migration, real credential, paid provider request or hosted enablement was added.

## What was verified

Prepared against main `8dddd60`, after fetching and merging origin/main. Read CONTRIBUTING, SPEC, ARCHITECTURE, SECURITY, implementation 12–14, the Phase 3/4 handoff, the full approved company-brain plan (including its continuation chunk) and both open comments. No AGENTS.md was found in this checkout or the checked parent locations. The older pause/status comments are history; current authorization permits preparation. No comments were changed or resolved.

No local claude-api skill was found in the searched skill/plugin locations. Read the [official upstream skill](https://github.com/anthropics/skills/blob/main/skills/claude-api/SKILL.md) and its [TypeScript API reference](https://github.com/anthropics/skills/blob/main/skills/claude-api/typescript/claude-api/README.md). The user's Sonnet choice overrides its default Opus recommendation. Use the official SDK during implementation, explicit key injection, bounded streaming and a manual loop for transactional policy/accounting hooks.

## Current provider evidence

Checked public official documentation on 2026-11-07. Public API availability is documented; account entitlement, actual latency, billing and response compatibility were not tested. No authenticated Models or Messages call was made.

- The [official model overview](https://platform.claude.com/docs/en/models/overview) lists `claude-sonnet-5-5`. The intended default exists in current public API documentation; no discrepancy was found and no fallback was invented.
- The [official pricing page](https://platform.claude.com/docs/en/about-claude/pricing) lists Sonnet 5.5 at $2 input and $10 output per million tokens. Cache prices are $2.50 for five-minute writes, $4 for one-hour writes and $0.10 for reads. The first release disables caching, paid server tools and batch/fast modes to simplify conservative accounting. Rate cards must be reviewed again before enabling.
- The [Sonnet 5.5 announcement](https://www.anthropic.com/claude-sonnet-5-5), dated September 28, 2026, independently confirms the release and base prices.
- The [Messages reference](https://platform.claude.com/docs/en/api/messages) documents POST `/v1/messages`; current reference UI shows API version 2026-10-21. Let the pinned SDK own version headers and test compatibility; do not copy a historical raw-HTTP example blindly.
- The [client-tool handling guide](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) describes returning tool results against tool-use ids. Preserve the full assistant block sequence, including opaque thinking blocks. Complete and validate streamed inputs before executing anything.

The verified standard rate is 2 microdollars per input token and 10 per output token. A mock response with 100 input and 20 output tokens costs 400 microdollars ($0.0004); two such turns cost 800. This is arithmetic over fixtures, not a provider invoice or measured production workload estimate.

## Executable experiment

Run `node docs/research/phase4-librarian/mock-spike.mjs`. The script imports only Node assertions. It performs no environment lookup, file read, network call or SDK initialization. Saved output is `mock-results.json` beside the script.

Nine checks pass: OFF dispatch prevention; org-token only-me/Pair/Write behavior; host denial of a hidden wiki and injected resolve tool; idempotent replay/conflicting payload; cancellation before tool application while charging completed usage; retained uncertain cost; assistant-block and tool-id round trip; no execution on truncation; and competing claims against a shared reservation counter.

These checks validate the proposed behavior in a small in-memory fixture. They do not exercise can(), Zod validation, Drizzle transactions, advisory locks, two actual replicas, provider streaming, encryption, DNS pinning, PDF extraction, mobile UI or route integration. The fixture's sequential shared counter is not evidence that database concurrency is correct. Implementation must prove those separately.

## Decisions and remaining gates

Reuse existing policy and per-page Delegate runs; add a separate execution/accounting lifecycle. Treat the allowlist as a ceiling beyond normal org-token reach. Reserve full per-run caps under a short claim lock, keep provider I/O outside transactions, fence each mutation, and conservatively retain uncertain charges. Ship OFF with zero default budgets. Preserve source taint. New synthesized pages wait as proposals for people, preventing new-page publishing from bypassing audience suggestions. Board checkpoint outlines are readable; board mutation tools are deferred.

Encrypted org keys remain exclusively in the trusted provider adapter. Admin Settings is recent-auth session-only and write-only for keys. Public source fetching uses pinned public HTTPS with no redirects; files use a networkless bounded extractor and quarantine. No source or model output can alter tools, credentials, scope or budget.

No database scaffold was generated: persistence should follow private proofs of fencing, ledger reconciliation, encrypted key recovery and ingestion boundaries. Those are engineering gates, not reasons to invent model availability or enable paid QA. The contract names schemas, routes, additive tables, retention, limits, failure states, five disjoint slices and acceptance tests.

## Implementer handoff

Use `docs/implementation/15-librarian.md` as the proposed names/shapes contract. Begin with shared schemas, permission matrix, ledger/lease/fence and synthetic encryption fixtures. Then implement ingestion and the injected mock runner, followed by client surfaces. Keep feature registration under one integration owner and follow the five file ownership slices in the contract. Fold the resulting names into existing contracts and update SPEC/ARCHITECTURE/SECURITY in the implementation change. Generate migrations from Drizzle only after rebase. Run private route/permission/concurrency/security tests, Linux WebKit and bundle size checks. Hosted enablement and any paid smoke test require separate explicit approval and secure credential provision.
