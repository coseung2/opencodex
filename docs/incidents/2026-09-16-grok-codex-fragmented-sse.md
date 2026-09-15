# Grok Codex responses stalled on fragmented SSE events

- Date: 2026-09-16, Asia/Seoul (UTC+09:00).
- Symptoms and impact: Codex CLI/App sessions selecting `xai/grok-4.6` waited
  without an assistant reply, while the VM proxy logged HTTP 200 and a completed
  upstream response. Small direct Responses probes succeeded.
- Evidence: a real Codex CLI 0.154.0 call reached `turn.started` but received no
  response headers through a diagnostic relay, despite upstream completion.
  A regression test splitting one SSE event across five chunks stalled before
  the patch and passed afterward. No request bodies or credentials are recorded here.
- Confirmed cause: `relaySseWithPayloadRewrite` returned from `pull` after reading
  one partial event without enqueuing anything. Bun did not request another pull,
  leaving the client branch parked while the inspection branch logged completion.
  Tool-rich Codex requests produce larger response snapshots than minimal probes.
- Mainstream comparison: upstream `dev` at `45cfb04e9757a5a257ab6290d9f24d2ea0bc7573`
  already reads until at least one rewritten block or EOF in
  `src/server/sse-payload-rewrite.ts`. Ported that behavior without replacing
  this fork's Responses architecture. Also carried its cancellation guard and
  nonblocking tee-branch cancellation on errors.
- Response and timeline: reproduced the client stall; demonstrated a failing
  fragmentation test; patched the relay; passed 28 focused compatibility tests
  and typecheck; backed up the installed VM relay; replaced that file and
  restarted the user's `opencodex-proxy.service`.
- Deployment note: an initial system-service restart found no unit; the actual
  unit is a user service. The user-service restart succeeded. An immediate health
  request raced startup; the subsequent health check returned `ok`.
- Recovery: VM PID 2627257 served the patch on version `2.8.0-cs.26`.
  Real Codex returned `OCX_CODEX_GROK_OK` through the diagnostic relay and
  `OCX_CODEX_GROK_DIRECT_OK` directly through the configured VM provider, each
  with `agent_message` and `turn.completed`. This is a runtime hotfix, not a new
  npm release. The user's original App conversation has not been replayed.
- Model label: xAI's upstream serving slug `grok-4.6-build` is distinct from
  the separate `grok-build-0.1` model. The stall was in response delivery, not
  evidence of routing to that separate model.
- Verification completed: full suite, cancellation/error regressions, and a
  resumed Codex tool/result turn; see final results below.
- Prevention: retain a pre-EOF fragmented-event regression, and require a real
  Codex assistant event and follow-up turn when diagnosing successful server
  logs paired with missing client output.

## Follow-up: misleading compaction-blob error on reasoning replay

- The resumed real Codex session failed with `Could not decode the compaction
  blob. Ensure it is unmodified from the compact response.` Its reasoning history
  contained `content: null` and an intact native encrypted reasoning value.
- Mainstream `src/adapters/openai-responses/reasoning.ts` documents and removes
  this null channel for routed destinations: xAI reports a blob decoding failure
  for the rejected sibling field. Ported the null-channel removal specifically
  for xAI, plus output-only reasoning status removal. Kept the encrypted value
  unchanged and preserved OpenAI's null-channel contract.
- A fixture regression failed before the fix and passed afterward for both xAI
  Responses destinations. After backing up and replacing the VM adapter, the same
  previously failing Codex session executed the requested command successfully,
  replayed its tool result, and returned `OCX_GROK_FOLLOWUP_OK` with `turn.completed`.
  Recovery did not clear or rewrite the saved conversation. VM PID: 2650055.
- 109 focused adapter/logging/stream tests and typecheck passed at this point.
  Full-suite validation was still running at that checkpoint.
- Final runtime check: another turn in that same session returned
  `OCX_GROK_REPLAY_OK`. The running VM (PID 2660812) passed `/healthz`, all five
  modified runtime files matched local SHA-256 hashes, and the newest request log
  recorded `requestedModel: xai/grok-4.6`, `model/resolvedModel: grok-4.6`, and
  `terminalStatus: completed`. Historical log rows are unchanged.
- Additional validation: cancellation while a read is pending and a rewrite
  failure with an open inspection tee both pass. Sparse-terminal coverage passes
  with and without the Grok-client marker. Privacy scan and the 231-page docs
  build passed.
- Final full-suite result: `bun run test` exited 0 across 510 files in 11 isolated
  batches: 7,425 passed, 11 skipped, zero failed. Both new defect regressions were
  included. Final typecheck, privacy scan, documentation build, and diff whitespace
  check passed. No npm publication or repository commit was performed.

## Follow-up: install replaced with a consistent tree

- The cs.26-based hotfix install described above stopped starting the proxy at
  02:55 KST the same day, and it was replaced with the published `2.8.0-cs.30`
  base plus this change's five runtime files. Details:
  [`2026-09-16-vm-hotfix-missing-module-outage.md`](./2026-09-16-vm-hotfix-missing-module-outage.md).
