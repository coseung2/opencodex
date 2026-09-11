# Remote OpenAI login flow expired

- Date/timezone: 2026-09-12, Asia/Seoul.
- Symptom: Adding an OpenAI account through remote OCX completed the browser consent screens, but OCX reported `Login flow expired or unknown` before the callback could be relayed.
- Impact: The requested Codex pool account could not be added through the remote client-browser flow.
- Timeline: The failure was reproduced against the live remote service, traced to the background pool-login status poll, fixed and regression-tested locally, then deployed to the installed remote runtime. A fresh OAuth attempt completed after the service restart.
- Evidence: The worker polled `getLoginStatus("chatgpt")` without the OAuth flow id. Remote client-browser login status is flow-scoped, so the unscoped lookup returned an expired result even while the current flow was pending.
- Cause: `src/codex/auth-api.ts` omitted `result.flowId` when polling the nested OpenAI OAuth flow.
- Response: Changed the poll to `getLoginStatus("chatgpt", result.flowId)`, added a regression assertion, backed up and replaced the installed runtime file, and restarted `opencodex-proxy.service`.
- Recovery verification: The fresh flow reached `done` without an error. The remote account list increased from six pool accounts to seven and contains the newly added masked school-domain account. The remote service remained active and `/healthz` returned success with the deployed file hash matching the validated local source.
- Prevention: Keep every remote OAuth status lookup bound to the flow id returned by `startLoginFlow`, and preserve focused regression coverage for that call shape.
