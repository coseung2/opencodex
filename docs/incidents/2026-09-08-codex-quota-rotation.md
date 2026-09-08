# Codex account rotation after quota exhaustion

- Date: 2026-09-08, Asia/Seoul (UTC+09:00).
- Impact: repeated native Codex requests failed with a usage-limit message while other pool accounts remained available.
- Evidence: 20 recent request records carried HTTP-equivalent 502 failures and an incomplete terminal on one account. The inspected failures reported `The usage limit has been reached`. The quota snapshot for that account showed five-hour usage below 100% and weekly usage at 100%. Two other configured accounts required reauthentication and were excluded from routing.
- Confirmed causes: Plus/Team/Business scoring returned five-hour usage before checking weekly/monthly exhaustion. Separately, terminal inspection classified error payloads only on `response.failed`; the account outcome recorder treated every `response.incomplete` as success. Together these paths could retain an exhausted account without a quota cooldown.
- Response: treat a fully consumed longer window as exhausted, classify explicit errors in incomplete terminals, and feed that classification into account cooldown and subagent quota handling. Preserve ordinary output-limit handling and avoid replaying an already-started stream.
- Regression evidence: tests failed before the fix for exhausted five-hour/weekly/monthly selection and incomplete quota errors. All six reproductions passed after the fix. Additional cases cover ordinary incomplete terminals without an error.
- Runtime status: the repository-backed proxy still runs from its 2026-09-08 08:38 Asia/Seoul start, before these changes. Its `/healthz` endpoint reports `ok`. Restart remains deferred to the user, as requested; no live recovery attributable to this patch is claimed.
- Follow-up: restart the existing proxy to load the changes, then verify rotation on the next exhausted-account request. Revoked or expired refresh grants, or a repeated 401 after refresh, still require reauthentication; a temporary refresh failure does not.

## Related Team account reauthentication

The user also reported frequent reauthentication. Sanitized local metadata confirmed an upstream
401 invalid-token rejection while the stored access-token expiry was still in the future. The
dashboard's `refresh_failed` reason is a generic projection of the reauthentication flag, so it is
not proof of a token-endpoint failure. The native Codex forward path did not attempt an early refresh
on a 401. Review also found transient token-endpoint failures could set the reauthentication flag.
The patch adds one refresh/replay before streaming for added accounts and for quota probes, and
distinguishes temporary refresh failures from terminal grants. Focused tests cover successful replay,
429/503 refresh failures, a second upstream 401, duplicate grants, and concurrent credential replacement.
Review covered token redaction, bounded retries, and generation-guarded persistence; the main account
remains owned by the Codex app.

## Final validation

- `bun run test`: 7,305 passed, 11 skipped, 0 failed across 505 files in 11 Windows batches.
- `bun run typecheck`, `bun run privacy:scan`, and `git diff --check` passed.
- Documentation build passed with 221 pages. English and translated configuration guidance now
  distinguish five-hour preference from longer-window exhaustion and describe the bounded 401 recovery.
- An earlier full-suite attempt hit `windows_enum_incomplete` in the existing live Windows process
  enumeration test. Its isolated file passed all 25 tests, and the unchanged test passed again in the
  final complete suite. This was not treated as a quota/auth regression or a reason to weaken the test.
- Runtime restart is still deferred to the user. Live post-restart recovery remains to be verified.
