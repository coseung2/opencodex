---
title: Claude Code conversation continuity
description: Keep routed Claude Code tasks and reasoning controls working across turns.
---

Models appearing in the picker does not by itself confirm that their reasoning controls or tool workflows work. After changing an OpenCodex connection, check both a short conversation and a task that reads a file and continues after the tool result.

## Reasoning controls

Routed picker rows use an existing native menu that overlaps the selected model's supported reasoning levels. A model without supported levels does not receive a fabricated reasoning menu. The CLI's served `cc` catalog and fallback bootstrap options are separate from Desktop's `ccd` and `code` catalogs.

If a menu remains stale, start a new Claude Code session and refresh its model catalog. A cached CLI catalog can survive an app restart; do not treat the old picker as proof that the running proxy has the new configuration.

## Continuing after tools and skills

First-party Claude can send a message-thread continuation containing only the new tool result, leaving earlier instructions and messages on Anthropic's server. A translated route returns Claude's `thread_unsupported_request` code so the client resends the complete conversation instead of silently starting a new task. Token counting uses the same negotiation. Genuine native Anthropic conversations keep their thread state unchanged.

OpenCodex preserves loaded-tool names returned by ToolSearch. Translating a function tool also preserves whether its parameters are optional instead of implicitly enabling strict schemas.

The dedicated Notch companion negotiates routed message-thread fallback locally before uploading a continuation and sends bounded, length-delimited relay bodies. This avoids turning an early protocol refusal into a connection failure. Native Anthropic conversations remain native.

Kiro terminal-tool answers stream incrementally as their answer string arrives. Ordinary progress remains staged until it can be classified; final completion and malformed JSON are still validated, and partial visible answers are not automatically replayed after an error.

The companion routes Claude Code's specifically identified built-in WebSearch helper to the operator-selected native `gpt-6-luna` OpenAI model. It preserves hosted search selectors and source lists, without forwarding Anthropic subscription credentials. Luna need not be listed as a main-session picker option: dedicated helpers use the explicit route under the current connection binding. This is separate from OCX's general web-search sidecar (OpenAI by default, Anthropic only when explicitly configured).

Tool-free native Haiku WebFetch analysis, JSON session-title generation and completed-tool summary labels also use Luna when their dedicated prompt shapes match. The fetch itself and its permissions stay owned by Claude. Unrecognized or newly versioned helper shapes remain on their original path; this is not a blanket Haiku replacement. Safety classifiers, ordinary conversations and explicitly assigned subagents are preserved. Compaction and memory extraction have not been globally forced onto Luna.

By default, routed sessions omit the large `claude-api` reference bundle. The Skill tool receives a preventive guard, and a bundle that is still loaded receives an instruction to continue the original task, not restart with a greeting. Set `claudeCode.blockedSkills` to an empty array only if you intentionally want those bundles retained.

Responses models can carry hidden reasoning across Claude turns without showing it as conversation text. Replay is verified against the actual destination, wire model and outgoing authentication. Switching destinations or credentials, or restarting the proxy, safely discards that opaque state; visible conversation history remains available. Native Anthropic conversations do not receive another provider's opaque state.
