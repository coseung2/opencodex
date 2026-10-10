---
title: Claude Code conversation continuity
description: Keep routed Claude Code tasks and reasoning controls working across turns.
---

Models appearing in the picker does not by itself confirm that their reasoning controls or tool workflows work. After changing an OpenCodex connection, check both a short conversation and a task that reads a file and continues after the tool result.

## Reasoning controls

Routed picker rows use an existing native menu that overlaps the selected model's supported reasoning levels. A model without supported levels does not receive a fabricated reasoning menu. The CLI's served `cc` catalog and fallback bootstrap options are separate from Desktop's `ccd` and `code` catalogs.

If a menu remains stale, start a new Claude Code session and refresh its model catalog. A cached CLI catalog can survive an app restart; do not treat the old picker as proof that the running proxy has the new configuration.

## Continuing after tools and skills

OpenCodex preserves loaded-tool names returned by ToolSearch. Translating a function tool also preserves whether its parameters are optional instead of implicitly enabling strict schemas.

By default, routed sessions omit the large `claude-api` reference bundle. The Skill tool receives a preventive guard, and a bundle that is still loaded receives an instruction to continue the original task, not restart with a greeting. Set `claudeCode.blockedSkills` to an empty array only if you intentionally want those bundles retained.

Responses models can carry hidden reasoning across Claude turns without showing it as conversation text. Replay is verified against the actual destination, wire model and outgoing authentication. Switching destinations or credentials, or restarting the proxy, safely discards that opaque state; visible conversation history remains available. Native Anthropic conversations do not receive another provider's opaque state.
