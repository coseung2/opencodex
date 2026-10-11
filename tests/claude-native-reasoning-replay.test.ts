import { expect, test } from "bun:test";
import { attachNativeReasoningState, projectNativeReasoning, type NativeReasoningState } from "../src/claude/native-reasoning";
import { anthropicToResponsesTranslation, nativeAnthropicReasoningProjection } from "../src/claude/inbound";
import { responsesJsonToAnthropicMessage, responsesSseToAnthropicSse, collectAnthropicMessage } from "../src/claude/outbound";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";
import { parseRequest } from "../src/responses/parser";
import { encodeReasoningEnvelope } from "../src/responses/reasoning-envelope";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const url = "https://fixture.invalid/v1/responses", headers = { Authorization: "Bearer fixture-key" };
function minted() {
  const parsed = {}, state: NativeReasoningState = { replay: new Map() };
  attachNativeReasoningState(parsed, state);
  projectNativeReasoning(parsed, { model: "model", input: [] }, url, headers);
  return state;
}
function translation(content: unknown) {
  return anthropicToResponsesTranslation({ model: "model", thinking: { type: "adaptive" }, messages: [
    { role: "user", content: "Original repository task" }, { role: "assistant", content }, { role: "user", content: "Continue" },
  ] });
}
function replay(translated: ReturnType<typeof translation>, destination = url, auth = headers, model = "model") {
  const parsed = {}, state: NativeReasoningState = { replay: translated.nativeReasoningReplay };
  attachNativeReasoningState(parsed, state);
  return projectNativeReasoning(parsed, { ...translated.body, model }, destination, auth);
}

test("hidden native ciphertext survives JSON round trip only for its actual destination", () => {
  const state = minted();
  const message = responsesJsonToAnthropicMessage({ output: [{ type: "reasoning", id: "rs_fixture", encrypted_content: "opaque-fixture" }] }, "client-alias", (enc, id) => state.mint?.(enc, id));
  expect(message.content).toHaveLength(1);
  expect((message.content as Record<string, unknown>[])[0]!.thinking).toBe("");
  const translated = translation(message.content);
  expect(JSON.stringify(translated.body)).not.toContain("opaque-fixture");
  expect(translated.body.include).toContain("reasoning.encrypted_content");
  expect(JSON.stringify(replay(translated))).toContain("opaque-fixture");
  for (const projected of [replay(translated, "https://other.invalid/v1/responses"), replay(translated, url, { Authorization: "Bearer another-key" }), replay(translated, url, headers, "other-model")]) {
    expect(JSON.stringify(projected)).not.toContain("opaque-fixture");
  }
  const native = nativeAnthropicReasoningProjection({ messages: [{ role: "assistant", content: message.content }] });
  expect(JSON.stringify(native)).not.toContain("opaque-fixture");
  expect(JSON.stringify(native)).not.toContain("ocxr1:");
});

test("tampered ciphertext and item id cannot acquire another route's provenance", () => {
  const nat = minted().mint!("opaque-fixture", "rs_fixture");
  for (const tampered of [{ ...nat, enc: "tampered" }, { ...nat, id: "rs_other" }, { ...nat, tag: "0".repeat(64) }]) {
    const translated = translation([{ type: "thinking", thinking: "visible", signature: encodeReasoningEnvelope({ nat: tampered }) }]);
    const projected = JSON.stringify(replay(translated));
    expect(projected).not.toContain("encrypted_content\":");
    expect(projected).toContain("visible");
  }
});

test("replay honors opaque-blob rejection and cannot cross account selection", () => {
  const nat = minted().mint!("opaque-fixture", "rs_fixture");
  const translated = translation([{ type: "thinking", thinking: "visible", signature: encodeReasoningEnvelope({ nat }) }]);
  const parsed = { _stripReasoningEncryptedContent: true };
  attachNativeReasoningState(parsed, { replay: translated.nativeReasoningReplay });
  expect(JSON.stringify(projectNativeReasoning(parsed, translated.body, url, headers))).not.toContain("opaque-fixture");
  expect(JSON.stringify(replay(translated, url, { ...headers, "chatgpt-account-id": "other-account" }))).not.toContain("opaque-fixture");
});

test("streaming hidden reasoning gets a replay carrier without showing ciphertext", async () => {
  const state = minted(), budget = createTestTranslatorBudget();
  const events = [
    { type: "response.output_item.done", item: { type: "reasoning", id: "rs_fixture", encrypted_content: "opaque-fixture" } },
    { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const stream = responsesSseToAnthropicSse(new Response(events).body!, "client-alias", { translatorBudget: budget, nativeReasoningFor: (enc, id) => state.mint?.(enc, id) });
  const message = await collectAnthropicMessage(stream, "client-alias", budget);
  expect((message.content as Record<string, unknown>[])[0]!.thinking).toBe("");
  expect(JSON.stringify(replay(translation(message.content)))).toContain("opaque-fixture");
  budget.dispose();
});

test("real Responses adapter verifies replay after credential selection and removes bridge metadata", async () => {
  const state = minted();
  const translated = translation([{ type: "thinking", thinking: "", signature: encodeReasoningEnvelope({ nat: state.mint!("opaque-fixture", "rs_fixture") }) }]);
  const parsed = parseRequest(translated.body), budget = createTestTranslatorBudget();
  attachNativeReasoningState(parsed, { replay: translated.nativeReasoningReplay });
  const adapter = createResponsesPassthroughAdapter({ baseUrl: "https://fixture.invalid", adapter: "openai-responses", apiKey: "fixture-key" });
  const request = await adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: budget });
  const sent = String(request.body);
  // Content-Type is excluded from identity, so this matches the minting request.
  expect(sent).toContain("opaque-fixture");
  expect(sent).not.toContain("ocxr1:");
  expect(sent).not.toContain('"tag"');
  request.releaseBodyObservation?.(); budget.dispose();
});
