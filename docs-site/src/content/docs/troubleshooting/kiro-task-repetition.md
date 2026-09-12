---
title: Kiro repeats completed work
description: Distinguish missing code-mode output from lost conversation state and diagnose repeated tool calls.
---

Repeated work is not by itself evidence that Kiro lost the conversation. In Codex code mode, the outer `exec` tool evaluates JavaScript, and a bare `await` or final expression does not print its result. The model can therefore see an empty tool response even though the command ran successfully.

## Empty code-mode output

When a value is needed for the next step, print it in the same cell:

```js
text(JSON.stringify(await tools.exec_command({ cmd: "ls" })));
```

Do not rerun an edit, deployment, or other side-effecting operation solely because the output was empty. Inspect existing state first. If a command returns a `session_id`, poll that session rather than start the command again.

OpenCodex supplies this contract before a verified code-mode call and explains empty output on its Kiro continuation. It combines adjacent outputs from the same original call before adding one explanation. A failed wrapper or an error result remains a failure; image output is not treated as a missing print. Unrelated MCP tools and structured tools merely named `exec` do not receive JavaScript-isolate instructions.

Known code-mode host errors, such as passing an object instead of a string to `tools.apply_patch` or importing a module, receive a short recovery hint. The original error text and status are retained. Successful output quoting an error message is left unchanged.

## Large tool catalogs

Kiro's client-tool catalog is bounded to 48 tools and 96,000 serialized bytes, with separate headroom for the private completion tool. When that budget is exceeded, tools returned by tool search take priority over ordinary declarations. OpenCodex reserves space for the freeform `exec` execution path, then the search gateway and remaining tools as space permits. The omission notice describes the actual emitted catalog. A single `exec` specification that cannot fit the byte budget fails explicitly instead of bypassing the limit.

Below the budget, declaration order is unchanged. Namespaced MCP shell tools do not disable the code-mode contract. No setting or account reauthentication is needed for this behavior.

## Completion and conversation state

Kiro's existing private completion channel still ends the turn. Progress text is not a final answer, and a delivered final answer must not reopen the task. Real user follow-ups continue normally. This correction does not discard tool history, change reasoning-blob replay, remove repeated calls solely because their arguments match, or introduce automatic command retries.

Assistant messages marked `phase: "commentary"` are preserved in the Kiro history. They can contain decisions, completed steps, rejected hypotheses, and the next unfinished action, so dropping them can make a later tool-result round look as if the task state was lost. The same history is used when a routed compaction turn creates its checkpoint summary, so preserving commentary also prevents those decisions from disappearing at compaction. Historical commentary is input context only; OpenCodex does not automatically stream it to the UI again, and Kiro is explicitly instructed not to repeat or paraphrase earlier progress updates.

The adapter tests reproduce missing-output guidance, catalog eviction, commentary loss, and compaction-context loss deterministically; they do not prove that every model-generated repetition has the same cause. If repetition persists after deploying the corrected build, distinguish whether the preceding output was empty, an error, a successful result, an already-delivered final answer, or a compaction boundary. Record the running version and sanitized request identifiers, not credentials or raw private prompts.

## Upstream references

The fork adaptation is based on [#2819: empty exec output and final-answer reopening](https://github.com/lidge-jun/opencodex/pull/2819), [#2475: tool-search result priority](https://github.com/lidge-jun/opencodex/pull/2475), and [#2750: code-mode discovery and execution-path reservation](https://github.com/lidge-jun/opencodex/pull/2750). The already-present completion fixes include [#3012](https://github.com/lidge-jun/opencodex/pull/3012), [#3031](https://github.com/lidge-jun/opencodex/pull/3031), and the adjacent-result ownership fix [#3750](https://github.com/lidge-jun/opencodex/pull/3750).
