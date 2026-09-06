# Progress and evidence

## 00 — Baseline and plan

- Working branch: `fork/selective-provider-refresh-20260907`.
- Fork baseline: `673cfee8dde264f9e8b79c7f23fb3ecf63d0f992`; upstream comparison remains `06ec553630fa2ee51a96b5cbf694089021249194`.
- `bun install --frozen-lockfile`: passed using the existing lockfile; no dependency/version changes. Bundled executable reports Bun 1.4.0 (the host-level executable is 1.3.14).
- `./node_modules/.bin/bun run typecheck`: passed, exit 0.
- `./node_modules/.bin/bun run test`: baseline completed before production edits, exit 1: **7,161 pass / 11 skip / 4 fail**, 7,176 tests across 496 files (320.34 s).
- Baseline failures: `Cursor desktop executor hooks > record-screen bad output maps to failure without throwing`; `shutdown-launcher.test.ts` SIGINT/SIGTERM/SIGHUP startup readiness (all 20 s). These are not introduced by this work. Reproduce separately and diagnose rather than weakening assertions/timeouts.
- No real provider calls or service operations were requested. Test runner uses disposable homes.

## Stage ledger

| Stage | Status | Notes |
| --- | --- | --- |
| 01 Persistence | Complete | Small snapshot-policy leaf; verified identical-write suppression, adaptive debounce and one-attempt background passes. |
| 02 Astra | Complete | Exact final pin, native projection/limits, routed-field isolation, API metadata and scoped API-reference pricing. |
| 03 OpenCode Muse | Pending | Core registry/transport changes already exist; inspect remaining guards and regression coverage. |
| 04 Kiro compatibility | Pending | Text-control and parallel-hint rejection still use the older contract. |
| 05 Kiro lifecycle | Pending | Per-account quota exists in the fork; compare lifecycle changes rather than replacing the quota subsystem. |
| 06 Kiro calibration | Pending | Not present on baseline. |
| 07 Grok Responses | Pending | Grok 4.6 metadata already exists; inspect final defaults, schemas, search and retry compatibility. |
| 08 Extra optimizations | Pending | GUI coalescing/visibility polling already exists; admit only demonstrable remaining work. |
| 09 Integration | Pending | Full verification, documentation, diff review and non-force branch push. |

## 01 — Response-state persistence

- References: upstream `02c302a54` and `34c9e9802`; narrow manual port on the current fork, not a state-store replacement.
- Extracted `ResponseSnapshotWriter` into `src/responses/snapshot-policy.ts`. Keeps scalar metrics, a digest and target only; actual disk bytes are validated before skipping. Home changes, deletion, same-size external edits, symlink targets and protection repair cannot produce false unchanged hits.
- Small snapshots keep 2 s debounce; scaling is based on UTF-8 bytes, capped at 30 s. Background passes attempt once; explicit flush retains the bounded four-plus-four stabilization contract and deferred spill cleanup.
- RED evidence: changing the existing background-churn assertion to one attempt failed on baseline (received 4). GREEN after the implementation.
- Deterministic operation-count evidence: four identical persist calls -> one atomic write and three validated skips. This is a write-count result, not a measured RSS or end-to-end latency claim.
- Focused gate: `./node_modules/.bin/bun run test tests/responses-state.test.ts tests/responses-state-write-amplification.test.ts tests/active-turn-lifecycle.test.ts` -> **101 pass / 0 fail**.
- Root typecheck and privacy scan passed. Documentation frozen install/build passed (**211 pages**); existing chunk-size and 404-entry build warnings are non-fatal.
- Preserved fork UTF-8 accounting, snapshot format v2, replay prefix/image behavior and spill ownership.

## 02 — Astra

- Imported only the pure Astra data-row addition from `d617a042b`, then applied the final Fast-description correction. A read-only deep comparison confirmed that the resulting Astra row equals the row at pinned `upstream-live/main` exactly.
- Manually carried the relevant behavior of `c5671b670`, `c2870fb55` and `980a9fbed`: explicit Astra pin admission, derived base instructions, native low default/full ladder, native-only field stripping for routed clones, and per-request/config-aware Astra context resolution. The GPT-5.6 window policy, Daybreak alias and configured subagent roster remain unchanged.
- Public API Astra registration is distinct from Codex-login metadata. Added exact OpenAI overlays and Astra-only long-input/Fast composition; native dollars are marked API-reference derived estimates, not subscription-credit billing.
- API pricing/effort facts rechecked at `https://developers.openai.com/api/docs/models/gpt-6-astra` on 2026-09-07. The current upstream head's API-reference display semantics were used, not an intermediate commit's credit multiplier.
- Eight new contract tests failed on the pre-implementation code, then passed. Existing exact membership assertions were updated to include the one new API row and two price overlays, without relaxing the expected sets.
- Focused gate across Astra/catalog/sync/visibility/identity/price/API/registry: **256 pass / 0 fail**. Follow-up Astra/price tests after source cleanup: **48 pass / 0 fail**. Root typecheck and privacy scan passed.
- Docs frozen install/build passed: **216 pages**. Added the Astra guide and updated catalog SOT.
- Replaced an inherited literal NUL in the cost memo key with the equivalent TypeScript `\\u0000` escape so future source diffs stay readable; runtime key bytes are unchanged.
