---
title: Prompt cache retention
description: Separate upstream prompt caches from local conversation retention.
---

Prompt caching reuses upstream prefix computation. Stored history, a conversation ID,
and a local response replay TTL do not retain the upstream KV cache after eviction.
OpenCodex cannot guarantee indefinite reuse across every provider.

## Routed Anthropic requests

The shared adapter dispatcher requests one-hour ephemeral caching for Anthropic OAuth
when no explicit retention policy is supplied, including Responses ingress. An explicit
`cacheRetention` of `none`, `short`, or `long` wins. API-key routes default to short.
Native Anthropic passthrough preserves the caller's request instead of rewriting it.
A requested TTL is not proof of a hit; read the upstream cache usage fields.

## Other endpoints

Do not apply public API TTL contracts to ChatGPT/Codex native, Kiro, Antigravity,
OpenCode Go/Free, or another gateway merely because it serves the same model.
OpenCodex does not generate Anthropic TTL controls for those adapters. Unknown support
is not equivalent to a disabled cache: an upstream can cache implicitly.

- OpenAI public API supports model-specific retention controls. Native ChatGPT routing
  has a separate, unverified retention contract.
- Public xAI supports affinity and implicit caching, not a guaranteed eviction-free lease.
- Gemini public explicit cache resources can have their expiration updated; that lifecycle
  is distinct from Antigravity session and thought-signature replay.
- OpenRouter depends on its serving provider. Routing stickiness is not prompt-cache TTL.

## Claude Code cache panel (pending deployment)

The Claude → Code workspace includes a **Cache hits & TTL** section. Its authenticated
`GET /api/claude-code/cache` reads recent Claude Code usage without exposing prompts or
credentials. It shows the latest reported read/write tokens, a read ratio only when
inclusive input semantics are known, and the configured adapter retention request.
Legacy rows without field-presence metadata remain unreported, even if a compatibility
response contains zero. A reported zero does not establish TTL expiration. The panel
has no countdown because an upstream expiry timestamp is generally unavailable.
Observations older than one hour are labeled old; that freshness threshold is not a cache TTL.

## Measurement

Keep account, model, tools and the historical prefix stable when comparing requests.
Use actual upstream cache-read tokens, distinguishing cache writes from reads and
missing telemetry from an explicit zero. Kiro's opt-in provider diagnostics report
`cache_telemetry` booleans for usage/read/write field presence; they contain no prompt,
credential or account identity. These diagnostics do not fabricate cache metrics.

Periodic generation to keep a cache warm is not enabled. Even a short output can incur
cached input, suffix, reasoning, output and quota costs. A real eviction can require a
new prefill; reducing semantic history has a separate fidelity trade-off.
