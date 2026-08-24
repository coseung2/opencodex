---
title: Windows Memory Growth
description: Why the bun process can grow to many gigabytes of RAM on Windows, what Bun 1.4 changes, and how opencodex observes and bounds it.
---

Some Windows users see the `bun` process behind opencodex grow to many
gigabytes of RSS during long streaming sessions (reported as issue
[#314](https://github.com/lidge-jun/opencodex/issues/314)). This page explains
what is actually happening and what you can do about it, honestly.

## Root cause: upstream Bun runtime issues

opencodex bundles the Bun runtime (currently **1.4.0**). The historical memory growth was
driven by known upstream Bun issues, not by JavaScript-level leaks in the
proxy:

| Bun issue | State (checked 2026-08-24) |
|---|---|
| [#28035](https://github.com/oven-sh/bun/issues/28035) — `fetch()` receive backpressure not coupled to JS consumption | Fixed by [PR #29831](https://github.com/oven-sh/bun/pull/29831), merged before Bun 1.4.0; production workloads still need observation |
| [#32111](https://github.com/oven-sh/bun/issues/32111) — crash when a client aborts an async-pull stream | Fixed by [PR #32120](https://github.com/oven-sh/bun/pull/32120). Bun 1.4.0 carries the fix, so the Windows `auto` gate now permits the bounded relay. The original crash was **not Windows-specific** |
| [PR #31654](https://github.com/oven-sh/bun/pull/31654) — `node:net` socket handle leak | Still **open** upstream |

Older Bun 1.3.14 installations must keep streaming responses on the conservative
path to avoid #32111. The bundled Bun 1.4.0 runtime instead enables the bounded
single-reader relay automatically on Windows. Memory remains observable because
runtime and application retention can still vary by workload.

## What opencodex does today

Bun 1.4.0 enables the safer Windows stream path, while bounded mitigation and
visibility remain in place; this is not a claim that every memory-growth workload is fixed:

- **Memory watchdog** — the proxy samples its own memory every minute and logs a
  rate-limited warning when observed memory crosses 4 GiB. Observed memory is
  the largest of RSS, `external`, and `arrayBuffers` (not their sum), because
  Windows working-set/RSS counters can under-report committed external
  retention. On Windows, when that same observed counter reaches 2 GiB, the
  watchdog also makes one synchronous `Bun.gc(true)` attempt per pressure
  episode, but only while the active-turn count is zero. If pressure is first
  seen during a request, the attempt waits until the final active turn releases;
  it is not run on every turn. The path is disabled when `Bun.gc` is unavailable
  and is not used on macOS or Linux. This is a reclamation hint, not a promise
  that Bun will return every native page to the OS.
- **`ocx doctor`** — a "Memory / runtime" section shows the *service*
  process's Bun version, RSS, external/ArrayBuffers counters, JS-heap context,
  and stream-mode decision. `heapUsed` / `jscHeap` alone are not a leak
  discriminator; compare observed memory with
  `responseState` and repeated samples before assigning an app-level leak.
- **`GET /api/system/memory`** — the same data over the authenticated
  management API for dashboards or scripts. Alongside RSS/heap/external counters
  it reports a scalar `responseState` block (entry count, total/largest
  serialized bytes, oldest-entry age) for the proxy's in-memory
  `previous_response_id` continuation store. This further attributes growth: a
  rising `responseState.totalBytes` under rising observed memory points at
  conversation retention (long `store:false` chains re-expanding each turn),
  whereas a flat `responseState` under rising observed memory points away from
  that store. The values are scalar-only — no request bodies, tokens, paths, or
  account identifiers — and the read is side-effect free (it never prunes or
  evicts). The dashboard's **Memory observability** card renders the
  same fields and offers a confirm-gated **Drain & restart** action: it shows
  the current active-turn count, waits up to 60s for active turns (reusing
  the existing 503 + `Retry-After` drain), then aborts any remaining turns and
  restarts the proxy via `ocx start` on the live port (or a failure-only
  service supervisor respawn) without tearing down Codex injection. That is a
  longer, informed recycle than the short drain on `POST /api/stop`.
- **A gated alternative stream path** — a bounded single-reader relay that
  removes the unbounded buffering shape entirely. On Windows it becomes the
  default automatically on the bundled Bun 1.4.0 runtime, which carries the
  #32111 fix. On macOS it stays opt-in
  even after such a release — flipping macOS `auto` is a separate decision.

One Windows Bun 1.3.14 reproduction reached roughly 2.0–2.22 GiB in
`external`/`arrayBuffers`, with RSS near 1.92 GiB and about 68 MiB of retained
app-owned state. After the turns became idle, the next GC cycle reduced RSS to
about 334 MiB. That evidence supports the conditional idle GC as a mitigation,
but it does not prove that Bun's upstream retention issue is fixed for every
workload.

Threshold-based auto-restart is deliberately **not** shipped. If the process
crashes, the service managers (Task Scheduler/WinSW, launchd, systemd) already
restart it.

## Your options

1. **Use the bundled Bun 1.4.0 runtime.** Its safer stream path turns on
   automatically on Windows. macOS keeps requiring the explicit opt-in below.

2. **Run a Bun runtime you trust with `OPENCODEX_BUN_PATH`.** This is
   unvalidated territory — you are running opencodex on a runtime we have not
   tested; at your own risk. Important for service installs: the override is
   read **when the service artifact is generated**, not at service start. Set
   the environment variable, then re-run `ocx service install` from that same
   shell so the path is baked into the durable service definition. Setting
   the env alone does nothing for an already-installed service.

3. **Opt into the bounded relay with `streamMode: "eager-relay"`.** Two ways:
   edit `config.json` (add `"streamMode": "eager-relay"`), or call the
   management API — a `PUT /api/settings` with `{"streamMode":"eager-relay"}`
   applies to new turns without a restart. **Legacy runtime warning:** on Bun
   1.3.14 this uses the stream shape affected by #32111, which can crash the
   process mid-stream (on any OS, not just Windows). The service manager will
   restart it, but in-flight requests fail. `"legacy-tee"` pins the conservative
   path. On Windows Bun 1.4.0, `"auto"` (default) selects the bounded relay. On
   macOS, `"auto"` always stays on tee; explicit `"eager-relay"` is the opt-in.

If you try any of these on a real Windows workload, please report the before
and after `ocx doctor` memory sections on
[#314](https://github.com/lidge-jun/opencodex/issues/314) — that is exactly
the verification this mitigation is waiting on.
