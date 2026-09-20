# Drained pool accounts selected during an upstream overload wave

- **Date/time:** 2026-09-18 Asia/Seoul (UTC+09:00).
- **Symptoms:** OpenAI pool requests failed while added accounts still showed
  remaining allocation. Log labels `p386b46` (00dataresearch) and `p621119`
  (coseung2) — both with quota headroom — were rotated away, and the requests that
  followed were served by `pc1da43` and `p35cda4`, which reported
  `The usage limit has been reached`. The client then received
  `429 Selected Codex account (account-…1469) is cooling down …`.
- **Impact:** `gpt-6-astra` turns failed repeatedly between roughly 00:45 and 01:12
  KST even though two pool accounts had usable quota. The user-visible error was a
  cooldown message for an account that had nothing left to serve.
- **Timeline (KST):** 00:53:36 the last astra request that upstream actually served
  as astra. From 01:04 onward the pool alternated between overloaded 502s on
  quota-holding accounts and quota 502s on `pc1da43`/`p35cda4`; the first
  client-visible cooldown 429 landed at 01:11:10.
- **Evidence:** `/api/logs` rows for the window show four distinct shapes:
  `upstream_server_error` with `Our servers are currently overloaded` on
  `p386b46`/`p621119`/`p3c9835`, `upstream_server_error` with
  `The usage limit has been reached` on `pc1da43`/`p35cda4`, and the terminal
  `rate_limit_exceeded` cooldown 429 naming `account-…1469` (`p35cda4`). The pool
  snapshot taken during the window showed `fiveHourPercent`/`weeklyPercent` of
  `0/100` and `0/100` for the two accounts that were selected, against `15/91` and
  `3/99` for accounts that were only soft-avoided.
- **Confirmed cause:** a transient-5xx soft avoid (30s, escalating to 2m/10m/30m)
  removed every quota-holding account from pool selection in turn. Pool eligibility
  did not consider quota exhaustion at all, so the drained accounts were the only
  remaining candidates. Failover then promoted a drained account, which could only
  answer with a quota rejection, and the request chain ended on the cooldown error.
  A stale `excludeAccountId` view made this worse: releasing the drained accounts
  against the post-exclusion candidate set re-admitted them on the next failover hop.
- **Response:** `getEligiblePoolAccounts` now retires quota-exhausted accounts for
  the whole pool as soon as any candidate still holds quota, and computes that
  decision before per-call exclusion. A soft avoid no longer outranks quota
  headroom, and an all-avoided pool resolves one of its quota-holding accounts
  instead of falling through to a drained one. A fully drained pool keeps its
  previous last-resort behavior.
- **Verification:** `bun x tsc --noEmit` and `bun run privacy:scan` passed.
  `tests/codex-routing.test.ts` passed 123 tests including three new regressions
  (drained account versus a soft-avoided quota holder, failover promotion, fully
  drained pool). Pool rotation, auth-context, main-rotation, subagent fallback and
  quota-prime suites passed 147 tests (2 skipped); combo-failover and account-quota
  suites 93; Codex auth API 157.
- **Follow-up:** the overlay is local to this working tree until it is deployed to
  the Hermes VM proxy; the running package directory still predates it.

## Separate upstream observation: Astra served as Luna

This failure was not the same defect. Between 00:53:36 and 01:29 KST every
`gpt-6-astra` request was answered by upstream as `gpt-5.6-luna`:
`/api/logs` recorded 276 astra-served rows whose last entry is 00:53:36, and 60
rows resolved to `gpt-5.6-luna` beginning at 15:50 and concentrating after 00:53.
Four direct probes against the running proxy (`model: gpt-6-astra`, no thread-spawn
headers, no configured fallback chain) each returned HTTP 200 with
`"model": "gpt-5.6-luna"` in the upstream `response.created` event, so the
substitution happens upstream and is reported back through the `openai-model`
header. Luna intermittently answered `Our servers are currently overloaded`, which
is what the user saw as "Astra is not working". Nothing in this repository selects
Luna for an Astra request.
