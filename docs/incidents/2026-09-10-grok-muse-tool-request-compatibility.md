# Grok and Muse tool-request rejection on the local proxy

- Date: 2026-09-10, Asia/Seoul (UTC+09:00).
- Symptoms: the healthy OCX listener on port 10100 repeatedly returned 422 for
  `xai/grok-4.6` and 400 for `opencode-go/muse-spark-1.3-contributor`.
  The user reported that Muse continued working through Hermes on their OCI VM.
- Evidence: sanitized request logs identified a custom-tool history item missing
  `id` for Grok and a function schema missing optional `limit` from `required`
  for Muse. Synthetic requests reproduced both errors without replaying user content.
- Confirmed causes: generic Responses handling strips item IDs with `store:false`,
  while xAI requires an ID on remaining custom-tool history. Muse rejects strict
  function schemas whose properties include optional arguments.
- Response: after generic sanitization, synthesize stable custom-tool item IDs only
  for xAI. Only at the recognized OpenCode Muse destinations, disable strict mode
  for function schemas containing optional properties, preserving parameters and
  required lists. Keep valid strict schemas and other providers unchanged.
- Timeline: verified listener health and sanitized errors; reproduced with synthetic
  calls; added regression tests; verified installed adapter matched repository HEAD;
  backed up and replaced the two affected adapter files in the local npm installation;
  requested the management drain/restart with zero active turns.
- Recovery: the replacement listener (PID 24956) answered health checks. Both original
  synthetic failure scenarios returned `completed` after the patch. Both streaming
  probes ended in `response.completed`; both models called a synthetic function with
  the expected argument and completed a follow-up after receiving its result.
  OCI was not modified.
- Additional provider constraint: a diagnostic forced-tool-choice request established
  that Muse accepts only `tool_choice: auto`. The normal auto-mode round trip passed;
  forced choices were not silently rewritten or added to this patch's scope.
- Validation: the initial 65 focused tests passed, followed by all 12 Muse tests after
  adding dynamic-tool coverage. Typecheck, privacy scan, and the 221-page documentation
  build passed. The full suite again encountered the existing failure in
  `kiro-builder-id-profile.test.ts` (accountless Builder ID profile assertion) in
  batch 6/11; a green full suite is not claimed. The earlier unrelated Kiro profile test failure is
  reproducible, but its environmental cause remains unresolved; a profile override
  was not present in the test-launch environment.
- Follow-up: keep provider dialect repairs after generic normalization and cover
  optional nested/namespace tool schemas and stateless custom-call replay.

## Recurrence: native tool search (2026-09-10, Asia/Seoul)

- Impact: actual Muse conversations still failed with `Missing 'limit'` after the
  first patch, while synthetic ordinary-function requests continued to pass.
- Confirmed cause: the native `tool_search.parameters` schema has its own strict
  validation. A synthetic search with required `query` and optional `limit`
  reproduced the exact error with strict omitted, false, and true. The previous
  function-only patch and tests did not cover this tool type.
- Response: make optional native search fields nullable and required on the Muse
  wire, and restore omitted optional arguments on client-facing search calls in
  JSON and SSE. Preserve fields that already permit null and other destinations.
- Installation: the installed core predates unrelated Go pool changes in the
  checkout. The full-file equality guard stopped copying; only this fix's exact
  hunks were applied to that core, with backups in ignored scratch space.
- Recovery: listener PID 15356 served the repaired requests. All three previously
  failing strict variants completed over SSE. A real search returned a
  `tool_search_call` with only `query` (no synthetic `limit:null`), and the follow-up
  after its tool result completed. This proves the reproduced search scenario;
  a retry of the user's original conversation has not yet been observed.
- Validation: 14 focused tests, typecheck, privacy scan, and the 221-page docs build
  passed. Full-suite validation is in progress; update this entry with its result.
- Prevention: include native tool-search parameter schemas and a search/result
  round trip in compatibility checks, rather than inferring conversation recovery
  from ordinary-function probes alone.

## Recurrence: Grok client-executed tool search (2026-09-12, Asia/Seoul)

- Impact: a Grok worker failed before research began with `tool_search execution must be 'server' or not set; client-executed tool search is not supported`.
- Confirmed cause: the xAI namespace compatibility pass returned early when a request had no namespace declarations, so a top-level native `tool_search` retained Codex's `execution: "client"` marker on the xAI request wire.
- Response: remove only that marker at the xAI Responses adapter boundary, including dynamically supplied tool groups, while preserving the original client request and client-side search call/result semantics.
- Prevention: cover the exact native declaration on both Grok OAuth and public API destinations, assert the source body is immutable, and verify a live search call plus result follow-up before release.
