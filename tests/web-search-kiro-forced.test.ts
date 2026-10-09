import { afterEach, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { buildKiroPayload } from "../src/adapters/kiro-codec";
import { parseRequest } from "../src/responses/parser";
import { runWithWebSearch } from "../src/web-search/loop";
import { buildWebSearchTool } from "../src/web-search/synthetic-tool";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import type { OcxParsedRequest } from "../src/types";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function stream(delta: object) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
}
const search = (args = '{"query":"storage manufacturer documentation"}') => ({ tool_calls: [{ index: 0, id: "search_1", type: "function", function: { name: "web_search", arguments: args } }] });
async function run(turns: object[], choice: unknown = { type: "function", name: "web_search" }, failSearch = false, abort = false) {
  const built: OcxParsedRequest[] = [];
  let searches = 0;
  let modelCalls = 0;
  const ac = new AbortController();
  globalThis.fetch = (async (input) => {
    if (String(input).startsWith("https://model.test")) {
      const turn = turns[modelCalls++];
      if (!turn) throw new Error("unexpected model retry");
      return stream(turn);
    }
    searches++;
    if (abort) ac.abort();
    if (failSearch) return new Response("unavailable", { status: 400 });
    return new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Retrieved source evidence"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n');
  }) as typeof fetch;
  const parsed = parseRequest({ model: "claude-opus-5.5", input: "Search storage documentation", stream: true,
    tools: [{ type: "web_search" }, { type: "function", name: "read_file", parameters: {} }], tool_choice: choice });
  parsed.context.tools = [...(parsed.context.tools ?? []), buildWebSearchTool()];
  const initialChoice = structuredClone(parsed.options.toolChoice);
  const chat = createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://model.test/v1", apiKey: "test" });
  const response = await runWithWebSearch({ parsed, adapter: { ...chat, name: "kiro", buildRequest(p, meta) {
    buildKiroPayload(p, undefined); // Real Kiro capability/payload validation, no provider credentials.
    built.push(p);
    return chat.buildRequest(p, meta);
  } }, incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    forwardProvider: { adapter: "openai-responses", baseUrl: "https://search.test/v1", authMode: "forward" },
    selectedForwardHeaders: new Headers(), hostedTool: { type: "web_search" },
    settings: { model: "search-test", reasoning: "low", timeoutMs: 1000 }, maxSearches: 1, abortSignal: ac.signal });
  const wire = await response.text();
  expect(parsed.options.toolChoice).toEqual(initialChoice);
  return { built, searches, modelCalls, wire, status: response.status };
}
for (const choice of [{ type: "function", name: "web_search" }, "required", { type: "allowed_tools", mode: "required", tools: [{ type: "web_search" }] }]) {
  test(`Kiro forced search executes retrieval before answering: ${JSON.stringify(choice)}`, async () => {
    const r = await run([search(), { content: "Verified answer" }], choice);
    expect(r.searches).toBe(1);
    const events = r.wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    expect(events.some(e => e.type === "response.output_item.done" && e.item.type === "web_search_call" && e.item.status === "completed")).toBe(true);
    expect(r.wire).toContain("Verified answer");
    expect(r.wire).toContain("response.completed");
    expect(r.built.every(p => p.options.toolChoice === "auto")).toBe(true);
    expect(r.built[0]!.context.tools!.map(t => t.name)).toEqual(["web_search"]);
    expect(r.built[1]!.context.tools!.map(t => t.name)).toEqual(["read_file"]);
    expect(JSON.stringify(r.built[1]!.context.messages)).toContain("Retrieved source evidence");
  });
}
test("retries one skipped search without exposing the unsearched answer", async () => {
  const r = await run([{ content: "UNVERIFIED" }, search(), { content: "Verified answer" }]);
  expect(r.modelCalls).toBe(3); expect(r.searches).toBe(1);
  expect(r.wire).not.toContain("UNVERIFIED"); expect(r.wire).toContain("response.completed");
});
test("two skipped searches fail explicitly without successful completion", async () => {
  const r = await run([{ content: "UNVERIFIED" }, { content: "UNVERIFIED" }]);
  expect(r.modelCalls).toBe(2); expect(r.searches).toBe(0);
  expect(r.wire).toContain("forced_web_search_not_executed");
  expect(r.wire).not.toContain("response.completed"); expect(r.wire).not.toContain("UNVERIFIED");
});
test("empty search arguments do not count as execution", async () => {
  const r = await run([search('{}'), search('{}')]);
  expect(r.searches).toBe(0); expect(r.wire).toContain("forced_web_search_not_executed");
});
test("an empty sibling search cannot consume the required retrieval budget", async () => {
  const mixed = { tool_calls: [...search('{}').tool_calls,
    { ...search().tool_calls[0]!, index: 1, id: "search_valid" }] };
  const r = await run([mixed, { content: "Verified answer" }]);
  expect(r.searches).toBe(1); expect(r.wire).toContain("response.completed");
});
test("a real client tool cannot escape before required retrieval", async () => {
  const other = { tool_calls: [{ index: 0, id: "read_1", type: "function", function: { name: "read_file", arguments: '{}' } }] };
  const r = await run([other, other]);
  expect(r.wire).toContain("forced_web_search_not_executed");
  expect(r.wire).not.toContain('"type":"function_call"');
  expect(r.searches).toBe(0);
});
test("failed retrieval cannot produce a claimed searched answer", async () => {
  const r = await run([search()], undefined, true);
  expect(r.searches).toBe(1); expect(r.wire).toContain("forced_web_search_failed");
  expect(r.wire).not.toContain("response.completed");
});
test("cancellation during retrieval never completes", async () => {
  const r = await run([search()], undefined, false, true);
  expect(r.wire).not.toContain("response.completed"); expect(r.modelCalls).toBe(1);
});
test("unrelated forced tools are refused before Kiro, without overload retry", async () => {
  const r = await run([], { type: "function", name: "read_file" });
  expect(r.status).toBe(400); expect(r.modelCalls).toBe(0); expect(r.searches).toBe(0);
});
test("automatic Kiro turns still may answer without searching", async () => {
  const r = await run([{ content: "No retrieval needed" }], "auto");
  expect(r.searches).toBe(0); expect(r.wire).toContain("response.completed");
});
