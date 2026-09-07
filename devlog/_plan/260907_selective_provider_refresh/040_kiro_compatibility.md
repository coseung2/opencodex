# Stage 04 — Kiro compatibility and bounded translation

Applied the runtime/test changes from `831283d06`, `eeef7a32a`, `21f7f88a0`, `db040e70f`, `f392e02eb` and `a0d1ebbe4`, with the focused text-control tests from `524a294f8` and `314d41d8a`.

The three-way documentation conflict contained unrelated later upstream sections. Only the parallel-hint contract was retained; the existing fork commentary/image replay documentation remains intact. Test import conflicts were resolved by retaining both fork routing assertions and the actual Responses parser tests.

## Result

- Unicode instruction, tool-description, thinking carry and compaction truncation do not split surrogate pairs.
- Non-streaming Kiro event collection charges the existing translator budget incrementally; early termination closes delegated generators, open calls and partial thinking buffers.
- Composed schema property names are treated as data rather than schema keywords.
- A permissive client parallel hint is accepted without advertising a capability or inventing a wire field. The fork's explicit serialized Kiro preset is unchanged.
- Ordinary text controls are accepted but not forwarded; actual schema-constrained output is rejected.

## Gates

`bun run test` via the bundled Bun 1.4 executable on Kiro adapter/stream/images, compaction, translator budget and response state: **290 pass / 0 fail**. Root typecheck passed. Staged privacy scan passed after correcting a prior-stage synthetic URL fixture (separate `815089994` test-only commit, no detector bypass). Docs frozen install/build passed: **221 pages**.

The prior Muse scan ran before its new file was staged; the staged scan subsequently caught a synthetic credentialed URL as an email. The fixture now constructs that URL through the URL API. It still tests rejection of a credential-bearing destination without including a detector-shaped vendor email in source.

Full integrated and platform-specific verification remains stage 09. No live Kiro account was used.
