# Response snapshot duplication and upstream stream disconnects

- Date/timezone: 2026-09-13, Asia/Seoul (UTC+09:00).
- Status: remediation released and VM restarted; original long-session symptom recovery still requires observation.

## Deployment update (19:11 KST)

- Release `2.8.0-cs.25`, commit `6b59e71718b461c484556936c5f0080d48c20752`, passed local tests, Cross-platform CI and Service lifecycle. Release run `34749063664` completed successfully and the npm version was independently queried.
- GitHub dispatch initially returned HTTP 500; no run had been created, and one retry succeeded. The first deployment script invocation failed on Windows CRLF before service mutation; sending UTF-8 bytes with LF corrected the transport.
- Previous VM package retained at `/home/ubuntu/.local/lib/node_modules/@coseung2/opencodex-pre-cs25-1789294241`. Exact npm version installed; user service restarted at 19:10:51 KST with PID 3931734.
- Both VM-local and Tailscale health probes returned `status: ok`, version `2.8.0-cs.25`. Startup briefly reset the first health probe before the next succeeded. Core changed file hashes were checked against source.
- Release adds same-account SSE retry only before any Responses event, bounded close diagnostics, full-history Kiro image retirement, and shared image storage with admission limits. Health/version checks do not establish that every original model repetition or connection failure is eliminated.
- Impact: excessive continuation snapshot storage; reported repeated commentary and interrupted Responses streams.

## Evidence and timeline

- Around 16:53–16:59, the reported application session emitted repeated image-location acknowledgements without intervening user instructions. The earlier diagnosis mistakenly attributed another project's session and an outdated VM runtime; both claims were withdrawn.
- At 17:08–17:10, the active VM reported version `2.8.0-cs.24`. A read-only snapshot audit counted 118 spill files totaling 1,518,450,452 bytes, largest 16,591,579 bytes. Files were all referenced by the durable snapshot; none exceeded the one-hour TTL. Oldest creation age was 29.4 minutes.
- Image data URLs occurred 3,701 times across those files, representing 78 unique strings. Total image-string bytes were 1,328,227,478 versus 37,384,212 unique bytes; one image occurred 92 times. This is an aggregate across VM sessions, not an application-only measurement.
- Disk had approximately 23 GB available; proxy RSS was approximately 861 MiB. Neither disk exhaustion nor an OOM event was established.
- During the reported Aseprite failure interval, native OpenAI routes recorded repeated 502 responses taking approximately 2–5 seconds across multiple pool entries, interleaved with successful requests. Some aborted requests recorded 499. This does not establish quota exhaustion.

## Confirmed mechanisms and limits

- `rememberResponseState` stores complete input plus output for each response. RAM demotion writes that whole payload to an individual spill file. Historical image bytes are consequently duplicated between snapshots.
- Retention has a one-hour TTL, a 1,000-response count cap and a 256 MiB individual spill cap. The 64 MiB store budget governs resident data, not aggregate spill bytes. No aggregate disk-byte cap was found in these paths.
- TTL sweep behavior passed local focused tests. The live sample had no expired or unreferenced files, so it cannot prove a live expiration/deletion cycle; it also provides no evidence of failed cleanup.
- A synthetic parser-to-Kiro-payload check preserved an old image when a full-history request lacked replay-prefix provenance, and excluded it with the prefix set. Existing image tests cover the marked-prefix case. Whether the reported application request used the unmarked path remains unverified; no outgoing private request payload was captured.
- The exact reported WebSocket error originates in `ws-upstream.ts` when an opened upstream connection closes before a Responses terminal event. The close handler discards the close code/reason, limiting retrospective diagnosis. The downstream relay produces the failed terminal event. Provider-side rejection, network closure, and request-specific failure remain unresolved alternatives.
- Neither automatic-continuation termination as the repetition root cause nor spill duplication as the disconnect cause has been established.

## Validation and follow-up

- 32 tests passed across `kiro-images.test.ts` and `state-store-sweeper.test.ts`; synthetic image-provenance comparison reproduced the conditional behavior without provider calls.
- Runtime data and active sessions were preserved. No pool settings, credentials, models, or runtime files changed.
- Follow up with bounded, privacy-preserving upstream close diagnostics and per-request correlation; verify actual replay provenance, a live TTL deletion cycle, and a disk-budget/content-dedup design that preserves continuation references.
