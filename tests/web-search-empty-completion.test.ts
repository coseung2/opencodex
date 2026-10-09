import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { parseRequest } from "../src/responses/parser";
import { runWithWebSearch } from "../src/web-search/loop";
import { buildWebSearchTool } from "../src/web-search/synthetic-tool";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function chat(delta: Record<string, unknown>, finish = "stop") {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`
    + "data: [DONE]\n\n";
}

async function run(afterSearch: string[], maxSearches = 3, abort?: AbortController) {
  const bodies: any[] = [];
  let searches = 0;
  let finalUsage: unknown;
  globalThis.fetch = (async (input, init) => {
    if (String(input).startsWith("https://routed.test/")) {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 3 && abort) {
        abort.abort();
        throw new DOMException("aborted", "AbortError");
      }
      const data = bodies.length === 1
        ? chat({ reasoning_content: "Search first", tool_calls: [{ index: 0, id: "search_1", type: "function", function: { name: "web_search", arguments: '{"query":"example documentation"}' } }] }, "tool_calls")
        : afterSearch[bodies.length - 2];
      if (!data) throw new Error("unexpected extra model request");
      return new Response(data, { headers: { "Content-Type": "text/event-stream" } });
    }
    searches++;
    return new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Verified documentation result"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  const parsed = parseRequest({ model: "deepseek-test", input: "Search and explain", stream: true, tools: [{ type: "web_search" }, { type: "function", name: "read_file", parameters: {} }] });
  parsed.context.tools = [...(parsed.context.tools ?? []), buildWebSearchTool()];
  const response = await runWithWebSearch({
    parsed,
    adapter: createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "test-key", preserveReasoningContentModels: ["deepseek-test"] }),
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    forwardProvider: { adapter: "openai-responses", baseUrl: "https://sidecar.test/v1", authMode: "forward" },
    selectedForwardHeaders: new Headers(), hostedTool: { type: "web_search" },
    settings: { model: "test-sidecar", reasoning: "low", timeoutMs: 1000 },
    maxSearches, abortSignal: abort?.signal,
    onUsage: usage => { finalUsage = usage; },
  });
  const wire = await response.text();
  const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  return { bodies, searches, events, wire, finalUsage };
}

describe("web-search reasoning-only completion", () => {
  for (const budget of [1, 3]) test(`recovers using saved results without repeating search (budget ${budget})`, async () => {
    const result = await run([chat({ reasoning_content: "I will search again" }), chat({ content: "Answer based on verified documentation" })], budget);
    const completed = result.events.find(e => e.type === "response.completed");
    expect(completed?.response.output.some((item: any) => item.type === "message" && item.content.some((part: any) => part.text === "Answer based on verified documentation"))).toBe(true);
    expect(result.searches).toBe(1);
    expect(result.bodies).toHaveLength(3);
    expect(result.bodies[2].messages.some((m: any) => m.role === "tool" && m.content.includes("Verified documentation result"))).toBe(true);
    expect(result.bodies[2].messages.some((m: any) => m.reasoning_content === "Search first")).toBe(true);
    expect(result.bodies[2].tools.some((t: any) => t.function?.name === "web_search")).toBe(false);
    expect(result.bodies[2].tools.some((t: any) => t.function?.name === "read_file")).toBe(true);
    expect(result.wire).not.toContain("I will search again");
    expect(result.finalUsage).toMatchObject({ inputTokens: 20, outputTokens: 4, totalTokens: 24 });
  });

  test("a repeated search call despite removed tool fails without rerunning the sidecar", async () => {
    const repeat = chat({ tool_calls: [{ index: 0, id: "search_again", type: "function", function: { name: "web_search", arguments: '{"query":"repeat"}' } }] }, "tool_calls");
    const result = await run([chat({ reasoning_content: "thinking" }), repeat]);
    expect(result.events.some(e => e.type === "response.completed")).toBe(false);
    expect(result.wire).toContain("web_search_empty_completion");
    expect(result.searches).toBe(1);
    expect(result.bodies).toHaveLength(3);
  });

  test("a second empty answer fails visibly instead of completing or retrying forever", async () => {
    const result = await run([chat({ reasoning_content: "thinking" }), chat({ content: " \n" })]);
    expect(result.events.some(e => e.type === "response.completed")).toBe(false);
    expect(result.events.filter(e => e.type === "response.failed")).toHaveLength(1);
    expect(result.wire).toContain("web_search_empty_completion");
    expect(result.bodies).toHaveLength(3);
    expect(result.searches).toBe(1);
  });

  test("a real tool call after recovery is delivered to the client", async () => {
    const result = await run([chat({ reasoning_content: "thinking" }), chat({ tool_calls: [{ index: 0, id: "read_1", type: "function", function: { name: "read_file", arguments: "{}" } }] }, "tool_calls")]);
    const completed = result.events.find(e => e.type === "response.completed");
    expect(completed?.response.output.some((item: any) => item.type === "function_call" && item.name === "read_file")).toBe(true);
    expect(result.searches).toBe(1);
  });

  for (const reason of ["length", "content_filter"]) test(`preserves explicit ${reason} without retry`, async () => {
    const result = await run([chat({ reasoning_content: "thinking" }, reason)]);
    if (reason === "length") expect(result.events.some(e => e.type === "response.incomplete")).toBe(true);
    else expect(result.events.some(e => e.type === "response.failed" && e.response.error.code === "content_filter")).toBe(true);
    expect(result.wire).not.toContain("web_search_empty_completion");
    expect(result.bodies).toHaveLength(2);
  });

  test("ordinary final text does not cause a recovery request", async () => {
    const result = await run([chat({ content: "Final answer" })]);
    expect(result.events.some(e => e.type === "response.completed")).toBe(true);
    expect(result.bodies).toHaveLength(2);
  });

  test("cancellation during recovery never produces completed", async () => {
    const result = await run([chat({ reasoning_content: "thinking" })], 3, new AbortController());
    expect(result.events.some(e => e.type === "response.completed")).toBe(false);
    expect(result.bodies).toHaveLength(3);
  });
});
