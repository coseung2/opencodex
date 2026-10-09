import { expect, test } from "bun:test";
import { anthropicToResponsesBody } from "../src/claude/inbound";
import { claudeCacheRetention } from "../src/claude/cache-retention";
import { parseRequest } from "../src/responses/parser";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { responsesJsonToAnthropicMessage, responsesSseToAnthropicSse, collectAnthropicMessage } from "../src/claude/outbound";
import { encodeReasoningEnvelope } from "../src/responses/reasoning-envelope";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../src/types";

const provider: OcxProviderConfig = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth", apiKey: "offline-fixture" };
const config = { providers: { anthropic: provider }, defaultProvider: "anthropic", port: 0 } as OcxConfig;
const signature = "c2lnbmVkX3RoaW5raW5nX2ZpeHR1cmU=";
const base = { model: "claude-opus-5-5", system: "Stable instructions", stream: true, messages: [{ role: "user", content: "hello" }, { role: "system", content: "remaining tokens: 100" }] };
const meta = () => ({ headers: new Headers({ authorization: "Bearer gateway-admission", "anthropic-beta": "extended-cache-ttl-2025-04-11" }), translatorBudget: createTestTranslatorBudget() });
const withoutMarkers = (v: unknown) => JSON.parse(JSON.stringify(v, (key, value) => key === "cache_control" ? undefined : value));

test("only standalone system token accounting is omitted, never user text or mixed/fenced instructions", () => {
  const footer = "<total_tokens>100 tokens left</total_tokens>";
  const body = anthropicToResponsesBody({ ...base, messages: [
    { role: "user", content: footer },
    { role: "system", content: footer },
    { role: "system", content: `<system-reminder>\n${footer}\n</system-reminder>` },
    { role: "system", content: `${footer}\nKeep the user's files.` },
    { role: "system", content: `\`\`\`xml\n${footer}\n\`\`\`` },
  ] });
  const input = body.input as Array<{ role: string; content: Array<{ text: string }> }>;
  expect(input.map(m => m.role)).toEqual(["user", "developer", "developer"]);
  expect(input[0]!.content[0]!.text).toBe(footer);
  expect(input[1]!.content[0]!.text).toContain("Keep the user's files.");
});

test("Claude append-only notices preserve instructions, cohort key and final Anthropic/Chat prefixes", async () => {
  const second = { ...base, messages: [...base.messages, { role: "assistant", content: "hi" }, { role: "user", content: "continue" }, { role: "system", content: "remaining tokens: 99" }] };
  const a = anthropicToResponsesBody(base), b = anthropicToResponsesBody(second);
  expect(b.instructions).toBe(a.instructions);
  expect(b.prompt_cache_key).toBe(a.prompt_cache_key);
  expect((b.input as unknown[]).slice(0, (a.input as unknown[]).length)).toEqual(a.input);
  for (const adapter of [createAnthropicAdapter(provider, "long"), createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "fixture" })]) {
    const first = JSON.parse((await adapter.buildRequest(parseRequest(a), meta())).body);
    const next = JSON.parse((await adapter.buildRequest(parseRequest(b), meta())).body);
    expect(next.system).toEqual(first.system);
    // Anthropic/API may coalesce adjacent user blocks; compare flattened ordered blocks.
    const flatten = (messages: any[]) => messages.flatMap(m => typeof m.content === "string" ? [{ role: m.role, type: "text", text: m.content }] : m.content.map((x: any) => ({ role: m.role, ...withoutMarkers(x) })));
    const oldBlocks = flatten(first.messages), nextBlocks = flatten(next.messages);
    expect(nextBlocks.slice(0, oldBlocks.length)).toEqual(oldBlocks);
  }
});

test("Anthropic subscription TTL is request-local and honors explicit lifetimes/config", async () => {
  expect(claudeCacheRetention(config, base)).toBe("long");
  expect(config.cacheRetention).toBeUndefined();
  expect(claudeCacheRetention({ ...config, cacheRetention: "none" }, base)).toBe("none");
  expect(claudeCacheRetention(config, { ...base, cache_control: { type: "ephemeral", ttl: "5m" } })).toBe("short");
  const apiConfig = { ...config, providers: { custom: { ...provider, authMode: "key" as const } } };
  const customBody = { ...base, model: "custom/claude-opus-5-5" };
  expect(claudeCacheRetention(apiConfig, customBody)).toBeUndefined();
  expect(claudeCacheRetention(apiConfig, { ...customBody, system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } }] })).toBe("long");
  expect(claudeCacheRetention({ ...config, providers: { custom: { ...provider, adapter: "openai-chat" } } }, customBody)).toBeUndefined();
  const built = await createAnthropicAdapter(provider, claudeCacheRetention(config, base)).buildRequest(parseRequest(anthropicToResponsesBody(base)), meta());
  expect(JSON.parse(built.body).cache_control.ttl).toBe("1h");
  expect(built.headers["anthropic-beta"]).toContain("extended-cache-ttl-2025-04-11");
  expect(built.headers.Authorization).toBe("Bearer offline-fixture");
  expect(JSON.stringify(built)).not.toContain("gateway-admission");
});

test("native signatures and redacted reasoning survive JSON replay into Anthropic", async () => {
  const output = responsesJsonToAnthropicMessage({ id: "r", output: [
    { type: "reasoning", summary: [], encrypted_content: encodeReasoningEnvelope({ red: ["redacted-a", "redacted-b"] }) },
    { type: "reasoning", summary: [{ text: "exact thought" }], encrypted_content: encodeReasoningEnvelope({ sig: signature }) },
    { type: "function_call", call_id: "tool_1", name: "Read", arguments: "{}" },
  ] }, base.model) as any;
  expect(output.content.slice(0, 3)).toEqual([{ type: "redacted_thinking", data: "redacted-a" }, { type: "redacted_thinking", data: "redacted-b" }, { type: "thinking", thinking: "exact thought", signature }]);
  const translated = anthropicToResponsesBody({ ...base, messages: [{ role: "user", content: "read" }, { role: "assistant", content: output.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "done" }] }] });
  const wire = JSON.parse((await createAnthropicAdapter(provider).buildRequest(parseRequest(translated), meta())).body);
  expect(wire.messages[1].content.slice(0, 3)).toEqual(output.content.slice(0, 3));
});

for (const hidden of [false, true]) for (const streamed of [false, true]) test(`ordered signed and redacted blocks round-trip (hidden=${hidden}, streamed=${streamed})`, async () => {
  const secondSignature = "c2Vjb25kLXNpZ25hdHVyZQ==";
  const events: AdapterEvent[] = [
    { type: "redacted_thinking", data: "red-before" },
    { type: "thinking_delta", thinking: "first thought" },
    { type: "thinking_signature", signature },
    { type: "thinking_delta", thinking: "second thought" },
    { type: "thinking_signature", signature: secondSignature },
    { type: "redacted_thinking", data: "red-after" },
    { type: "text_delta", text: "answer" },
    { type: "done", usage: { inputTokens: 10, outputTokens: 2 } },
  ];
  const budget = createTestTranslatorBudget();
  let message: any;
  if (streamed) {
    async function* source() { yield* events; }
    const upstream = bridgeToResponsesSSE(source(), base.model, undefined, undefined, undefined, undefined, 0, { hideThinkingSummary: hidden, translatorBudget: budget });
    message = await collectAnthropicMessage(responsesSseToAnthropicSse(upstream, base.model, { pingIntervalMs: 0, translatorBudget: budget }), base.model, budget);
  } else {
    message = responsesJsonToAnthropicMessage(buildResponseJSON(events, base.model, { hideThinkingSummary: hidden, translatorBudget: budget }), base.model);
  }
  const replay = parseRequest(anthropicToResponsesBody({ ...base, messages: [
    { role: "user", content: "hello" }, { role: "assistant", content: message.content }, { role: "user", content: "continue" },
  ] }));
  const wire = JSON.parse((await createAnthropicAdapter(provider).buildRequest(replay, meta())).body);
  expect(wire.messages[1].content).toEqual([
    { type: "redacted_thinking", data: "red-before" },
    { type: "thinking", thinking: "first thought", signature },
    { type: "thinking", thinking: "second thought", signature: secondSignature },
    { type: "redacted_thinking", data: "red-after" },
    { type: "text", text: "answer" },
  ]);
});

for (const hidden of [false, true]) test(`streamed signed thinking round-trips (hidden=${hidden})`, async () => {
  async function* events(): AsyncGenerator<AdapterEvent> {
    yield { type: "thinking_delta", thinking: "exact thought" };
    yield { type: "thinking_signature", signature };
    yield { type: "text_delta", text: "answer" };
    yield { type: "done", usage: { inputTokens: 10, outputTokens: 2 } };
  }
  const budget = createTestTranslatorBudget();
  const upstream = bridgeToResponsesSSE(events(), base.model, undefined, undefined, undefined, undefined, 0, { hideThinkingSummary: hidden, translatorBudget: budget });
  const converted = responsesSseToAnthropicSse(upstream, base.model, { pingIntervalMs: 0, translatorBudget: budget });
  const message = await collectAnthropicMessage(converted, base.model, budget) as any;
  const thought = message.content.find((x: any) => x.type === "thinking");
  if (hidden) {
    expect(thought.thinking).toBe("");
    expect(thought.signature).toStartWith("ocxr1:");
  } else expect(thought).toEqual({ type: "thinking", thinking: "exact thought", signature });
  const replay = parseRequest(anthropicToResponsesBody({ ...base, messages: [{ role: "user", content: "hello" }, { role: "assistant", content: message.content }, { role: "user", content: "continue" }] }));
  const replayWire = JSON.parse((await createAnthropicAdapter(provider).buildRequest(replay, meta())).body);
  expect(replayWire.messages[1].content[0]).toEqual({ type: "thinking", thinking: "exact thought", signature });
});
