---
title: Response continuation storage
description: How the local continuation cache is persisted and how OpenCodex limits repeated snapshot writes.
---

OpenCodex keeps a bounded local continuation cache so requests using `previous_response_id` can resume after a proxy restart. Some adapters, including Kiro, need this cache even when a client requests `store: false`, because their upstream protocol needs replayed history.

## Snapshot write frequency

The cache snapshot is stored in `responses-state.json` inside the OpenCodex state directory (`~/.opencodex` by default, or `OPENCODEX_HOME`). Small snapshots use a two-second write debounce. Larger snapshots use a size-scaled delay capped at 30 seconds to avoid repeatedly replacing a large file during active conversations.

A background pass makes one write attempt. If the state changes while that attempt is running, another bounded pass is scheduled instead of immediately rewriting the full snapshot several times. Normal shutdown still awaits the existing bounded flush; the debounce is not a reason to leave shutdown work on a timer.

Abrupt termination can lose continuation changes which have not reached disk. A longer debounce trades that recovery window for fewer writes; it does not make the cache a durable conversation archive.

## Unchanged snapshots

Changes to in-memory state do not always change the bounded selection written to the snapshot. OpenCodex skips an identical replacement only after validating the actual file contents and destination. Deleted files and external edits are rewritten rather than being mistaken for a cache hit. The memo retains only a digest, byte count and destination, not another full snapshot in memory.

A skipped replacement does not bypass file-protection requirements. Symlink leaves, changed destinations and files whose protection needs repair are not accepted merely because their bytes match.

## Troubleshooting

Do not edit or remove continuation snapshots or spill files while a proxy is serving a task. A missing or unreadable continuation may require the client to resend its full input. Use the dashboard memory diagnostics for retained-state observations, and allow an ordinary stop to finish when preserving recent continuation state matters.

The snapshot, spill files and usage logs serve different purposes. Removing a snapshot is not a general-purpose fix for high process memory or large usage logs.
