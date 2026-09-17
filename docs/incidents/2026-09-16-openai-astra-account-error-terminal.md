# OpenAI account-specific model error terminals

- **Date/time:** 2026-09-16 Asia/Seoul
- **Symptoms:** Astra requests routed through one OpenAI pool account repeatedly ended before first output with `upstream_server_error`. A later check found the same account intermittently failing Luna as well.
- **Impact:** The affected conversation saw repeated immediate failures instead of rotating to another eligible OpenAI account.
- **Evidence:** VM usage logs concentrated the failures on one account label. Fresh pinned Astra probes reproduced one `server_error` and two `server_is_overloaded` events, while a fresh probe on another account completed normally. A later Luna sample on the affected account contained three successes and nine failures; a fresh valid Luna probe returned a top-level `server_error`. The credential remained unexpired, had a refresh grant, was not marked for reauthentication, and produced no upstream 401 evidence.
- **Cause:** OpenAI returned a top-level Responses SSE `error` event after an HTTP 200 handshake. The SSE inspector recognized only `response.completed`, `response.failed`, and `response.incomplete` as terminals, so the failure did not reach account health and failover tracking.
- **Response:** Treat top-level `error` events as failed terminals and derive their semantic HTTP status from the embedded error object. The validated working tree was packaged as a complete npm artifact, installed in an isolated VM prefix, and linked successfully before replacing the live package directory. The prior package was retained as a rollback directory.
- **Verification:** A regression test confirms three overloaded terminals produce three transient failures and move the conversation to the next eligible account. Targeted tests, type checking, privacy scanning, and the full Windows test suite passed. The staged and installed VM trees each linked 710 modules and contained 423 source files and 46 GUI files. After restart, internal and public health checks returned 200 with PID 3833587 and the service reported zero supervisor restarts. A live Luna sequence recorded three consecutive top-level server failures on the affected account label, then routed the next request through a different account label and completed in about 2.6 seconds.
- **Follow-up:** Publish the complete source state in a later version so a normal package reinstall cannot remove this deployed working-tree fix. Keep the retained rollback directory until that release is verified.
## Follow-up: apparent disconnects and unexpected Fast/Luna/Terra rows

On 2026-09-17 KST, the proxy remained healthy (`NRestarts=0`), while individual
OpenAI Responses requests ended with `upstream_server_error` or took 26-35 seconds
to produce their first output. The affected requests arrived with
`service_tier=priority`; the OpenAI responses reported the effective tier as
`default`.

The priority tier was enabled by OpenCodex's Codex config injection, which wrote
`[features] fast_mode = true` on every sync even when the user had never enabled
Fast. The injector now leaves both `fast_mode` and `service_tier` under caller
control. Existing Fast controls remain supported.

The Luna and Terra rows were separate model IDs in the incoming requests, grouped
under worker conversation IDs created by the same Codex session. They were not
rewrites of the Astra request. Luna was also present in the configured subagent
roster and ranked near the front of the injected catalog.

The affected privacy label `p386b46` maps to the 00dataresearch pool account in
the VM's current configuration. The credential was not marked `needsReauth`, and
the failures contained no 401 response or token-expiry evidence. The account was
therefore left eligible: terminal upstream failures now feed the existing
transient cooldown and account failover policy instead of being mistaken for an
authentication failure or forcing a permanent account pause.

The complete package was redeployed on 2026-09-17 KST. The staged and live trees
each contained 423 source files, 47 GUI files, and 3,864 installed module files
or links. One supervised restart changed PID 3833587 to 747637; health returned
200 and `NRestarts` remained zero. The VM Codex config contained neither
`service_tier` nor `fast_mode` after restart. A default-tier Luna smoke request
completed with HTTP 200; its usage row recorded no requested service tier, no
requested speed label, and OpenAI's effective response tier as `default`.

## Follow-up: coseung2 quota bar disappeared

Only the coseung2 account lost its Notch quota bar. A fresh quota request for
that account returned no quota while account health still appeared healthy and
`needsReauth` remained false. The quota endpoint rejected the stored access
token with `token_revoked`, and the token endpoint rejected its refresh grant
with the nested code `refresh_token_invalidated`.

The refresh parser recognized legacy string OAuth errors but did not read a code
from OpenAI's nested error object. It therefore classified this terminal
credential failure as unknown and left the account falsely healthy. The parser
now accepts both response shapes and maps `refresh_token_invalidated` to a
revoked credential without retaining or exposing upstream descriptions. This
causes the account API and Notch to report reauthentication required instead of
hiding the allocation bar with a healthy status.
