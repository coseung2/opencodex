# OpenCode Go DeepSeek V4.1 reasoning replay failure

- Date/timezone: 2026-09-15, Asia/Seoul (UTC+09:00).
- Status: recovered in production on `2.8.0-cs.30`.

## Symptoms and impact

An OpenCode Go conversation using `deepseek-v4.1-flash` failed on a follow-up tool turn with HTTP 400 and `The reasoning_content in the thinking mode must be passed back to the API`. The first model response could succeed, but the conversation could not continue after a tool call.

## Evidence and cause

OpenCode Go exposes the model as `deepseek-v4.1-flash`. The provider registry preserved `reasoning_content` for `deepseek-v4-flash` and `deepseek-v4-pro`, but the V4.1 model ID was absent from that list and its related reasoning metadata. The response parser therefore received the model's reasoning but omitted it when constructing the next assistant tool-call message. Console Go requires the original reasoning content in thinking mode and rejected that follow-up request.

## Response and recovery checks

The OpenCode Go registry now applies the DeepSeek thinking contract to `deepseek-v4.1-flash`: reasoning-content replay, supported effort mapping, text-only input, and the one-million-token context window. The direct DeepSeek provider remains unchanged because this identifier belongs to OpenCode Go.

Focused OpenCode Go and registry tests, type checking, privacy scanning, `git diff --check`, and the full 511-file test suite passed. Release `2.8.0-cs.30` passed cross-platform CI and was deployed to production. Both the loopback and public health endpoints reported `status: ok` and version `2.8.0-cs.30`. A real `opencode-go/deepseek-v4.1-flash` request produced reasoning plus a function call, and the follow-up carrying the function result returned HTTP 200 with a `completed` terminal and reasoning. The provider no longer rejected the continuation for missing `reasoning_content`.

## Follow-up

When OpenCode Go introduces a versioned DeepSeek thinking model ID, add it to the provider-specific thinking model set and exercise a tool-call continuation in the registry regression test.
