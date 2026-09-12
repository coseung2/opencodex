# Kiro task repetition: continuity gaps

Date: 2026-09-12 (Asia/Seoul).

## Scope and baseline

Work is against the user fork `coseung2/opencodex`, based on `main` at `6aec2590b`
(`2.8.0-cs.20`). Its actual GitHub parent is `lidge-jun/opencodex`; upstream `dev` was
inspected at `7a0513c2f`. This is a scoped adaptation, not an upstream merge. Existing fork
image retirement, reasoning replay, and terminal behavior must survive.

## Upstream comparison

| Evidence | Existing fork status | Decision |
| --- | --- | --- |
| Upstream #2819, merged 2026-08-28, `d7a82a8fc42632760750a160c9811543b18bd76d` | Delivered-final local terminal and phase-absent hash record were present (`03c87a698`); empty exec repair and proactive echo contract were absent. | Adapt only the missing code-mode behavior. |
| #2475, merged 2026-08-25, `09062014ed4ff9ff2e200b8ce8970a4e22a4f4a1` | Catalog retained a declaration-order prefix, even when discovered tools arrived later. | Prioritize loaded search results when over budget. |
| #2750, merged 2026-08-27, `eeb774026d077cec6c91217c1f097afa92856ead` | No code-mode discovery contract or execution-path reservation. | Reserve bare freeform exec and derive the contract from the emitted catalog. |
| Host-error follow-up `163378050d75bda4bc6eb0821da9382e5a80c67a` | No host-specific recovery hint. | Add one idempotent hint for leading error context, preserving original output and status. |
| #2835 / #3012 / #3031 | Superseded prose, terminal completion, and blocking-question completion already present (`e2b2d453c`, `4ca112156`, `0055bdb7a`). | Preserve; do not reapply or weaken. |
| #3750 / issues #3734 and #3731 | Original-id adjacent result grouping already present (`7445490e2`). | Normalize after that grouping; never merge across a user/assistant barrier. |
| #543 / reasoning round-trip | Mid-turn user steering and redacted reasoning pairing already covered. | Preserve existing tests and ownership. |
| Fork-only `037a30984` (`fix(kiro): stop replaying progress commentary`) | The fork blanked every assistant `phase: "commentary"` before rebuilding Kiro history. Current upstream preserves assistant text. The same fork commit already added an explicit instruction not to repeat/paraphrase old progress. | Reverse only the commentary deletion; retain the anti-repeat instruction and stream phasing. |

## Findings and confidence

The fork sent `The tool completed without textual output.` for a successful freeform exec
cell that omitted `text()`/`notify()`. It also passed nonblank-but-empty wrapper text through.
No pre-call instruction explained why a bare await produces no visible result. Upstream #2819
reports models interpreting this as lost context and restarting completed work. The missing
wire contract is reproduced here, but the reported live session was not captured, so this is
not proof that every instance of the user's repetition has that cause.

A second deterministic failure was independent of generation: with 48 filler declarations,
exec or tools loaded by search disappeared from the outbound catalog. A model could repeatedly
search for, or avoid, the execution path it actually needed. Under the new policy, the original
order is preserved below budget; over budget, discoveries outrank filler and exec has a reserved
slot and bytes. Unlike a blind reservation, a single oversized exec fails rather than bypassing
the 96,000-byte limit.

A third deterministic continuity failure was fork-specific. Commit `037a30984` classified Responses
`phase: "commentary"` as disposable UI prose and blanked it before rebuilding Kiro history. That
also removed substantive progress such as decisions, completed steps, rejected hypotheses, and next
actions. Tool calls/results survived, but the model could see what happened without the explanation
of why it happened or what remained. Current upstream preserves this assistant text. The deletion
was especially damaging at compaction boundaries: routed compaction summarizes the same rebuilt
provider history, so omitted commentary could not enter the checkpoint summary and was then lost
from replacement history. The fix preserves commentary as provider input memory while retaining the
existing instruction that forbids repeating/paraphrasing earlier progress; historical input is not
emitted by the response stream parser.

Known host errors can similarly encourage repeated invalid calls. Only verified code-mode calls
receive a recovery hint. Structured tools named exec, unrelated MCP namespaces, successful output
quoting a diagnostic, error status, images (including retired replay images), and nonempty
notification order remain protected by tests. The proxy does not execute or retry any command.

## Validation

- Wrote failing payload regressions before implementation. Empty-output guidance and catalog
  preservation failed against the baseline; fixtures for optional tools/images were corrected
  before the final run. Commentary-preservation regressions were then written against the PR branch:
  four tests failed exactly on blanked tool-round commentary, dropped commentary-only turns, and
  missing compaction-summary context before the deletion logic was reversed.
- Focused Kiro adapter, stream, reasoning round-trip, public-server completion, catalog-nudge,
  Responses parser/compaction, and continuity coverage after the commentary fix: **264 pass, 0 fail,
  883 assertions** across eight files. The narrower commentary/tool-round/compaction regressions are
  **138 pass, 0 fail, 391 assertions** across two files.
- `bun run typecheck`: passed with the pinned Bun 1.4.0 installation.
- Frozen root dependency installation: passed without lockfile changes.
- Documentation frozen install/build: passed, 231 pages. English and Korean troubleshooting
  pages explain the behavior and its limits.
- Initial repository-wide run: **7,309 pass, 11 skip, 8 fail (including 5 module-load errors)**
  across 508 files. This was not a green full-suite run.
- A module-load-only pass isolated all five loading errors to missing React dependencies in the
  new worktree's GUI package. Frozen GUI dependency installation changed no lockfile. The five
  affected suites plus repository hygiene then passed: **96 pass, 0 fail, 366 assertions**.
- The remaining three `shutdown-launcher` cases (SIGINT/SIGTERM/SIGHUP) were rerun on a separate,
  unmodified worktree at baseline `6aec2590b`: **0 pass, 3 fail**, all at the startup health check
  (`tests/shutdown-launcher.test.ts:94`), before signal handling. No unrelated launcher source fix
  is included. The full suite was not repeated after dependency installation.
- A repository-wide rerun after the commentary change was started but did not produce an aggregate:
  the Bun test process remained CPU-bound for 576 seconds and was interrupted rather than reported
  as green. The earlier baseline full-suite limitations and clean-main launcher reproduction above
  remain the only completed repository-wide comparison. No claim of a green full suite is made.
- Staged `bun run privacy:scan` and `git diff --check`: passed. No dependency/lockfile changes.

No real Kiro account request, credential mutation, automatic deployment, or operational restart
was performed. A read-only health check reported the operational service as `2.8.0-cs.18`;
that version string alone does not establish which selectively copied modules are loaded.
The source correction and deployment status are deliberately separate.

## Structural follow-up

The continuity findings above exposed a layering problem as well as individual bugs: one monolithic
Kiro adapter owned task policy, wire mapping, auth/transport and event decoding. The follow-up plan
and implementation are documented in `devlog/_plan/260912_kiro_native_boundaries/000_plan.md`.
That refactor keeps this unit's behavior while separating continuity policy, bidirectional Kiro codec,
native transport, and the stable ProviderAdapter facade. Post-refactor focused coverage expands to
**357 pass, 0 fail, 1,206 assertions across 12 files**, including explicit architecture-boundary tests.
