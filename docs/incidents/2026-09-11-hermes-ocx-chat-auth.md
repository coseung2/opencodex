# Hermes to OCX Chat Completions authentication failure

- Date/timezone: 2026-09-11, Asia/Seoul.
- Symptom: the VM Hermes gateway reported `HTTP 401: opencodex API key required` for both its primary Muse model and DeepSeek fallback through `custom:ocx`.
- Impact: Hermes could resolve its configured models but could not start provider turns through the local OCX service.
- Evidence: the Hermes credential pool and runtime resolver held the same data credential as the OCX service. Authenticated `/v1/models` requests succeeded, while `/v1/chat/completions` rejected bearer and generic `x-api-key` admission. The dedicated `x-opencodex-api-key` passed admission and then exposed a missing OpenCode Go session-affinity header.
- Confirmed cause: OCX deliberately requires its dedicated admission header on Chat Completions. Hermes sent the service token as an OpenAI bearer credential, and Chat Completions replay did not forward Hermes's explicit `x-opencode-session` header into the internal Responses request, so OCX could not derive the OpenCode Go affinity value.
- Response: configured Hermes's existing custom-provider headers with the dedicated OCX admission credential and a stable gateway session value. Added `x-opencode-session` to OCX's bounded Chat Completions replay allowlist and session-lane derivation.
- Recovery verification: after restarting OCX and Hermes on the VM, an exact `custom:ocx` runtime request to `opencode-go/muse-spark-1.3-contributor` returned HTTP 200 with one completion choice. Both services remained active.
- Validation: focused metadata and OpenCode Go transport tests passed (16 tests), repository typecheck passed, and the native Notch suite passed (112 tests).
- Prevention: keep endpoint-specific admission headers separate from provider bearer credentials, and cover Chat Completions clients that supply a stable non-Codex session header.
