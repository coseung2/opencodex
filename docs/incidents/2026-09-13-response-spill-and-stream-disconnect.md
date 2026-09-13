# Response snapshot duplication and upstream stream disconnects

- Date/timezone: 2026-09-13, Asia/Seoul (UTC+09:00).
- Status: investigated; no runtime remediation or restart performed.
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
