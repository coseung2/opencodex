# Kiro organization device login fails before authorization

- Date/timezone: 2026-09-11, Asia/Seoul.
- Symptoms/impact: Notch organization add-account failed after Start URL and region submission; no verification URL or user code appeared.
- Evidence: Installed Kiro CLI 2.19.1 received the expected login options, reported two non-terminal input warnings, then failed AWS OIDC RegisterClient endpoint construction with an invalid region host label. Explicit AWS region environment overrides did not resolve the failure.
- Cause: Confirmed failure boundary is the CLI organization login under piped output. The exact CLI internal cause remains unverified. An earlier claim that the global AWS configuration alone caused the failure was not supported by the override experiment.
- Timeline/response: Initial URL/code parsing and browser-opening fixes passed focused tests but did not restore live login. Diagnostic attempts restored the previous native session. Work then moved to direct OCX-managed AWS device authorization, preserving the native CLI session.
- Recovery verification: Direct AWS authorization returned a verification URL and matching user code; cancellation preserved the native session. Installed OCX was updated and `/healthz` recovered. The installed management API returned the exact organization portal and matching code, then cancellation succeeded. GUI 7 and Notch 76 focused tests passed. Interactive Notch inspection was unavailable because the Computer Use native pipe could not connect; browser approval and final account insertion remain pending user verification.
- Test finding: The full suite initially failed a Builder ID fixture because inherited Kiro import selectors pointed to the real session. The fixture now clears/restores those selectors; its seven tests pass. The restarted full suite completed all 11 batches successfully (507 files, exit 0); final identity/device regressions also passed separately. Typecheck, GUI lint, privacy scan and documentation build passed.
- Prevention: Cover actual authorization response, cancellation, polling/expiry, account identity and credential isolation; distinguish mocked checks from installed runtime verification.

## Follow-up: organization inference returned 403

- Symptom: The newly authorized account could load quota and join the pool but inference returned 403.
- Confirmed cause: Direct authorization omitted the organization profile ARN, selecting the existing personal-service fallback profile and CLI envelope.
- Evidence: Authenticated `POST /ListAvailableProfiles` returned one profile for the affected account. The same minimal model request with the same token returned 403 before adding its own profile and 200 afterward.
- Response: Stored the account's own verified profile without re-login; direct organization login now resolves a single unambiguous profile before persistence. Missing or ambiguous profiles fail explicitly.
- Verification: 80 focused Kiro tests, typecheck and privacy scan passed. Installed runtime updated and healthy. Full suite rerun initiated.
