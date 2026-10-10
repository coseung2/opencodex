# Claude continuity test isolation

- Date/timezone: 2026-10-11, Asia/Seoul; observed around 04:06-04:08 KST.
- Symptoms: an ad-hoc run combining eight Claude test files reported 18 localhost `ConnectionRefused` failures after test servers had announced their ports.
- Impact: that combined validation run failed. No production service, settings, credentials or conversation was changed by the tests.
- Timeline/evidence: focused pure translation tests passed; the mixed run had 98 passes and 18 failures; rerunning `tests/claude-messages-endpoint.test.ts` alone passed all 28 existing tests. Logs remain in ignored `.tmp/claude-continuity-endpoint-test.log` and `.tmp/claude-continuity-full-test.log`.
- Cause: unresolved. Shared test-process lifecycle/global-state interference is a hypothesis, not a confirmed production fault.
- Response: use an isolated endpoint run and the repository's official full-suite runner rather than treating the combined failure as a proxy regression.
- Recovery verification: isolated endpoint run passed all 28 existing tests, then 29 with the new two-turn HTTP regression. The official full-suite runner completed all 12 batches with exit code 0 and no failures. Later catalog edits are also checked with isolated focused runs; the full-suite run is not claimed as a second run of those later edits.
- Follow-up: retain process isolation for endpoint/intercept test validation and investigate shared teardown if the mixed-run failure recurs.
