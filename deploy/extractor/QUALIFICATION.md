# Private qualification record (2026-11-07)

Environment: Docker Desktop 4.40.0, Linux engine 28.0.4, arm64; Bun 1.4.2. No application/provider credentials, provider requests or hosted enablement. Docker build used public package/image repositories; transport qualification used only private TLS fixtures. Production remains OFF.

Image exercised by `qualify.sh`: `sha256:4c952d51b147ee33b1c5c54958c8135318dba247448f3a5ae1f0c25b2ea3fdc7` (local manifest-list ID). This records the tested build, not an assertion of a reproducible apt snapshot or a completed vulnerability scan. Qualification removes its private image tags.

Successful: actual UTF-8 text, Markdown, inert HTML and Poppler PDF extraction; a generated valid 100-page text-bearing PDF; real TLS body streaming with the source hostname verified and public address pin observed by the controlled test dialer.

Denied: absent adapter/image, mutable image reference, unsupported MIME, output above 1 MiB; malformed/empty text PDF, 101-page PDF, escaped active name, encryption/attachment names and trailing non-whitespace PDF payload. These are synthetic refusal fixtures; encryption/attachment-name checks do not substitute for a broad corpus of genuinely encrypted/attached PDFs.

Identical-launcher probe: outbound TCP connection fails; read-only root write fails; host path is absent; UID 65534, CPU rlimit 10 and descriptor limit 64 observed. 400 MiB allocation, busy CPU loop, 60-second sleep and oversized stdout are rejected; no probe containers remain after the cases. This exercises resource failures; it does not prove kernel/runtime exploit resistance.

HTTPS: redirects, compressed response, unsupported MIME, body above 5 MiB, truncated stream, ten-second deadline, TLS hostname mismatch before HTTP delivery, changed private DNS answer and mismatched resolver family are denied. Existing security tests additionally cover mixed public/private answers, IPv4/IPv6 reserved ranges and URL authority tricks. The test dialer intentionally maps a synthetic validated public pin to loopback and trusts an ephemeral fixture certificate; production uses the OS resolver, public pin and default CA trust without this mapping.

Defects corrected: pinned transport now specifies the validated address family (preventing automatic dual-stack array lookup mismatch); resolver family must match the parsed address; PDF active-name checks decode hex escapes and reject additional form/attachment features; Poppler diagnostic warnings fail closed; container adapter validates source before launch and bounds its first forced-removal subprocess.

The dedicated qualification command, focused security tests, server TypeScript check, touched-file Biome check and diff whitespace check are the verification commands. See README for the explicit hosted deployment ceiling and remaining operational/adversarial qualification gates. No shared compose stack or reset test script was used.

## Remote boundary private qualification (2026-11-07)

Implemented under `executor/` and opt-in `remote-extractor.ts`; runtime/env/job integration belongs to the root runtime owner and is not enabled here. Parser image built locally: `sha256:a32073a0055233adac69214ecdd4b1117e444fcbde2d1f50a8164eae35d8a3da`. Bun 1.4.2, local Docker Desktop Linux engine. Synthetic repeated-byte test keys only, no real credentials/provider call/external deployment/hosted configuration change.

Real private loopback HTTP client → signed executor → restricted Docker sandbox → authenticated text/Markdown/HTML/PDF results passed. Tests also deny wrong key, expired signature, body hash mismatch, nonce replay (including authenticated error verification), wrong startup epoch, >10 MiB input, >1 MiB extracted output, forged result and unsafe endpoint/key configuration. Two sleeping sandbox jobs fill admission; a third is refused. Signed cancellation and disconnected caller terminate/reap jobs. A separate actual executor child process is SIGKILLed while its sandbox is running; startup reconciliation removes the surviving container, verified by an empty exact private label query. Derived fixture images and random namespace containers are removed; caller's qualification image tag removed separately. Earlier failed fixture runs were corrected and their owned resources removed.

This run tests HTTP only via explicit loopback-only test construction. Production HTTPS/CA verification uses the standard fetch TLS implementation but private deployed TLS/ingress/firewall routing was NOT exercised. Actual process crash plus reconciliation is demonstrated; systemd restart/reboot and Docker daemon outage acceptance remain open. The teardown failure latch is implemented, but daemon-outage injection was not performed here. Existing local parser security qualification remains applicable to launcher flags; this is not a new kernel escape or parser security proof. Full integrated security review is still required.

Final focused run: 4 tests passed, 27 assertions, no skips (approximately four seconds). Production entry point also reconciles late orphan creates every five seconds while preserving registered live launcher names; its timer/daemon-outage behavior still requires deployed-host acceptance.

Verification: focused remote/client qualification tests, server TypeScript build, standalone strict executor TypeScript check, touched TypeScript Biome check and whitespace check. No shared reset/test-stack command, commit, push or PR.
