# Librarian (Phase 4)

Contract, 2026-11-07, based on main `8dddd60`. Slice 1 foundation is partially implemented behind a disabled flag; the full feature remains gated. Read with 12 (wiki audience), 13 (editing policy) and 14 (boards). Those contracts continue to own their operations. The approved company-brain plan and its two open status comments were read in full; the newer authorization to continue supersedes the old scheduled pause. No review thread was resolved.

## Outcome and release gate

An optional server job processes an inbox of sources and gardens admin-selected wikis using a bounded Claude Messages API client-tool loop. Ship OFF. Configuration, saving a key and enqueuing a source never enable it. Hosted enablement requires explicit owner approval and a separately supplied secret through the approved secret mechanism. Private QA uses an injected mock provider, no real key and no paid call. No model runs locally and no browser runs on the server.

Existing SPEC/ARCHITECTURE statements that the server never calls a model must gain this explicit optional exception when implementation lands. SECURITY must describe encrypted recoverable provider credentials, egress and the new threat surface. This proposal does not silently rewrite those existing contracts.

## Identity, scope and policy

Use a dedicated existing `orgToken` identity named Librarian, with scopes `read`, `comment`, `edit`, `publish`, an explicit non-null `projectIds` allowlist, and no bearer credential exposed to the model. `publish` is needed only by the trusted source/page creation adapter; the model has no general publish tool. Keep its token id for run ownership and attribution. Do not impersonate its admin creator or add a new privileged caller kind.

Every adapter checks both current selected-wiki membership and `can()` before accessing data, including snippets, rules, links, counts, citations, comments and tool error messages. The explicit allowlist is an additional ceiling: existing org-token access to projects it created must never widen this ceiling. No ordinary projects, cross-wiki reads, cross-wiki citations or cross-wiki writes within a run. A run binds one wiki. Permission/selection changes increment a configuration generation; each provider dispatch and tool mutation rechecks it. Deleted/revoked identity stops work. Missing/hidden resources have indistinguishable not-found responses.

Reuse `agentPolicy()` inside the content lock for every operation and existing Delegate start/finish, checkpoint, suggestion and stale-base services. Write refuses; Pair suggests; held blocks/objects follow 13/14. The org token has no only-reader owner, so even an only-me wiki uses suggestions unless a page is agent-maintained. Never infer direct edits from the admin's personal ownership. Agent-maintained direct edits still obey Write/Pair. Never accept/reject suggestions, resolve, approve, change access, promote, maintain, delete, restore, run artifact backends or execute source code. Questions become one deduplicated page-level comment. No question to a human should leave a worker waiting with a reservation.

New synthesized pages are proposals first: store a bounded proposed article in the inbox result; an authorized person creates it through the existing page-create service after review. Do not bypass company suggestion policy by publishing a new page directly. Read-only sources may be created by the trusted ingestion adapter. Phase 4 first release edits existing articles and reads board checkpoint outlines; board mutations remain outside the tool allowlist. Future board mutation must reuse 14 unchanged.

## Inbox and ingestion boundary

Inputs are a discriminated union `SourceInput`:

- `{ kind: "text", text, title }`, UTF-8, at most 1 MiB.
- `{ kind: "url", url, title? }`, public HTTPS on port 443 only, at most 2048 characters.
- `{ kind: "file", uploadId, title? }`, an owned, completed, wiki-bound quarantine upload of at most 10 MiB. No server filesystem paths or model-selected blob hashes.

All inputs require an idempotency key UUID, `wiki`, and optional plain-text note of at most 2000 characters. A mobile PWA share target opens a signed-in confirmation screen with explicit target wiki; receiving a share never submits automatically. Pasted text and uploads are also untrusted data. Sources keep original provenance, hash, submitter, receive time, extraction version and `untrusted: true`; synthesizing claims does not remove taint. Link source slugs only in their own wiki and only when visible to the reader. Reuse immutable wiki source artifacts, existing Markdown sanitization and checkpoint-derived indexing. Inbox access uses the submitter's current rights, never the librarian's broader rights.

Fetch in a dedicated constrained ingestion adapter, outside a DB transaction. Reject credentials, fragments containing credentials, IP literal URLs, non-HTTPS schemes, alternate ports and redirects (including HTTPS redirects). Resolve all A/AAAA records; reject any non-public, loopback, link-local, RFC1918, mapped private IPv6, reserved or metadata destination. Pin a validated address for the connection with TLS hostname verification; recheck on every retry. Apply network egress deny rules too. No DNS-check-then-generic-fetch gap. No cookies, Authorization, ambient proxy credentials or forwarded caller headers. No subresources, JS, CSS imports, browser, login or crawler. GET only, 10-second total timeout, 5 MiB streamed/decompressed ceiling, bounded compression ratio 20:1, HTML/text content types only. Redact URL query values in logs. Return a safe failure rather than following a sign-in page.

Allow UTF-8 text, Markdown and HTML (sanitize/extract inert text), and text-bearing PDF through a sandboxed extractor with no network, 256 MiB memory, 10 seconds CPU, 100 pages, 1 MiB extracted text. Reject archives, executables, macros, encrypted PDFs, symlinks, path traversal names, malformed/polyglot files and unsupported MIME/signature mismatches. No OCR or paid document extraction in v1. Store quarantine under `librarian/<orgId>/<inboxId>/`; it is never content-host served or downloadable through a raw hash. Authorized source downloads use existing blob membership guards after promotion to a source artifact. Quarantine expires after 7 days, including rejected entries; clean up on deletion and account purge. Completed immutable sources follow normal artifact retention.

## Model and client-tool API

Default intended model `claude-sonnet-5-5`, configurable by an admin to a verified model and approved rate card. Official model overview and pricing checked 2026-11-07 list that exact API id at $2 input / $10 output per million tokens. No discrepancy found in public documentation; account entitlement is unverified because no authenticated provider call was made. No silent fallback on 404 or deprecation. Unknown/unpriced models block dispatch until an admin supplies a reviewed rate card.

Use official `@anthropic-ai/sdk` in the implementation, isolated behind `LibrarianProvider`. The official SDK is pinned to 1.6.0; no provider request is made by this implementation work. Use `client.messages.stream(...).finalMessage()` with explicit injected API key, fixed Anthropic endpoint, SDK retries disabled, adaptive thinking, bounded output (4096 tokens per call), automatic tool choice and sequential tool handling. No remote MCP, web-search, web-fetch, computer, code-execution, bash, server tools, Files API or Managed Agents. The host controls ingestion and client tools. SDK default credential discovery is forbidden in production and QA.

`LibrarianProvider.respond({ model, messages, tools, maxOutputTokens, signal })` returns a complete typed provider message, stop reason, usage and request id. Keep opaque thinking blocks unchanged when appending the assistant message. Append a user message containing a result for each tool-use id, with `is_error` on validation/authorization failures. Validate every complete input through strict shared schemas with unknown properties rejected; JSON-schema validity alone is not authorization. Never execute partial streamed arguments. On `max_tokens`, refusal or malformed output execute no tools from that response. `end_turn` finishes; `tool_use` executes validated allowlisted calls; unexpected/server pause states fail safely. Maximum 12 provider turns, 32 tools, 10 minutes per run, 64 KiB per read, 256 KiB total tool-result text. Never log chain-of-thought or retain raw provider transcripts.

The tool allowlist is `wiki_rules`, `wiki_search`, `page_read`, `source_read`, `page_edit`, `page_delegate_start`, `page_delegate_finish`, `question`, `propose_page`. All resource references resolve server-side within the bound wiki. Reuse existing PageRead/EditRequest/StartRun shapes internally; do not duplicate their operation schemas. `question` only opens a page-level thread with an existing visible checkpoint; it cannot reply fixed without a corresponding published change. Rules are loaded before editing, but rules, source text, tool output and comments are untrusted content with no authority to widen tools, scope, budget or configuration. Delimit and label them separately from the fixed host instructions. A source instruction to send secrets, fetch another URL or change access has no capable tool. Injection tests must prove server-side refusal even when the mock explicitly calls the forbidden action.

## Scheduler, lifecycle and concurrency

Integrate a named `librarian` job with the jobs runner and `/internal/jobs/librarian` OPS guard. That endpoint still obeys OFF, limits and the kill switch; OPS is not enablement. A short transaction under a dedicated per-org librarian advisory lock claims one eligible inbox item (or one daily garden run) and reserves budget. Reuse jobs clock/lifecycle; do not hold the daily jobs lock, a connection or any DB transaction across external I/O. A dedicated one-minute tick may dispatch due work, after claim commit. OFF performs no provider or ingestion egress. Daily gardening is due at 00:00 UTC, at most one wiki/day, keyed by wiki and UTC date.

Run states: `queued`, `running`, `waiting_human`, `succeeded`, `failed`, `cancelled`, `budget_exhausted`, `interrupted`. `waiting_human` is terminal for the execution, with comment/proposal ids; a person's response can enqueue a new linked run. Runs link to zero or more existing per-page `edit_runs`; they are not replacements for those runs. Direct finishes checkpoint; suggestion finishes leave changes for a person. Partial direct work is retained and identified if cancelled, just as 13 specifies. No rollback that overwrites concurrent human work.

Use a durable lease with owner UUID, monotonically increasing fencing generation, 30-second heartbeat and 90-second expiry. Only one active librarian run per org and one existing Delegate run per page. Mutation entry points check the current run fence, enabled/config generation and kill switch inside the same short transaction as the content lock and idempotency receipt; cancellation cannot race a later write. Expired leases become interrupted; never automatically replay a provider call with uncertain billing. Resume as a new run only after accounting reconciliation. Scheduler advisory lock prevents simultaneous claims; durable leases prevent duplicate work after the claim transaction releases it.

## Money, retries and idempotency

All money uses nonnegative integer USD microdollars and UTC calendar months, never floating point. Defaults: monthly budget 0, per-run cap 0, enabled false. Admin must choose positive caps explicitly. Reserve the full per-run cap atomically before claiming work: `spent + reserved + requested <= monthlyLimit`. Lock the month ledger row and run row consistently; concurrency cannot oversubscribe. Snapshot immutable model/rate card and month at claim. Charge all attempts to that reserved month even if midnight passes; new month's jobs have a distinct ledger. Reducing a budget below committed usage blocks new reservations and cancels active work at its next fence.

Before each attempt reserve a worst-case call ceiling inside the run cap using token-count API on the exact bounded prompt/tools plus maximum output, and the pinned rate card, rounded upward. Counting is provider egress and obeys OFF/key/kill guards. No cache, batch, fast mode or paid server tools in v1. Include tool-schema overhead and adaptive thinking in the output allowance. Unknown usage categories or usage exceeding reservation stop the run and alert an admin. Per-run limits cannot guarantee a provider invoice in the face of provider billing changes; show conservative estimates until reconciliation.

Reconcile each response's usage exactly once by local attempt UUID and provider request id. Release only proven unspent reservation. Network timeout, lost stream or process crash may still be billed: retain that attempt's full ceiling as uncertain spend; never refund automatically. Ledger keeps settled, uncertain and reserved amounts separately. Before another attempt, budget must fit worst case including uncertain spend. Finalize ledger, terminal status and activity atomically. No real API request is made to reconcile during mock QA.

Retry known 429/overload/5xx at most twice with bounded exponential jitter and Retry-After, only within deadline and newly reserved attempt budget. Network ambiguity is terminal interrupted in v1. 400/401/403/404 are terminal configuration errors; 401 disables dispatch pending admin repair. Do not let SDK hidden retries defeat accounting. Tool mutations carry a deterministic UUID derived from run/turn/tool-use id plus canonical input hash, persisted in the mutation transaction; same key/different payload is conflict, replay returns its original result. Source inbox uniqueness is `(org_id, submitted_by, idempotency_key)`; retry returns the original item and source identity. Content-hash deduplication stays within the same wiki and never reveals another wiki's content. Stale edit bases require a fresh read, never force; permission/Write refusal defers without an infinite retry loop.

## Settings, keys and operational recovery

Admin Settings is session-only behind `can(librarian.manage)`, recent authentication (10 minutes), CSRF and no-store responses. No CLI/OAuth/org token can configure, supply, reveal or enable a provider key. Settings returns only `keyConfigured`, key generation and timestamps, never a suffix or masked secret. A write-only key input is cleared after submission and never placed in DOM attributes, analytics, browser storage, logs or error bodies. Decrypt only in the trusted provider adapter; never pass keys to prompt context, jobs results, artifact backend env, micro apps or content host.

Use AES-256-GCM envelope encryption with random per-write nonce and data key, AAD containing org id/purpose/key generation. Wrap the data key with a deployment-managed KEK held outside DB/backups. Persist ciphertext, nonce, authentication tag, wrapped data key and KEK id; never plaintext. No KEK fallback to SESSION_SECRET. Missing KEK or authentication failure blocks dispatch. Deployment must supply a versioned keyring through its secret manager, with separate access control and audit. No key value is specified or read by this work.

Rotation: cancel/fence active runs, replace the provider key, increment generation, then revoke old key in Anthropic Console. KEK rotation rewraps data keys transactionally and verifies decrypt before retiring the old KEK; retain old KEKs through the backup recovery window. Disaster recovery restores DB and matching keyring to an OFF deployment; test decryption with synthetic fixtures, then require explicit re-enable. Suspected leak: kill, revoke provider credential, rotate KEK if exposed, audit access, reconcile uncertain spend. Removing a key disables first and deletes encrypted material; old backups still require retention controls. Key change does not itself enable anything.

Kill switch is persistent `enabled=false` plus generation increment, cancels queued/running jobs and aborts in-flight requests through signals on every replica. Previously dispatched requests may still be billed. Check generation before dispatch and again before applying every returned tool. A global deployment flag `LIBRARIAN_ALLOWED=false` is a second ceiling. Mock injection exists only in test/private harness construction, never as a request-selectable provider.

## Proposed shared schemas and additive storage

These names are frozen for implementation. The ten foundation tables now ship after synthetic security/accounting primitives were proven on a private stack; service integration remains gated. Never handwrite SQL migrations. Generate the next migration from Drizzle with `bun run db:generate`; use the next free sequence after rebasing, not a guessed number. Keep existing tables/enums compatible and preserve current data.

`LibrarianConfig`: `{ enabled: boolean, generation: integer, wikiIds: UUID[0..100], model: string[1..128], monthlyLimitMicrousd: integer, runLimitMicrousd: integer, keyConfigured: boolean, keyGeneration: integer, updatedAt: ISODate }`. Reject empty enabled allowlist, zero caps, missing key, unpriced model and per-run cap above monthly cap. All integer money must be safe integers at the JSON boundary; use bigint DB arithmetic and checked conversion.

`LibrarianInbox`: `{ id, wikiId, kind, title, status: queued|extracting|ready|running|waiting_human|done|failed|cancelled, submittedAt, sourceArtifactId?, runId?, errorCode? }`. Raw input is available only to authorized submitter/admin through a guarded detail, never general list/activity. `LibrarianRun`: `{ id, wikiId, inboxId?, state, model, configGeneration, startedAt?, finishedAt?, usage: { settledMicrousd, uncertainMicrousd, reservedMicrousd }, result: { editRunIds, proposalIds, questionIds }, errorCode? }`; result ids individually filtered by caller permissions. `LibrarianProposal`: `{ id, runId, wikiId, title, summary, markdown, sources, untrusted: true, status: open|created|rejected, createdArtifactId? }`.

Add tables (all org-bound, UUID PK/FK, timestamptz and checked nonnegative money):

| Table | Columns and constraints |
|---|---|
| `librarian_config` | org_id unique; enabled default false; generation; model; caps; token_id; updated_by/at; no key text |
| `librarian_wikis` | PK org_id/project_id; FK project; selected_by/at; empty means no access |
| `librarian_keys` | org_id unique; encrypted envelope fields above; generation; updated_by/at |
| `librarian_inbox` | wiki/project id; submitter; kind; input/quarantine reference; source hash/id; extraction version; status; idempotency key + payload hash; timestamps; due/status index |
| `librarian_runs` | wiki/inbox; state; config/model/rate snapshot; lease owner/fence/expiry; deadline; cap/month; terminal result; partial unique active org index |
| `librarian_months` | PK org_id/month; settled/uncertain/reserved; row-locked ledger |
| `librarian_attempts` | run/attempt UUID unique; request id; token usage; ceiling; settled/uncertain state; per-run turn/attempt unique |
| `librarian_receipts` | run/tool key unique; input hash; bounded result; created_at; written with mutation |
| `librarian_proposals` | run/wiki; proposed fields; status; reviewed_by/at; created_artifact_id; unique run/proposal key |

Retain sanitized run/attempt/receipt logs 90 days after terminal state; retain aggregate monthly totals 13 months. Receipts outlive any executable run. Purge sensitive inbox raw content/quarantine after source creation or 7 days. Run logs store event codes, safe resource ids, timings, token counts and cost only; no prompts, extracted text, URLs with queries, headers, provider error bodies or thinking. Activity uses Librarian agent attribution, existing per-page run_started/run_finished and checkpoint/suggestion events; new queue/budget/admin details stay admin-only. Existing Phase 2 editor-only draft activity rules apply. Source submission itself reveals nothing to broader readers.

## HTTP, CLI and MCP contract

Every route uses the standard API guards/version/CSRF chain and `can()` before data access. Proposed actions `librarian.manage` and `librarian.logs` are recent-auth admin sessions only; `librarian.submit` accepts person/cliToken/orgToken only when the caller can `project.publish` in the target selected wiki (publish scope for tokens), and rejects guests/content callers. Inbox reads require current submission authority plus submitter ownership, or admin session. Proposed `librarian.review` is session-only with target `project.publish`; proposal creation additionally checks existing page-create authorization. No org token can accept a proposal. No admin credential is ever reused for tools.

| Route | Shape and behavior |
|---|---|
| GET `/api/librarian/config` | manage; safe LibrarianConfig, 200 |
| PUT `/api/librarian/config` | manage; full editable fields + expectedGeneration, 200; stale 409; validation 400; enabling requires global ceiling and prerequisites |
| PUT `/api/librarian/key` | manage; `{ key, expectedGeneration }`, bounded write-only; 204; key never echoed |
| DELETE `/api/librarian/key` | manage; expectedGeneration; disables/fences; 204 |
| POST `/api/wikis/:slug/inbox/uploads` | submit; `{ name, size, contentType, sha256 }`; owned short-lived quarantine upload ticket; 201 |
| POST `/api/wikis/:slug/inbox` | submit; `{ idempotencyKey, source: SourceInput, note? }`; 202 new, 200 exact replay; 409 payload conflict; never enables or spends |
| GET `/api/wikis/:slug/inbox` | current submit authority; own items only, admins all; bounded cursor 50; no global hidden counts |
| GET `/api/wikis/:slug/inbox/:id` | same visibility; safe item and authorized proposal/source links |
| POST `/api/wikis/:slug/inbox/:id/cancel` | submitter with current submit right or admin; fences run; 200 idempotent |
| GET `/api/librarian/runs` and `/:id` | logs; cursor 50; sanitized run metadata only |
| GET `/api/librarian/runs/:id/events` | logs; bounded cursor 100; sanitized events |
| POST `/api/librarian/runs/:id/cancel` | manage; 200 idempotent; no rollback of committed edits |
| POST `/api/wikis/:slug/proposals/:id/create` | review; `{ requestId, expectedStatus: "open" }`; 201/200 replay through page-create, unique receipt; status race 409 |
| POST `/api/wikis/:slug/proposals/:id/reject` | review; expectedStatus; 200; status race 409 |

No dedicated enable or run-now tool exposed to agents. Feature-disabled submit may queue for later only after clear user copy: “Saved to inbox. Librarian is off.” `artifacts wiki add <wiki> (--file <path> | --text-file <path> | --url <https-url>) [--title <text>] [--note <text>] [--request-id <uuid>] [--json]` uploads local bytes via quarantine, not a server path. It returns accepted item id/status with exit 0, permission/validation error exit 1; acceptance is not completed ingestion. `artifacts_source_add` hosted MCP takes `wiki, source, idempotencyKey, note?`; file input uses a previously owned upload ticket, never a remote local path. Local MCP wraps CLI ingestion with the same schemas; normal wiki/page tools remain unchanged. Unknown tools never reach a generic service dispatcher.

## Five disjoint implementation slices

1. **Contract/storage/security owner:** shared `packages/schema/src/librarian.ts`, exports, Drizzle schema and generated migration; can() actions/matrix, encryption/key store, config/key/admin run routes, budget ledger/lease/fence primitives. Own integration edits to db/locks, schema exports and API registration. Fold contracts 02/03/04/09, SECURITY and ARCHITECTURE after implementation agrees. Deliver `claimRun`, `reserveAttempt`, `settleAttempt`, `withRunFence`, `loadSafeConfig`, `withProviderKey`; concurrency/crash/encryption tests block paid adapter integration.
2. **Ingestion owner:** new `apps/server/src/librarian/ingestion/` and inbox/upload routes only; quarantine/SSRF/extractor/immutable-source promotion, source deduplication, cleanup and tests. Consume slice 1 schemas and fence primitives. Deliver `enqueueSource`, `extractSource`, `promoteSource`; no scheduler/provider/settings edits.
3. **Runner/provider owner:** new `apps/server/src/librarian/runner/`, provider adapter, bounded tool registry, execution state machine, retry/accounting integration and mock fixtures. Supply a registration function for slice 1 to wire jobs; do not independently edit jobs/index. Reuse existing editing/wiki/review services, no changes to editor algorithms. Prove lost-response and kill races before integration.
4. **Viewer owner:** new lazy Settings librarian panel, inbox/share-target/proposal/run-log views; existing Settings route and PWA registration owned here. Write-only key UX, explicit enable, costs, pause and mobile confirmation. No backend/schema/CLI edits; prove current JS read budget, accessibility and WebKit private-stack flows.
5. **CLI/MCP/docs owner:** wiki add, local+hosted source_add registration, skill references and docs 07/12/SPEC/README; client-only validation and private mock end-to-end acceptance. No shared schema/server runner/viewer edits. Route/API registration changes go through slice 1.

Order: freeze schemas/interfaces → slice 1 primitives → ingestion and mock runner → client surfaces → one private integration pass. No parallel worker/delegation was started by this preparation. Owners should use these slices when separately authorized to implement.

## Acceptance and implementer brief

Implement this contract with injected clock/provider; keep OFF in migrations, runtime defaults and deployment. Prove denied wiki reads leave no snippets/counts, org-token only-me suggestions, Write/Pair/maintained transitions, stale bases, board read-only tools, injection-driven denied calls, source taint/citation filtering, DNS rebinding/redirect/decompression/extractor escape rejection, CSRF/recent-auth/key non-disclosure, synthetic AEAD rotation/restore and missing-key failure. With two replicas race claims, budget changes, cancellation, lease expiry and tool retries; assert at most one mutation and no refunds on uncertain calls. Exercise truncation/refusal/tool validation, 401/404 stop, 429 accounting, month rollover, proposal creation races and retention.

Private QA must cover text/file/URL/mobile, CLI and both MCP paths against a deterministic mock with no environment credential lookup and outbound provider networking denied. Then run required lint, migration drift, whole route coverage, permission matrix, server tests, Linux WebKit and viewer size checks. This document does not claim those implementation tests passed. No paid smoke test or hosted enablement until separate approval and secure credential provision. The outstanding engineering gates are pinned-address HTTPS transport, sandboxed PDF extraction, transactional fence integration and uncertain-cost accounting; no unknown API model blocks the plan.

## Slice 1 implementation status

Implemented: shared config/source/run validation; ten additive foundation tables (config, selected wikis, keys, months, runs, attempts, inbox, receipts, proposals, events); generated migration 0021; recent-auth admin config/key/latest-run routes; synthetic envelope rotation; serialized claim/attempt accounting, heartbeat/fence/cancel/crash recovery. No provider/ingestion calls or paid credentials are wired. Recent-auth provisioning can now create a credentialless identity and approve an explicit model/rate pair while staying OFF; production provider scheduling remains unwired.

Remaining production gates: concrete transactional existing-page tools and page-create/review HTTP adapters, page activity/edit/question result linkage, isolated extractor and immutable-source creator, visibility-aware ingestion deduplication, automatic extraction orchestration, full mock end-to-end acceptance. Inbox-linked claims, daily deduplication, identity/rate provisioning, receipt/proposal transaction services, terminal admin events, pagination, raw/log retention, bulk KEK rotation and cross-replica advisory cancellation are now implemented. Do not integrate a paid adapter until those dispatch/accounting gates and mock races are complete. See 02/03/04/09 for the implemented subset rather than assuming all proposed routes/tables above exist.

### Frozen worker interfaces

Import from `apps/server/src/librarian/index.ts`. `Deps` supplies the DB, injectable clock and deployment environment. Money arguments below are bigint USD microdollars; JSON settings remain checked safe integers.

```ts
type RunFence = {
  orgId: string; runId: string; owner: string;
  fence: number; configGeneration: number;
};
claimRun(deps: Deps, input: {
  orgId: string; wikiId: string; owner: string;
}): Promise<RunFence | null>;
reserveAttempt(deps: Deps, fence: RunFence, input: {
  attemptId: string; ceilingMicrousd: bigint;
}): Promise<void>;
settleAttempt(deps: Deps, input: {
  orgId: string; runId: string; attemptId: string;
  outcome: "settled" | "uncertain";
  actualMicrousd?: bigint; requestId?: string;
}): Promise<void>;
withRunFence<T>(deps: Deps, fence: RunFence,
  use: (tx: Tx) => Promise<T>): Promise<T>;
loadSafeConfig(deps: Deps, orgId: string): Promise<LibrarianConfig>;
withProviderKey<T>(deps: Deps, fence: RunFence,
  use: (key: Buffer) => Promise<T>): Promise<T>;
heartbeatRun(deps: Deps, fence: RunFence): Promise<void>;
finishRun(deps: Deps, fence: RunFence,
  state: "waiting_human" | "succeeded" | "failed" |
    "budget_exhausted" | "interrupted"): Promise<void>;
cancelRun(deps: Deps, orgId: string, runId: string): Promise<void>;
```

`withRunFence` callbacks are DB-only: acquire content locks and check current can()/agentPolicy() there; do not perform egress. `withProviderKey` checks the fence in a short transaction, decrypts outside it, then clears its temporary buffer after the trusted callback; use subscribeRunCancellation or withRunSignal to install the separate durable-fence polling signal. Never treat a successful prior key load as authorization for later tool mutations. `claimRun` reserves the full cap and snapshots month/model/rates, and accepts additive inboxId/daily options for atomic inbox binding and wiki/UTC-date deduplication. A reused reserved attempt id is idempotent accounting, not permission to redispatch a call. On any ambiguous dispatch stop and settle uncertain; never replay after crash. Settled responses require a unique provider request id and cannot exceed the reserved ceiling; terminal recovery never refunds uncertain amounts. Call finishRun for known terminal executions; it moves outstanding ceilings to uncertain and releases only remaining capacity. No provider I/O or automatic retries exist in these primitives.

Private verification: full server suite passed 1,475 tests across 51 files and all 192 registered API routes were reached. After adding the final inbox/receipt/proposal tables, the focused data-model, migration, foundation and admin-route suite passed 23 tests (172 assertions). Migration generation reports no drift; lint/TypeScript and diff whitespace checks pass (lint reports warnings). The foundation tests additionally cover synthetic AEAD recovery/tampering/rotation, concurrent claims/attempts, settlement replay, mutation/cancel ordering, lease crash recovery, month pinning, global OFF, CSRF/recent auth and key non-disclosure. No real credential, outbound provider request or hosted enablement was used. Linux WebKit/client acceptance and full Phase 4 mock integration remain release gates for later slices.

### Additive root interfaces and integration gates

Existing frozen exports remain compatible. `claimRun` additionally accepts `inboxId?: string` (queued or ready, matching org/wiki, never already bound) and `daily?: boolean` (one wiki/UTC date, including terminal runs). The caller chooses the work source; no external I/O happens in claim. Finished inbox runs map to done/waiting_human/cancelled/failed in the ledger transaction.

```ts
withToolReceipt<T>(deps: Deps, fence: RunFence,
  input: {toolKey: string; inputHash: string},
  mutate: (tx: Tx) => Promise<T>,
  authorize: (tx: Tx) => Promise<void>): Promise<T>;
subscribeRunCancellation(deps: Deps, fence: RunFence, intervalMs?: number):
  Promise<{signal: AbortSignal; close(): Promise<void>}>;
withRunSignal<T>(deps: Deps, fence: RunFence,
  use: (signal: AbortSignal) => Promise<T>, intervalMs?: number): Promise<T>;
rotateAllProviderEnvelopes(deps: Deps): Promise<number>;
createLibrarianJob(deps: Deps,
  adapters: Pick<RunnerIntegration, "provider" | "authorizeTool" | "tool">,
  owner?: string): {librarian(): Promise<unknown>};
finalizeExecution(deps: Deps, fence: RunFence,
  state: "waiting_human" | "succeeded" | "failed" | "budget_exhausted" | "interrupted"): Promise<void>;
```

`withToolReceipt` authorizes before any replay, compares a 64-hex input hash, bounds JSON to 60,000 bytes, and writes mutation plus receipt atomically. DB errors/oversized results roll back both. All locks, can()/agentPolicy(), edits and page activity must use the supplied transaction. Opening an independent transaction is forbidden; no provider or bucket I/O inside this callback. This service does not retrofit existing editing services automatically. The runner has its own equivalent receipt helper and invokes its required authorizeTool hook before replay. Neither helper is an authorization substitute.

`storeProposal(deps, fence, {proposalKey,inputHash,title,summary,markdown,sources}, authorizeSources)` checks the shared proposal schema and uses a receipt; `authorizeSources(tx,wikiId,sources)` runs even on replay. `reviewProposal(deps,{orgId,wikiId,proposalId,personId,reject?},authorize,create)` locks the proposal row, rechecks session/page-create/citation policy through the required adapter, and atomically creates or rejects. `create(tx,proposal)` must return `{artifactId,result}` from the same transaction. A created proposal returns its original artifact id on replay. HTTP review and real page-create adapters are not implemented by this seam.

The job factory supplies ready-inbox/daily claims, durable cancellation, persistent disable after 401 and terminal accounting after expiry. It requires real authorized tool adapters and an explicitly injected provider; production jobs do not call this factory. It does not orchestrate queued-source extraction. `guardedAnthropicProvider` remains available from runner/provider and obtains a fresh key for each operation. SDK 1.6.0 is installed and its structural boundary typechecks; no provider request was made. Ingestion routes exist and are registered, and retention calls cleanupQuarantine; extraction and promotion still require the concrete isolated extractor/immutable-source creator described in ingestion/README.md. Do not claim text/file/URL end-to-end completion.

Migrations 0022–0025 add run inbox/daily keys, sanitized admin events, a generated UUID default for receipts consumed by the runner, and the cyclic run/inbox FK. No existing migration was edited. Terminal event/inbox state is atomic with accounting; per-page activity and edit/question result IDs remain future adapter work. Detailed attempts/receipts/events expire after 90 days; terminal run tombstones remain for references/dedup. Monthly totals retain thirteen UTC months. Artifact purge clears librarian source/created-artifact references before deletion. Account removal invokes purgeSubmittedSources after revocation; failed bucket deletion leaves raw expiry due for daily retry.

Current root verification: private uniquely named force-recreated compose stack, 1,513 server tests across 54 files passed; all 199 registered API routes reached. After the final inbox FK, focused data-model/foundation checks passed 25 tests. TypeScript passes; generated schema reports no drift; owned-file Biome errors and diff whitespace checks pass. Repository-wide lint was blocked by concurrently edited viewer files (left to that owner). These checks do not prove production mutation adapters, sandbox escape isolation, paid provider behavior, Linux WebKit acceptance or full Phase 4 completion. No real credentials, paid requests, deployment enablement, commits or pushes were performed.

### Backend integration follow-up (partial)

Ingestion authorization is the existing `project.publish` action plus selected wiki/current submitter checks. There is no implemented `librarian.submit` action. Proposal GET/reject/create routes are registered on the standard API/CSRF chain. GET and reject require person sessions, publishing rights and visibility of all same-wiki citations. Concurrent reject retries serialize and return replay. Create validates the viewer request but fails closed with 409 while the transaction-aware article creator is unavailable. No page can commit outside review. Inbox detail includes only authorized proposal ids. Runner receipt identity now excludes payload hash, so reusing a tool id with changed input conflicts rather than executing twice. SDK token counts are validated as nonnegative safe integers at its boundary.

A concrete Docker extractor adapter and dedicated Python/Poppler image have been added. Construction requires an immutable locally present image id. Launch applies network=none, read-only root, unprivileged uid, no host mounts, dropped capabilities/no-new-privileges, 256 MiB hard memory/swap ceiling, one CPU, ten-second per-process CPU limit, fifteen-second wall deadline, process/file/tmpfs/output limits. No fallback or automatic image pull occurs. Private image tests prove text/HTML extraction and malformed PDF/oversized output refusal. Production job construction does not yet supply this adapter. Comprehensive PDF/polyglot, filesystem/network escape, CPU/memory exhaustion and transport acceptance are still gates; do not claim production qualification from these checks.

Remaining: transactional existing content tools/agentPolicy/content-lock integration; concrete human article creation; immutable source creation and promotion tests; queued extraction scheduling; per-page activity and result linkage; full text/file/URL-to-edit/proposal deterministic mock integration and production job wiring. Current production librarian job remains recovery-only and OFF performs no provider dispatch. No provider credential/network call, enablement, commit or push occurred.

Follow-up verification used a private force-recreated Postgres/S3 stack: 1,517 tests passed and one stale hosted-MCP tool-count assertion failed (28 expected vs 29 including artifacts_source_add), across 56 files; every one of 202 API routes was reached. The assertion was updated to check count plus the registered source tool explicitly, then the affected OAuth suite was rerun. Backend Biome error checks, TypeScript, diff whitespace and migration no-drift checks pass. Repository lint remains blocked by viewer manifest formatting (left unchanged under viewer ownership). These results are not full Phase 4 acceptance. No production extraction/edit/proposal-creation end-to-end path has been proven.

### Transactional creation follow-up

`createArtifactLocked(tx,input,by)` in the existing publisher is a DB-only new-artifact primitive using the content lock and existing commitVersion pipeline, including version content and published activity. It verifies staged blob rows in the transaction. `createReviewedProposal(deps,{orgId,wikiId,proposalId,caller,requestId})` stages escaped, sanitized article content outside review and rechecks person publishing and every same-wiki citation under the proposal lock. The actual create HTTP route returns 201, or 200 on replay. Proposal status, article/version/activity and the run-scoped UUID request receipt commit together. Request collisions serialize and changed review identity conflicts. Reject behavior remains compatible.

`createImmutableSource(deps,submission,extracted,inboxId)` stages original bytes, inert extracted HTML and provenance JSON, then returns the DB-only trusted creator. Promotion defaults to this adapter, preserving provenance validation, fenced authorization and visibility-aware same-wiki deduplication. Org tokens require an explicit bound wiki ceiling. Original bytes plus hash, submitter, received time, input provenance, extraction version and untrusted=true remain in version files. Imported sources are archived and identified by the server provenance filename `__librarian_source.json`; unarchive and republish refuse with read_only. Unreferenced staged blobs are cleaned by existing grace-period blob GC, avoiding unsafe deletion of shared hashes. No provider, job scheduling or hosted enablement is added.

Private creation acceptance: force-recreated isolated Postgres/S3 stack, 33 tests/198 assertions across librarian creation/routes/foundation, ingestion services and existing publishing passed. Concrete tests cover full source and reviewed article creation, concurrent promotion/review, original/provenance retention, permanent archive, storage failure, post-insert transaction rollback, request receipts, cross-wiki review denial, hidden citation replay denial, hidden hash dedup isolation and explicit org-token wiki ceilings. Server TypeScript, touched-file Biome error checks and diff whitespace checks pass. Source extraction here is an injected deterministic fixture, not extractor deployment qualification. Existing runtime/content adapters and full application/transport/extractor acceptance remain outside this narrow creation check. No credentials/provider requests or production enablement were used.

Runtime implementation follow-up: bound-wiki transaction adapters now cover rules/title search, checkpoint text/source-role reads, seeded article reads and existing applyOps, suggestion delegate start/finish, deduplicated page-level questions and proposal storage. All tool authorization and mutations run in the receipt's fence transaction, with content locks and current explicit org-token project ceiling. Current wiki publish permission accepts an explicitly scoped org token with publish; commenting requires comment and an explicit project entry and does not grant data.write. Tool reads filter citations; activity links Librarian run and suggestion IDs, and run details filter delegate/question IDs by current page visibility/edit rights.

The registered job composes guarded SDK defaults without enabling them. Queued extraction consumes the concrete immutable creator, persists extracted source text in checkpoint block rows and uses a valid bounded source slug inside the same promotion transaction; blobs stage beforehand. Optional remote executor configuration is construction-only and fails closed when missing. Private text/file and separate-process fixed-URL mock acceptance cover source promotion, existing article suggestion and proposal creation with no SDK/provider dispatch. Actual network/extractor qualification is separately documented under deploy/extractor/QUALIFICATION.md.

Runtime completion follow-up: unseeded article reads use canonical PageRead Markdown, deterministic legacy block IDs, 12-character edit bases and source order; the first draft seed uses the same IDs. Article continuation is a version:seq:offset cursor and refuses changed version/sequence. Unseeded article edits seed through the supplied document lock. Edit-request checkpoints and direct Delegate finish reuse checkpointLocked.

The runner's prepareAndPersist performs bounded preparation passes. A missing immutable blob or deferred checkpoint computation unwinds and rolls back the current DB transaction before storage or rendering begins. Draft validation, Markdown generation, article rendering/sanitization and staged byte/hash verification run outside that transaction; storage waits observe durable cancellation and a 15-second preparation deadline. The final DB-only pass reacquires content/document locks, compares the originally captured artifact and draft (including version, epoch, sequence, bases and metadata), and rechecks the current run/config/lease, can() and agentPolicy before committing content, activity and receipt together. Any changed snapshot refuses rather than overwriting human work. Operation block IDs and the preparation timestamp remain stable across provisional passes. Unreferenced content-addressed stages use normal grace-period GC; shared hashes are never eagerly removed.

Outer transaction owners registerAfterCommit(tx, queue), drop the queue on rollback and flush it only after a successful commit. docLockIn.after and scoped document/event notifications use that queue, preserving editor/replica update, suggestion, checkpoint and run notices without exposing rolled-back state. Question retries with fresh tool IDs reuse the durable run/page/exact-question-text thread after current authorization; receipt identity remains independently checked.

Source and proposal creators own 40-character-safe UUID-based slugs (source- plus 32 hex, prop- plus 32 hex), preserving collision refusal without overwriting existing content. Every entrypoint writes complete Unicode-safe text chunks with hashes of the stored text. Text and inert sanitized HTML share HTML newline normalization; original source bytes remain unchanged. source_read accepts cursor and optional pinned version, returns bounded blocks with part offsets/full block hashes and nextCursor (null only at completion), and refuses changed versions/invalid cursors. The model tool description requires continuation until complete; the existing run-wide byte/deadline/budget limits still fail explicitly rather than silently truncating a source.

Remaining operational gate: hosted executor TLS/firewall/host deployment and operational qualification. Production stays OFF. Full final acceptance must be rerun after the Docker storage failure described below.

Final runtime verification: isolated force-recreated Postgres/S3 server suite completed with 1,524 pass, 3 skip, zero failures and 16,168 assertions (61 files). Final focused runtime/foundation/runner/remote-client checks: 40 pass, zero failures, 151 assertions. Separate-process fixed-URL runtime fixture: 3 pass, zero failures, 25 assertions. Root lint (60 existing warnings), TypeScript and diff whitespace pass. Root viewer manifest and completed executor README received formatting-only fixes. The private compose resources were removed. Route coverage was not measured by this invocation, and skipped parser/container qualification is represented by the separate extractor worker report, not counted as this runtime acceptance. No shared reset scripts or paid provider were run.

Verification for this follow-up: private project phase4-final-20261107 was force-recreated on ports 58432/20333; no shared reset scripts were invoked. Before Docker failed, the focused creation/content suite passed 7 tests / 170 assertions, including unseeded edit/checkpoint success and replay, direct Delegate completion and replay, storage failure/corruption, generation change and kill during staging for both edit and finish, and large Unicode source continuation. Final provider-free runner mocks passed 21 tests / 41 assertions. Final TypeScript, repository lint (65 warnings, one informational diagnostic), and diff whitespace checks pass. New explicit fence/lease-expiry and slug-collision assertions plus the final shared proposal text-block refactor are statically checked but could not be rerun against storage.

The broader apps/server + packages invocation ended at 1,723 pass, 3 skip, 58 fail / 19,178 assertions across 106 files; it is not a passing acceptance run. Docker subsequently refused even CREATE EXTENSION citext with Input/output error. Private Linux WebKit librarian acceptance failed during claim fixture setup (1 pass, 1 fail, remainder did not run), with ENOSPC followed by Docker read-only filesystem/containerd metadata I/O errors. Route coverage was not evaluated after that unsuccessful suite. Both own compose projects were stopped; removal retries for phase4-final-20261107 and artifacts-e2e-7b5f8279 failed with the same Docker metadata I/O error, leaving stopped resources for cleanup after host repair. No shared daemon restart/prune/reset was attempted. Final full database, URL-mock and browser acceptance remain verification gates after Docker recovery. No provider network/key, hosted enablement/deployment, commit, push, PR or delegation occurred.


### Accepted creation/ingestion review corrections

Inbox cancellation acquires the same organization transaction lock as claims, reloads ownership and the current run binding there, and finishes that run plus cancels the inbox atomically. The run guard must reject cancelled inboxes and mismatched inbox/run/wiki bindings; claim must establish its inbox binding before that guard is evaluated.

A submission grants the configured Librarian service read-only access to its promoted immutable source without changing its human audience. `canReadPromotedSource` requires the current live organization token, explicit wiki allowlist, selected wiki, linked inbox, and current source version with trusted original/provenance records and untrusted source role. Only content-tool read/citation authorization consumes this grant; edit authorization and human `can()` remain unchanged. Promotion verifies the grant in its final transaction before commit. Hidden unrelated artifacts acquire no service grant.

The originating CLI token id is retained as server-authored `submittedTokenId` in the quarantined inbox input. Final promotion reloads that credential, its current scopes/expiry/revocation and its actual person, including removal and current role, inside the fence transaction. Person submissions reload their actual person too. Source deduplication searches matching hashes independently of inbox lifecycle status, scoped to the same wiki and current submitter visibility.

Reviewed proposals use `buildArticle` plus the normal sanitizer, generated article HTML, Markdown source, manifest source mapping, and matching block/outline records. Staging remains outside review; article/version/activity and proposal receipt/status commit together under review's lock. This makes created articles seedable by the existing editor.


Accepted content-tool review follow-up verification: private force-recreated project `phase4-content-qa-20261108` on ports 59492/21393; final content suite 6 pass / 288 assertions, content plus existing operations 31 pass / 436 assertions, and checkpoint API plus replica suite 27 pass / 91 assertions. After adding explicit base-version/page/atom snapshot comparison, the staging/canonical-read regression passed again (1 pass / 160 assertions). Coverage includes concurrent semantic question retries with fresh tool IDs, canonical unseeded read→replace/delete, article continuation and stale version/sequence refusal, committed suggestion/checkpoint/run notices with rollback silence, storage failure/corruption, generation/fence/lease/cancellation refusal, stalled storage releasing content locks, and preservation of human title/draft epoch/metadata plus canonical checkpoint text. Server TypeScript, owned-file Biome error checks and diff whitespace checks pass. This is focused acceptance, not a full server/browser/provider/hosted deployment acceptance claim. No paid provider, real credential, hosted enablement, commit, push, PR, delegation or shared-stack reset was used.
