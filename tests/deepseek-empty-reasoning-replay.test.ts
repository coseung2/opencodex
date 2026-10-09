import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { anthropicToResponsesBody } from "../src/claude/inbound";
import { parseRequest } from "../src/responses/parser";
import { encodeReasoningEnvelope } from "../src/responses/reasoning-envelope";
import type { OcxProviderConfig } from "../src/types";

const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  apiKey: "test-key",
  preserveReasoningContentModels: ["deepseek-v4.1-flash"],
};

function wireMessages(messages: unknown[], preserve = true): Record<string, unknown>[] {
  const parsed = parseRequest(anthropicToResponsesBody({
    model: "deepseek-v4.1-flash", messages, max_tokens: 1024,
  }));
  const request = createOpenAIChatAdapter({
    ...provider, preserveReasoningContentModels: preserve ? provider.preserveReasoningContentModels : [],
  }).buildRequest(parsed);
  return JSON.parse(request.body as string).messages;
}

const call = (id: string) => ({ type: "tool_use", id, name: "probe", input: {} });
const result = (id: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "OK" }] });

describe("DeepSeek empty reasoning replay", () => {
  test("keeps an explicit empty field on a tool-only continuation after real thinking", () => {
    const messages = wireMessages([
      { role: "user", content: "Continue using tools." },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Original reasoning.", signature: encodeReasoningEnvelope({ txt: "Original reasoning." }) }, call("first"),
      ] },
      result("first"),
      { role: "assistant", content: [call("second")] },
      result("second"),
    ]).filter(m => m.role === "assistant");
    expect(messages).toHaveLength(2);
    expect(messages[0]!.reasoning_content).toBe("Original reasoning.");
    expect(messages[1]!.reasoning_content).toBe("");
    expect(messages[1]!.tool_calls).toHaveLength(1);
  });

  test("repairs orphan tool results without inventing reasoning", () => {
    const assistant = wireMessages([result("orphan")]).find(m => m.role === "assistant");
    expect(assistant!.reasoning_content).toBe("");
    expect(assistant!.tool_calls).toHaveLength(1);
  });

  test("does not add the field to models outside the preservation policy", () => {
    const assistant = wireMessages([
      { role: "assistant", content: [call("plain")] }, result("plain"),
    ], false).find(m => m.role === "assistant");
    expect(assistant).not.toHaveProperty("reasoning_content");
  });

  test("does not turn empty assistant messages into phantom turns", () => {
    expect(wireMessages([
      { role: "user", content: "Hello" }, { role: "assistant", content: [] },
    ]).filter(m => m.role === "assistant")).toHaveLength(0);
  });
});
