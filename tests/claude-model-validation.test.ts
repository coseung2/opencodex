import { expect, test } from "bun:test";
import { isClaudeModelValidationProbe } from "../src/claude/model-validation";
import { collectAnthropicMessage } from "../src/claude/outbound";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const probe = { model: "claude-opus-4-8-fixture", max_tokens: 1,
  messages: [{ role: "user", content: [{ type: "text", text: "Hi", cache_control: { type: "ephemeral" } }] }] };
const frame = (event: string, data: unknown) => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const start = frame("content_block_start", { content_block: { type: "text", text: "" } });
const delta = frame("content_block_delta", { delta: { type: "text_delta", text: "Hello" } });

test("model validation recognizes the exact one-token side query, never normal/tool/thinking turns", () => {
  expect(isClaudeModelValidationProbe(probe)).toBe(true);
  expect(isClaudeModelValidationProbe({ ...probe, stream: false, system: [{ type: "text", text: "attribution" }], metadata: {} })).toBe(true);
  for (const changed of [{ max_tokens: 2 }, { stream: true }, { thinking: { type: "enabled" } }, { tools: [{}] }, { tool_choice: "auto" }, { messages: [] },
    { messages: [{ role: "user", content: "Hi" }] },
    { messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] },
    { messages: [{ role: "user", content: [{ type: "text", text: "real task", cache_control: { type: "ephemeral" } }] }] }]) {
    expect(isClaudeModelValidationProbe({ ...probe, ...changed })).toBe(false);
  }
});

test("a real provider text delta answers the probe and cancels an otherwise unfinished stream", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(frame("message_start", { message: { usage: { input_tokens: 12, output_tokens: 0 } } }));
    controller.enqueue(start); controller.enqueue(delta);
  }, cancel() { cancelled = true; } });
  const budget = createTestTranslatorBudget();
  try {
    const message = await collectAnthropicMessage(stream, probe.model, budget, { modelValidationProbe: true });
    expect(message).toMatchObject({ type: "message", content: [{ type: "text", text: "H" }], stop_reason: "max_tokens", usage: { input_tokens: 12, output_tokens: 1 } });
    expect(cancelled).toBe(true);
  } finally { budget.dispose(); }
}, 1000);

test("headers and message_start alone do not confirm a model or hide a provider error", async () => {
  const failure = { type: "error", error: { type: "api_error", message: "fixture denied" } };
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(frame("message_start", { message: { content: [] } }));
    controller.enqueue(start);
    controller.enqueue(frame("error", failure)); controller.close();
  } });
  const budget = createTestTranslatorBudget();
  try { expect(await collectAnthropicMessage(stream, probe.model, budget, { modelValidationProbe: true })).toEqual(failure); }
  finally { budget.dispose(); }
});

test("ordinary nonstream requests still collect the entire answer", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(start); controller.enqueue(delta);
    controller.enqueue(frame("content_block_delta", { delta: { type: "text_delta", text: " world" } }));
    controller.enqueue(frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }));
    controller.close();
  }, cancel() { cancelled = true; } });
  const budget = createTestTranslatorBudget();
  try {
    const message = await collectAnthropicMessage(stream, probe.model, budget);
    expect(message).toMatchObject({ content: [{ type: "text", text: "Hello world" }], stop_reason: "end_turn", usage: { output_tokens: 2 } });
    expect(cancelled).toBe(false);
  } finally { budget.dispose(); }
});
