# Selective provider refresh on the existing fork

## Scope and immutable comparison points

- User request (2026-09-07, Asia/Seoul): implement a concrete, staged refactoring and optimization plan; commit each stage; push only after all implementation and verification stages finish.
- Initial local checkout: `acf5ffe40645d59a129587a35a2c26716f8ee6c6` (`2.8.0-cs.4`).
- Refreshed **fork** baseline: `673cfee8dde264f9e8b79c7f23fb3ecf63d0f992` (`2.8.0-cs.15`). Fetch revealed 70 existing fork commits. They were fast-forwarded into the work branch, not reimplemented or discarded.
- Read-only upstream comparison: `06ec553630fa2ee51a96b5cbf694089021249194` (`upstream-live/main`). This is a reference, not a merge target.
- Work branch: `fork/selective-provider-refresh-20260907`, based on the fork baseline. The existing local `main` and release version are not advanced by this work.

Only Astra, OpenCode Go/Zen Muse Spark compatibility, Kiro, xAI/Grok, and directly applicable performance work are in scope. No wholesale upstream merge, remote hub, Meta direct/OAuth provider, unrelated model-family refresh, Notch rewrite, toolchain upgrade, or repository-wide file-layout conversion.

## Findings which change the earlier proposal

The fork baseline already includes Bun 1.4.0, bounded Windows test batches, GUI timer/resource coalescing, visibility-aware polling, OpenCode Go session affinity, Muse 1.2/1.3 routing and input metadata, a preliminary Astra registration, quota-window and Notch improvements, and bounded SSE framing. Preserve them and test the remaining deltas. In particular, do not remove Windows batching merely because Bun is now 1.4.0.

## Staged implementation and acceptance

Each numbered implementation stage gets its own commit and focused tests. Update `010_progress.md` with the actual diff, source commits, commands, results, and any evidence-based scope decisions. Tests which touch credentials use synthetic fixtures and disposable homes only. Shared-system integration is gated by the full suite before delivery.

### 00 — Baseline and plan

Confirm clean Git state, pin both references, install the existing frozen root lockfile, run typecheck and the complete existing tests. Record baseline failures separately from regressions. Commit this plan before production edits.

### 01 — Response-state persistence and bounded I/O

Backport the final behavior of `02c302a54` and `34c9e9802` into the existing state store rather than replacing it. Skip byte-identical snapshots only after checking the actual disk target/content, scale debounce with snapshot size, and limit background rewrite attempts while preserving explicit shutdown flushes. Audit UTF-8 byte accounting and avoid retaining another full snapshot in memory. Regressions cover unchanged writes, external modification, home changes, pending spill cleanup, concurrent mutation and restart restoration.

### 02 — Astra catalog correctness

Use the final pinned Astra row and metadata from `d617a042b`, `c5671b670`, `c2870fb55`, and the Astra-relevant portion of `980a9fbed`. Retain fork-native catalog structure and existing non-Astra context policy. Preserve Astra's own identity, effort ladder, default effort, tool mode, base/long context ceiling and explicit user caps. Do not introduce the upstream entitlement framework or change the user's featured roster. Verify native passthrough, catalog build/sync, model visibility, effort clamping, and pricing provenance separately. Preserve already-landed GPT-6 identity neutralization.

### 03 — OpenCode Muse compatibility

Retain existing exact-model Responses routing, image/1M metadata and `x-opencode-session`. Complete endpoint-scoped search-field filtering and collision-safe dotted tool aliases using the final behavior around `20011a1c4` and `43248e499`. Audit registry enrichment so persisted per-model overrides do not hide unrelated newly-known metadata. Verify new and persisted providers, both Muse versions, sibling-model negative controls, tool execution round trips, key rotation and session stability. Do not copy Command Code effort ladders to OpenCode or add Meta providers.

### 04 — Kiro compatibility and bounded translation

Port applicable Unicode boundary fixes (`831283d06`, `eeef7a32a`), bounded non-stream collection (`21f7f88a0`), composed schema keys (`f392e02eb`), and precise text-control validation (`a0d1ebbe4`). Evaluate permissive parallel hints (`db040e70f`) against the fork's explicit disabled parallel preset; never change the advertised default inadvertently. Preserve commentary/image replay retirement, private completion ownership, cancellation and event contracts.

### 05 — Kiro account and completion lifecycle

Compare the existing fork quota/account code before carrying Builder ID profile selection, completed-answer suppression, code-mode tool budgeting, quota-aware selection and reset-aligned cooldown. Use complete dependency groups rather than historical intermediate commits. Preserve account attribution through retries and terminal continuation; keep user pause state authoritative. Tests must prove no extra upstream call after a committed final answer, no replay after visible output, correct identity across rotation, and unknown quota remaining unknown.

### 06 — Kiro context estimation

Use small Kiro-owned calibration/payload-cost modules, based on `9c0e3ca80` plus its correction `7e06b990f`. Separate text/script cost, JSON escaping and framing. Bound calibration state and preserve measured usage over estimates. Verify Korean/CJK, emoji, escaped strings, tool-heavy turns, images, resumed history and completion fallback without changing another provider's token contract accidentally.

### 07 — Grok 4.6 and Responses compatibility

Bring in Grok 4.6 metadata and exact effort/default behavior while preserving explicit overrides and the existing weekly quota implementation. Introduce only xAI leaf compatibility modules needed for tool schemas and web search. Implement the final Responses-default/explicit-Chat contract for supported OAuth models only after the full request/response/retry path passes. Keep public API-key and subscription transport/tier behavior distinct. Do not add xAI Imagine, x_search, multi-agent models or the unrelated Grok client UI redesign.

### 08 — Additional measured optimizations

Inspect current hot paths for repeated work after stages 01–07. Candidate areas: quota refresh single-flight/failure backoff, repeated Windows ACL probes and remaining redundant polling. Existing GUI scheduler optimizations must not be reintroduced. Only ship optimizations with a reproducible redundant operation, bounded cache invalidation and a negative-control regression. Prefer deterministic operation counts over unstable timing thresholds; do not report a latency/RSS improvement without measurement.

### 09 — Integration, documentation and delivery

Run root typecheck/full tests/privacy scan, affected GUI tests/lint/build, and documentation frozen install/build when docs change. Review the complete diff against the fork baseline, confirm excluded providers/features and Notch behavior remain unchanged, and record unavailable platform/live-provider checks honestly. Commit final documentation and fixes separately. Recheck the remote fork for concurrent changes, then push the completed work branch without force, release, package publication or automatic main merge.

## Validation and rollback policy

- Focused adapter/catalog/state regressions plus root typecheck for each implementation stage.
- Full backend/root suite for the integrated result; existing fork tests stay in their current layout.
- No live provider credentials, real user-home mutation, automatic service start/stop or billable test request.
- No unreviewed change to release automation, package namespace, Notch packaging or default account policy.
- Stage commits are independently reviewable/revertible. If a candidate requires an unrelated new subsystem, reimplement the narrow contract or document its deferral rather than silently pulling that subsystem in.
- A clean patch application is not proof of semantic compatibility. Before/after tests are the acceptance oracle.
