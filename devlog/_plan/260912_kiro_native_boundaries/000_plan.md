# Kiro native-boundary refactor plan

Date: 2026-09-12 (Asia/Seoul)
Branch: `fix/kiro-task-continuity-20260912`
Target PR: `coseung2/opencodex#2` → `main`

## Goal

Make Kiro direct connectivity structurally match the rest of OpenCodex: canonical Responses history and task-continuity state stay provider-agnostic, while the Kiro-specific layer only translates that state into CodeWhisperer wire shapes and performs native transport/auth/event-stream work.

The current `src/adapters/kiro.ts` is 2,163 lines and owns request history rebuilding, completion/fallback policy, token/accounting policy, CodeWhisperer payload encoding, auth/profile/region headers, endpoint construction, retry fetch wiring, AWS event-stream decoding, response normalization, and the final ProviderAdapter facade. The immediate commentary-loss bug came from a UI-progress policy being implemented inside that same payload builder. The refactor must make that class of cross-layer mutation harder to introduce.

This unit is an architectural refactor after the functional continuity fixes already on PR #2. It must not intentionally change observable behavior.

## Target architecture

```text
Codex / Claude / Chat client
        ↓
canonical OcxParsedRequest + Responses history
        ↓
kiro-continuity.ts
  terminal/completion/fallback policy only
  no AWS headers, endpoint construction, event-stream decoding
        ↓
kiro-codec.ts
  canonical history ↔ Kiro conversationState
  AWS event-stream ↔ AdapterEvent
  no credential resolution or network I/O
        ↓
kiro-transport.ts
  Kiro region/profile/wire-client selection
  GenerateAssistantResponse endpoint + headers
  retry-aware fetch
        ↓
Kiro CodeWhisperer GenerateAssistantResponse

kiro.ts
  thin ProviderAdapter facade/orchestration across the three layers
```

`kiro.ts` remains the stable import surface so `resolveAdapter()` and existing tests/users do not need a repository-wide rename. Existing public test helpers (`buildKiroPayload`, `parseKiroStream`, `kiroReasoningMode`, `isRetryableKiroStreamCatchError`, `boundedInjectedInstructionForTests`) remain re-exported from the facade. Request encoding and event-stream decoding live together in `kiro-codec.ts` because they are the two directions of the same Kiro wire translation boundary; neither may resolve credentials or perform fetches.

## Non-negotiable invariants

1. Commentary continuity
   - `phase: "commentary"` assistant text remains durable Kiro input history.
   - Historical commentary is never automatically emitted as new output.
   - Routed compaction sees the same preserved commentary.
   - The existing anti-repeat instruction remains active.

2. Completion semantics
   - Tool-enabled Kiro turns use the private `codex_kiro_final_answer` completion contract.
   - A delivered final answer terminates locally and is never reopened.
   - Blocking questions remain valid terminal answers.
   - Progress-only clean stops still receive at most one bounded completion validation.
   - A completion call never receives or waits for a tool result.

3. Tool/history validity
   - Tool-use/result ids remain paired by original identity.
   - Adjacent multi-output results remain coalesced only for the same original call.
   - Tool-search discoveries and freeform `exec` stay within the count/byte catalog budgets.
   - No command/tool is automatically re-executed by the adapter.

4. Reasoning/image continuity
   - Kiro redacted reasoning blobs retain their existing round-trip ownership.
   - Current-turn images survive; retired replay-prefix image bytes remain omitted.
   - Image evidence still prevents false “empty exec output” diagnostics.

5. Native transport/auth
   - OAuth/API-key distinction, Builder ID fallback, enterprise profile ARN, API region, runtime endpoint, user-agent, `x-amz-target`, token type, and retry behavior remain byte/semantics compatible with the current adapter.
   - Client cancellation still aborts both the first request and the one bounded fallback request.
   - Error bodies remain credential-safe and redacted.

6. Usage/context accounting
   - Request-log input estimates, current-turn usage, context-pressure estimates, calibration and conversation rekeying retain current semantics.
   - Translator-budget retention/release behavior remains bounded on all terminal/error/cancel paths.

7. Public surface
   - `/v1/responses`, `/v1/chat/completions`, `/v1/messages`, non-streaming Responses, and provider routing keep existing behavior.
   - No service restart, deployment, credential mutation, or account action is part of this change.

## Detailed implementation phases

### Phase 0 — Lock the baseline and architecture tests

Before moving implementation code:

- Record branch SHA and clean worktree state.
- Keep the current Kiro continuity regression suite green.
- Add architecture-boundary tests that assert:
  - `src/adapters/kiro.ts` is a facade and delegates to explicit Kiro modules.
  - continuity policy does not import transport/auth/network modules.
  - codec does not import OAuth credential resolution or fetch/retry modules.
  - transport does not own commentary/final-answer history policy.
- Do not weaken existing behavioral tests to make the refactor pass.

Acceptance: tests fail if responsibilities drift back across the documented boundaries.

### Phase 1 — Extract continuity policy

Create `src/adapters/kiro-continuity.ts` and move policy-only logic there:

- delivered-final detection used by local terminal handling;
- completion mode selection;
- bounded completion-tool/instruction contract construction;
- fallback-history preparation (provider continuation id + replayable assistant progress);
- exact fallback serialization upper-bound helper/constant where it is policy-owned.

Rules:

- no `resolveKiroApiRegion`, profile resolution, endpoint URL, headers, `fetch`, event-stream decoder or AWS constants;
- no direct mutation that drops canonical history based on UI phase;
- functions accept/return canonical request/policy data rather than network objects.

Acceptance: local-terminal, progress fallback, blocking-question and delivered-answer tests remain unchanged and green.

### Phase 2 — Extract native request codec

Create `src/adapters/kiro-codec.ts` and move canonical-history → Kiro wire mapping there:

- Kiro wire message/tool/result interfaces;
- `buildKiroPayload` and conversation-state validation;
- tool wire name mapping and catalog injection;
- commentary/history preservation;
- redacted reasoning placement;
- replay-prefix image retirement behavior;
- code-mode empty-result normalization;
- Kiro capability checks;
- reasoning-mode/thinking-tag mapping;
- token/context estimate helpers that depend on the serialized Kiro payload.

The codec may depend on pure helpers (`kiro-tools`, `kiro-images`, `kiro-wire`, identity/tool nudge, continuity policy) but must not resolve account credentials or perform network I/O.

Acceptance: all existing payload-shape tests pass without fixture changes except imports/re-exports.

### Phase 3 — Extract native transport

Create `src/adapters/kiro-transport.ts` and move network-facing request construction there:

- Kiro CLI/IDE wire-client selection;
- Builder ID/API-key/profile behavior;
- region/profile resolution;
- runtime endpoint construction and fixed-host validation;
- native user-agent strings and AWS/CodeWhisperer headers;
- request serialization after image normalization;
- debug-safe request diagnostics;
- retry-aware `fetchKiroWithRetry` entry point.

Expose a typed `buildKiroNativeRequest()` result containing only what the facade/stream layer needs: `AdapterRequest`, tool name map, conversation id, completion mode, current-turn input estimate and context estimate.

Acceptance: auth/profile/runtime/401-replay/retry tests remain green; no secrets appear in diagnostics.

### Phase 4 — Keep response decoding inside the native codec boundary

Move CodeWhisperer response parsing into the same `src/adapters/kiro-codec.ts` module as request encoding:

- AWS event-stream decoding;
- Kiro event classification;
- tool input assembly;
- thinking/reasoning parsing;
- staged commentary/final-answer phase mapping;
- usage/context checkpoint accounting and calibration;
- bounded retention/release;
- one bounded completion-attempt orchestration interface.

The codec receives a fallback factory callback; it must not resolve credentials or build native headers itself. Keeping request encoding and response decoding together makes the codec the single Kiro wire-protocol owner while transport remains strictly network/auth.

Acceptance: stream/reasoning/usage/context-pressure tests remain green and cancellation still releases retained budget.

### Phase 5 — Make `kiro.ts` a thin facade

Reduce `src/adapters/kiro.ts` to ProviderAdapter orchestration:

- keep per-request state needed to bridge `buildRequest` → `parseStream`/`parseResponse`;
- delegate initial/fallback request construction to transport + continuity helpers;
- delegate parsing to `kiro-stream`;
- delegate local terminal to continuity;
- delegate error formatting to the existing error helper;
- re-export stable Kiro helper functions used by tests/other modules.

Target: the facade should be small enough that a future change to commentary retention cannot be hidden among transport/eventstream code. A strict line-count target is not a correctness requirement, but roughly <350 lines is preferred.

### Phase 6 — Documentation and decision log synchronization

Update:

- `structure/04_transports-and-sidecars.md` with the new dependency direction and ownership rules;
- Kiro troubleshooting docs only if user-visible behavior wording changes (none expected beyond clarifying architecture);
- this plan with actual file/validation outcomes;
- existing `260912_kiro_task_continuity` findings with a pointer to the structural follow-up.

Document the important prohibition explicitly: transport/codec layers must not decide that a canonical assistant message is “just UI” and erase it.

### Phase 7 — Validation gates

Run in this order so failures identify the layer that moved incorrectly:

1. New architecture-boundary tests.
2. Focused payload/continuity tests:
   - `kiro-adapter`
   - `kiro-task-continuity`
   - `tool-catalog-nudge`
3. Stream/reasoning tests:
   - `kiro-stream`
   - `kiro-reasoning-roundtrip`
4. Auth/transport tests:
   - `kiro-retry`
   - `kiro-oauth`
   - `server-kiro-oauth-401-replay`
5. Public endpoint/compaction tests:
   - `server-kiro-completion-e2e`
   - `responses-parser`
   - `responses-compaction`
6. `bun run typecheck`
7. `bun run privacy:scan`
8. docs frozen install/build
9. repository-wide test run; any baseline/environment failure must be reported separately and never called green.

### Phase 8 — Commit and push

- Review `git diff --check`, staged privacy scan and final status.
- Commit the architecture refactor as a distinct logical commit on top of the two functional continuity commits already in PR #2.
- Push only `fix/kiro-task-continuity-20260912` to `origin`.
- Update PR #2 summary with the new architecture boundary, validation counts and any full-suite limitation.
- Confirm `enforce-target` succeeds under the repaired fork-main policy and inspect the main CI statuses.
- Do not merge, deploy or restart the operational proxy in this unit.

## Risks and mitigations

### Circular imports

Risk: moving completion helpers, payload codec and transport can introduce `continuity ↔ codec ↔ transport` cycles.

Mitigation: dependency direction is strict: `continuity` may depend on constants/types and canonical provider-agnostic turn-termination state only; `codec` may depend on continuity and pure Kiro helpers; `transport` may depend on codec; facade may depend on all. Codec may decode event streams but never imports OAuth/profile resolution or retry/fetch transport. Stream-level throttle observations leave the codec through a callback and are recorded by transport.

### Hidden state split

Risk: request-derived state currently lives in one adapter closure; extracting builders can accidentally lose model id, conversation id, tool map, completion mode, context estimates or abort signal.

Mitigation: define one typed native-build result and assign facade state from it in one place. Add/retain tests for conversation-id reuse, calibration, fallback context growth and cancellation.

### Behavior changes disguised as moves

Risk: large code movement makes semantic drift difficult to review.

Mitigation: no opportunistic provider behavior changes during extraction. Keep functional deltas separate from pure movement. Existing golden payload tests and stream tests are the acceptance oracle.

### Memory/accounting regressions

Risk: moved stream collectors can double-release or leak TranslatorBudget reservations.

Mitigation: preserve current try/finally ownership and run near-cap/cancellation tests before broader suites.

### Upstream incompatibility

Risk: fork-only module layout can make future upstream cherry-picks harder.

Mitigation: retain stable exported names from `kiro.ts`; isolate upstream-compatible behavior inside focused modules; document where upstream fixes should land.

## Rollback strategy

The refactor is one commit layered above already-tested functional fixes. If architecture extraction causes a regression that cannot be resolved without changing behavior, revert only the architecture commit; the earlier empty-exec/catalog/commentary continuity fixes remain intact. No migration or persisted state format is introduced, so rollback requires no data conversion.

## Completion criteria

This unit is complete only when:

- the plan and structure docs match the implemented dependency graph;
- commentary and compaction continuity remain covered;
- Kiro payload/auth/stream/public-endpoint tests pass;
- typecheck/privacy/docs pass;
- `kiro.ts` is a thin orchestration facade with stable re-exports;
- the architecture commit is pushed to PR #2;
- PR branch-policy check is green;
- any remaining CI/full-suite limitation is recorded without claiming success.

## Implementation outcome

Implemented on 2026-09-12 in the existing PR #2 branch.

- `src/adapters/kiro.ts`: 191-line stable facade. It owns only per-request orchestration, bounded fallback budget ownership, ProviderAdapter method wiring, and stable re-exports.
- `src/adapters/kiro-continuity.ts`: 130 lines. Owns delivered-final detection, completion-mode policy, private completion tool/instruction bounding, canonical fallback-history preparation, and exact replay-string size accounting. It has no auth/network/event-stream imports.
- `src/adapters/kiro-codec.ts`: 1,791 lines. Owns request encoding and response/event-stream decoding, including history/tool/result/reasoning/image/usage continuity. It has no credential resolution or fetch/retry dependency. Stream-level throttle observations leave through a callback rather than importing retry state.
- `src/adapters/kiro-transport.ts`: 153 lines. Owns Kiro native region/profile resolution, API-key/Builder-ID/IDE envelope selection, CodeWhisperer headers and endpoint, image-normalized serialization, safe request diagnostics, retry-aware fetch, and stream-throttle cooldown recording.
- `tests/kiro-architecture-boundary.test.ts`: pins the dependency rules so policy/network responsibilities cannot silently collapse back together.

The architecture-boundary test was written first and failed 5/5 against the monolithic baseline. After the extraction it passes 4/4 (the finalized three-layer design intentionally folded event-stream decode into the bidirectional codec instead of a fourth stream module).

Focused post-refactor validation across payload, continuity, tool catalog, stream, reasoning, OAuth, retry, 401 replay, public completion, Responses parser/compaction, and architecture boundaries: **357 pass, 0 fail, 1,206 assertions across 12 files** after the final throttle-callback boundary fix. `bun run typecheck`, `bun run privacy:scan`, and `git diff --check` passed. Repository hygiene passed **10/10** (17 assertions). Frozen docs install/build passed with **231 pages** and no lockfile changes.

A repository-wide run was attempted with a deliberate 240-second ceiling because the same VM had already produced a 576-second CPU-bound incomplete run earlier in this unit. The bounded rerun made steady progress but hit the ceiling in `oauth-refresh-lock-multiprocess.test.ts` before producing an aggregate, exiting 124 after 242 seconds. This is recorded as an incomplete full-suite validation, not green and not a Kiro test failure. Earlier clean-main reproduction still accounts for the known three `shutdown-launcher` startup-health failures.

Security review: the native auth/header/endpoint block was compared directly against `a3f0fbe54`. API-key detection, Builder-ID/profile selection, region resolution, canonical/custom endpoint behavior, `Authorization`, `tokentype`, `x-amz-target`, user agents, profile ARN, diagnostics, and retry fetch semantics are unchanged. No new credential source, network destination, permission, request-body logging, or account mutation was introduced. Focused OAuth, 401 replay, retry, adapter diagnostics, privacy scan, and architecture tests all passed.
