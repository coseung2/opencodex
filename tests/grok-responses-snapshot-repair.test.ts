import { describe, expect, test } from "bun:test";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import { createGrokResponsesSparseTerminalPayloadRewrite } from "../src/server/grok-responses-snapshot-repair";
import { createXaiCustomToolPayloadRewrite } from "../src/responses/xai-custom-tool-compat";
import { composeSsePayloadRewrites } from "../src/server/sse-payload-rewrite";

function message(id: string, text: string, annotations?: unknown[]) {
  return {
    type: "message",
    id,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, ...(annotations ? { annotations } : {}) }],
  };
}

function event(type: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ type, ...extra });
}

describe("Grok sparse Responses terminal repair", () => {
  test("reconstructs an empty completed snapshot from contiguous validated done items", () => {
    const rewrite = createGrokResponsesSparseTerminalPayloadRewrite();
    const added = rewrite(event("response.output_item.added", {
      output_index: 0,
      item: { type: "message", id: "msg_1", status: "in_progress", role: "assistant", content: [] },
    }));
    const done = rewrite(event("response.output_item.done", { output_index: 0, item: message("msg_1", "answer") }));
    const terminal = rewrite(event("response.completed", {
      response: { id: "resp_1", status: "completed", model: "model", output: [] },
    }));

    expect(JSON.parse(added)).toMatchObject({ item: { id: "msg_1", status: "in_progress" } });
    // Grok's strict Responses decoder requires annotations even when an upstream omits them.
    expect(JSON.parse(done)).toMatchObject({ item: { content: [{ type: "output_text", text: "answer", annotations: [] }] } });
    expect(JSON.parse(terminal)).toMatchObject({
      response: { output: [{ type: "message", id: "msg_1", content: [{ text: "answer", annotations: [] }] }] },
    });
  });

  test("preserves a non-empty authoritative terminal output", () => {
    const rewrite = createGrokResponsesSparseTerminalPayloadRewrite();
    rewrite(event("response.output_item.done", { output_index: 0, item: message("msg_done", "done") }));
    const terminal = rewrite(event("response.completed", {
      response: { status: "completed", output: [message("msg_authoritative", "authoritative", [])] },
    }));
    expect(JSON.parse(terminal).response.output[0].id).toBe("msg_authoritative");
  });

  test("reconstructs a custom-tool-only terminal after xAI function-call restoration", () => {
    const rewrite = composeSsePayloadRewrites(
      createXaiCustomToolPayloadRewrite(new Set(["apply_patch"]))!,
      createGrokResponsesSparseTerminalPayloadRewrite(),
    );
    const call = { type: "function_call", id: "fc_patch", call_id: "call_patch", name: "apply_patch" };
    rewrite(event("response.output_item.added", {
      output_index: 0, item: { ...call, status: "in_progress", arguments: "" },
    }));
    rewrite(event("response.output_item.done", {
      output_index: 0,
      item: { ...call, status: "completed", arguments: JSON.stringify({ input: "patch content" }) },
    }));
    const terminal = JSON.parse(rewrite(event("response.completed", {
      response: { status: "completed", output: [] },
    })));
    expect(terminal.response.output).toEqual([{
      type: "custom_tool_call", id: "ctc_patch", call_id: "call_patch", name: "apply_patch",
      status: "completed", input: "patch content",
    }]);
  });

  test("fails closed on gaps, duplicates, and open/done identity mismatches", () => {
    const gap = createGrokResponsesSparseTerminalPayloadRewrite();
    gap(event("response.output_item.done", { output_index: 1, item: message("msg_2", "gap") }));
    const gapTerminal = JSON.parse(gap(event("response.completed", { response: { status: "completed", output: [] } })));
    expect(gapTerminal.response.output).toEqual([]);

    const duplicate = createGrokResponsesSparseTerminalPayloadRewrite();
    duplicate(event("response.output_item.done", { output_index: 0, item: message("msg_1", "one") }));
    duplicate(event("response.output_item.done", { output_index: 0, item: message("msg_1", "two") }));
    const duplicateTerminal = JSON.parse(duplicate(event("response.completed", { response: { status: "completed", output: [] } })));
    expect(duplicateTerminal.response.output).toEqual([]);

    const mismatch = createGrokResponsesSparseTerminalPayloadRewrite();
    mismatch(event("response.output_item.added", {
      output_index: 0,
      item: { type: "message", id: "msg_open", status: "in_progress", role: "assistant", content: [] },
    }));
    mismatch(event("response.output_item.done", { output_index: 0, item: message("msg_other", "answer") }));
    const mismatchTerminal = JSON.parse(mismatch(event("response.completed", { response: { status: "completed", output: [] } })));
    expect(mismatchTerminal.response.output).toEqual([]);
  });

  test("does not manufacture a terminal turn from reasoning-only output", () => {
    const rewrite = createGrokResponsesSparseTerminalPayloadRewrite();
    rewrite(event("response.output_item.done", {
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", status: "completed", summary: [{ type: "summary_text", text: "thinking" }] },
    }));
    const terminal = JSON.parse(rewrite(event("response.completed", { response: { status: "completed", output: [] } })));
    expect(terminal.response.output).toEqual([]);
  });

  test("backfills content-part annotations without changing unrelated payload fields", () => {
    const rewrite = createGrokResponsesSparseTerminalPayloadRewrite();
    const raw = event("response.content_part.added", {
      output_index: 0,
      content_index: 0,
      item_id: "msg_1",
      part: { type: "output_text", text: "", logprobs: null },
      sequence_number: 7,
    });
    expect(JSON.parse(rewrite(raw))).toEqual({
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      item_id: "msg_1",
      part: { type: "output_text", text: "", logprobs: null, annotations: [] },
      sequence_number: 7,
    });
  });

  test("dispose releases retained collector budget after client cancellation", () => {
    const budget = createTranslatorBudget();
    const rewrite = createGrokResponsesSparseTerminalPayloadRewrite(budget);
    rewrite(event("response.output_item.done", { output_index: 0, item: message("msg_1", "retained") }));
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
    rewrite.dispose?.();
    expect(budget.snapshot().currentBytes).toBe(0);
    budget.dispose();
  });
});
