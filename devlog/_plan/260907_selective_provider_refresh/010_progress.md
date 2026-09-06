# Progress and evidence

## 00 — Baseline and plan

- Working branch: `fork/selective-provider-refresh-20260907`.
- Fork baseline: `673cfee8dde264f9e8b79c7f23fb3ecf63d0f992`; upstream comparison remains `06ec553630fa2ee51a96b5cbf694089021249194`.
- `bun install --frozen-lockfile`: passed using the existing lockfile; no dependency/version changes. Bundled executable reports Bun 1.4.0 (the host-level executable is 1.3.14).
- `./node_modules/.bin/bun run typecheck`: passed, exit 0.
- `./node_modules/.bin/bun run test`: baseline run started before production edits; result to be recorded when it exits.
- No real provider calls or service operations were requested. Test runner uses disposable homes.

## Stage ledger

| Stage | Status | Notes |
| --- | --- | --- |
| 01 Persistence | Pending | Identical-snapshot skipping and background attempt limit are absent on the fork baseline. |
| 02 Astra | Pending | Slug/window exist; pinned Astra row is absent from `UPSTREAM_NATIVE_ENTRIES`. |
| 03 OpenCode Muse | Pending | Core registry/transport changes already exist; inspect remaining guards and regression coverage. |
| 04 Kiro compatibility | Pending | Text-control and parallel-hint rejection still use the older contract. |
| 05 Kiro lifecycle | Pending | Per-account quota exists in the fork; compare lifecycle changes rather than replacing the quota subsystem. |
| 06 Kiro calibration | Pending | Not present on baseline. |
| 07 Grok Responses | Pending | Grok 4.6 metadata already exists; inspect final defaults, schemas, search and retry compatibility. |
| 08 Extra optimizations | Pending | GUI coalescing/visibility polling already exists; admit only demonstrable remaining work. |
| 09 Integration | Pending | Full verification, documentation, diff review and non-force branch push. |
