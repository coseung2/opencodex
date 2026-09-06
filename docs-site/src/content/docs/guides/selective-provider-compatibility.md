---
title: Provider compatibility in this fork
description: Targeted protocol compatibility updates without replacing the fork's runtime or user settings.
---

## OpenCode Muse Spark

The `opencode-go` preset routes `muse-spark-1.2-contributor` and `muse-spark-1.3-contributor` through Responses. Both have explicit text/image input metadata and a 1,048,576-token context window. User-defined lower context windows remain authoritative. Older persisted providers receive missing per-model metadata without losing existing overrides or explicit empty reasoning ladders.

OpenCode's Muse Responses gateway does not accept `search_content_types` and `indexed_web_access` on plain `web_search` tools. The proxy removes only those fields on the canonical Go/Zen Responses destinations. `web_search_preview`, sibling models and custom destinations retain their own contracts.

Some Muse tool calls echo a namespaced tool as `default.apply_patch` instead of `default__apply_patch`. The client-facing response restores the declared namespace and name only when the spelling has a single unambiguous owner. Collisions with another dotted alias or a flat tool name do not select a tool by declaration order. Unknown names are not guessed. Streaming item events and terminal snapshots use the same restoration; local continuation history keeps the original upstream names.

The existing `x-opencode-session` affinity remains runtime-only and stable for a conversation. Explicit session headers are preserved. These changes do not add the Meta direct API, Muse Code OAuth or a Command Code-specific reasoning ladder.

## Scope

This fork retains its current runtime, management UI, Notch companion and release identity. Provider compatibility patches do not imply that the entire upstream release was merged. No live provider credential is required for the regression suite; live account availability and vendor-side behavior may still differ from the pinned, fixture-tested contract.
