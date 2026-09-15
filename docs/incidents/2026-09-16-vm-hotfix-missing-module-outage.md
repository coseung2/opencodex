# VM OCX crash-looped after a partial runtime hotfix

- Date/timezone: 2026-09-16, Asia/Seoul.
- Symptoms: On the `testauram-a1-osaka` VM, `opencodex-proxy.service` cycled
  `activating/auto-restart`, and every start exited within about a second with
  `error: Cannot find module '../../oauth/kiro-routing' from '.../src/server/responses/core.ts'`.
  `/healthz` did not answer, port 10100 was held by a `systemd-socket-`
  placeholder instead of the proxy process, and the restart counter reached 105.
- Impact: The VM proxy served no traffic between 02:55:54 and 03:09:24 KST
  (about 14 minutes). Requests from Codex App/CLI clients pointed at the VM
  would have failed for that window; there was no partial or degraded service.
- Timeline: At 02:55:39-41 KST the working-tree versions of
  `src/adapters/openai-responses.ts` and `src/server/responses/core.ts` were
  written into the globally installed `2.8.0-cs.26` package. The unit restarted
  at 02:55:53 and failed one second later, and it kept failing. Diagnosis first
  attributed the failure to a missing module; the unit was then stopped to end
  the loop, the checkout was fast-forwarded, and a consistent package was
  installed rather than another file-level patch.
- Evidence: Every file the hotfix wrote matched the local checkout byte-for-byte
  by SHA-256 (`core.ts` 153397 bytes `8785786c...`, `openai-responses.ts` 57332
  bytes `5b3d6b9e...`, `sse-payload-rewrite.ts` 7507 bytes `137e1c63...`,
  `request-log.ts` 46909 bytes `56685f0c...`, `xai-custom-tool-compat.ts` 10273
  bytes `720061b0...`). An import scan of the 409-file installed `src` tree found
  exactly one unresolved relative specifier, `../../oauth/kiro-routing`, which
  enters the repository at commit `9bc5becee`, after the `2.8.0-cs.26` tag.
  Adding only that module was not sufficient: a
  `bun build src/cli/index.ts --target=bun` link check then failed with
  `No matching export in "src/oauth/index.ts" for import "getValidAccessTokenSnapshotForAccount"`
  and `No matching export in "src/codex/pool-rotation.ts" for import "POOL_KEY_KIRO"`.
- Cause: Hotfixes on this VM copy individual files from the source checkout into
  the globally installed package. The copied files belong to commit `546fbd805`,
  whose base already carries the `cs.27`-`cs.30` Kiro routing refactor, so they
  import modules and exports that an installed `2.8.0-cs.26` tree does not have.
  Because the replaced `core.ts` is a startup path, every restart failed
  identically instead of recovering.
- Response: Stopped the unit, preserved the mixed install as
  `~/.opencodex-backup/vm-ocx-mix-20260916.tgz`, fast-forwarded the VM checkout to
  `546fbd805` (equal to `origin/main`), installed the published
  `@coseung2/opencodex@2.8.0-cs.30`, and overlaid the five runtime files that
  `546fbd805` changed, verifying each against the checkout by SHA-256. A link
  check over the installed tree bundled 710 modules with no unresolved imports or
  exports.
- Recovery verification: The unit reports `active/running`, `NRestarts=0`, and
  PID 2826910. `http://127.0.0.1:10100/healthz` and
  `https://ocx.aura-board.com/healthz` both return 200 for version `2.8.0-cs.30`
  and that PID. An authenticated `GET /v1/models` returned 200, and
  `POST /v1/responses` for `xai/grok-4.6` returned 200 with `OCX_VM_OK` from
  `grok-4.6-build`, which exercises the path the earlier hotfix targeted. No
  credentials, tokens, or request bodies are recorded here.
- Outstanding: The install reports `2.8.0-cs.30` while carrying the five runtime
  files of unreleased commit `546fbd805`. A plain reinstall, or the next
  release-based deploy, drops them unless that commit is published in a version.
- Prevention: Treat a hotfix as an indivisible dependency closure — when the
  source base is ahead of the installed version, ship a complete package instead
  of copying files onto an older tree — and run a
  `bun build src/cli/index.ts --target=bun` link check against the installed tree
  before restarting the unit. Publishing the pending fix removes the
  version/runtime mismatch.
