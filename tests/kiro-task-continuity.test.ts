import { describe, expect, test } from "bun:test";
import { buildKiroPayload } from "../src/adapters/kiro";
import { KIRO_COMPLETION_TOOL_NAME, KIRO_EMPTY_TOOL_RESULT_MESSAGE } from "../src/adapters/kiro-constants";
import { convertKiroToolContext, MAX_KIRO_TOOL_CATALOG_BYTES, MAX_KIRO_TOOL_COUNT } from "../src/adapters/kiro-tools";
import { parseRequest } from "../src/responses/parser";
import type { OcxMessage, OcxParsedRequest, OcxTool } from "../src/types";

const exec: OcxTool = { name: "exec", freeform: true, description: "Execute JavaScript", parameters: { type: "object", properties: { input: { type: "string" } } } };
const filler = (count: number): OcxTool[] => Array.from({ length: count }, (_, index) => ({ name: `read_${index}`, description: "Read data", parameters: { type: "object" } }));
function request(tools: OcxTool[] = [exec], outputs: string[] = [""], overrides: { isError?: boolean; namespace?: string; image?: boolean } = {}): OcxParsedRequest {
  const messages: OcxMessage[] = [
    { role: "user", content: "Continue from the tool result; do not restart completed work." },
    { role: "assistant", content: [{ type: "toolCall", id: "call_exec", name: "exec", namespace: overrides.namespace, arguments: { input: "await tools.exec_command({cmd: 'ls'})" } }], model: "claude-sonnet-4.5", timestamp: 0 },
    ...outputs.map(content => ({ role: "toolResult" as const, toolCallId: "call_exec", toolName: "exec", content, isError: overrides.isError ?? false })),
  ];
  if (overrides.image) {
    messages.push({ role: "toolResult", toolCallId: "call_exec", toolName: "exec", content: [{ type: "image", imageUrl: "data:image/png;base64,iVBORw0KGgo=" }], isError: false });
  }
  return { modelId: "claude-sonnet-4.5", stream: true, options: {}, context: { messages, tools } } as OcxParsedRequest;
}
function wire(parsed: OcxParsedRequest) {
  const built = buildKiroPayload(parsed, undefined);
  const state = built.payload.conversationState as {
    history: Array<{ userInputMessage?: { content: string } }>;
    currentMessage: { userInputMessage: { content: string; images?: unknown[]; userInputMessageContext: { tools?: Array<{ toolSpecification: { name: string } }>; toolResults: Array<{ toolUseId: string; status: string; content: Array<{ text: string }> }> } } };
  };
  return {
    built, state,
    instructions: state.history.find(entry => entry.userInputMessage)?.userInputMessage?.content ?? "",
    results: state.currentMessage.userInputMessage.userInputMessageContext.toolResults,
    names: (state.currentMessage.userInputMessage.userInputMessageContext.tools ?? []).map(tool => tool.toolSpecification.name),
  };
}
function names(tools: unknown[]): string[] {
  return (tools as Array<{ toolSpecification: { name: string } }>).map(tool => tool.toolSpecification.name);
}

describe("Kiro task continuity: code-mode contract and tool results", () => {
  test("states the echo and nested discovery rules before execution", () => {
    const result = wire(request());
    expect(result.instructions).toContain("JavaScript");
    expect(result.instructions).toContain("ALL_TOOLS");
    expect(result.instructions).toContain("text(...)");
    expect(result.instructions).toContain("not lost context");
    expect(result.instructions).toContain("returns no tool result");
    expect(result.names).toContain(KIRO_COMPLETION_TOOL_NAME);
  });

  test.each(["", "   ", "Script completed\nWall time: 0.01s\nOutput:\n", "Command finished\r\nWall time: 0.01s\r\nOutput:\r\n<empty>"])("explains empty exec output without claiming context loss: %j", output => {
    const result = wire(request([exec], [output]));
    expect(result.results[0].content[0].text).toContain("not lost context");
    expect(result.results[0].content[0].text).toContain("text(...)");
    expect(result.results[0].content[0].text).toContain("Do not repeat");
    expect(result.results[0].status).toBe("success");
  });

  test("coalesces multiple empty notifications before adding one explanation", () => {
    const result = wire(request([exec], ["", "Script completed\nOutput:\n", "   "]));
    expect(result.results).toHaveLength(1);
    expect(result.results[0].content).toHaveLength(1);
    expect(result.results[0].content[0].text).toContain("not lost context");
  });

  test("preserves nonempty progress and final output in source order", () => {
    const result = wire(request([exec], ["", "first notification", "final value", " "]));
    expect(result.results[0].content.map(part => part.text)).toEqual(["first notification", "final value", " "]);
  });

  test.each(["Script failed\nWall time: 0.01s\nOutput:\n", "Script failed\r\n\r\nWall time: 0.01s\r\nOutput:\r\n  <empty>"])("does not describe failed empty wrappers as success: %j", output => {
    expect(wire(request([exec], [output])).results[0].content[0].text).toContain("real failure");
  });

  test("an error in any adjacent empty result remains a failure", () => {
    const parsed = request([exec], ["", ""]);
    (parsed.context.messages.at(-1) as { isError: boolean }).isError = true;
    const result = wire(parsed).results[0];
    expect(result.status).toBe("error");
    expect(result.content[0].text).toContain("real failure");
    expect(result.content[0].text).not.toContain("not a blocked tool");
  });

  test("image results, including retired replay images, are not missing output", () => {
    for (const replayed of [false, true]) {
      const parsed = request([exec], [""], { image: true });
      if (replayed) parsed._replayMessagePrefixLen = parsed.context.messages.length;
      expect(wire(parsed).results[0].content[0].text).toBe(KIRO_EMPTY_TOOL_RESULT_MESSAGE);
    }
  });

  test.each([
    [{ ...exec, freeform: false }],
    [exec, { name: "exec_command", parameters: { type: "object" } }],
  ])("does not assume code-mode semantics for a flat catalog: %j", (...tools) => {
    const result = wire(request(tools as OcxTool[]));
    expect(result.instructions).not.toContain("Nothing in the isolate");
    expect(result.results[0].content[0].text).toBe(KIRO_EMPTY_TOOL_RESULT_MESSAGE);
  });

  test("an unrelated MCP exec cannot acquire guidance through a spoofed result name", () => {
    const foreign = { ...exec, namespace: "mcp__foreign" };
    const result = wire(request([exec, foreign], [""], { namespace: foreign.namespace }));
    expect(result.results[0].content[0].text).toBe(KIRO_EMPTY_TOOL_RESULT_MESSAGE);
  });

  test("a namespaced shell helper does not cancel real code mode", () => {
    expect(wire(request([exec, { name: "exec_command", namespace: "mcp__remote" }])).instructions).toContain("Nothing in the isolate");
  });

  test.each([
    "TypeError: tool `apply_patch` expects a string input",
    "Error: The first line of the patch must be '*** Begin Patch'",
    "Error: The last line of the patch must be '*** End Patch'",
    "Unsupported import in exec: node:fs",
  ])("adds one actionable hint to a genuine host failure: %s", output => {
    const text = wire(request([exec], [output])).results[0].content[0].text;
    expect(text).toStartWith(output);
    expect(text).toContain("[recovery: ");
    expect(wire(request([exec], [text])).results[0].content[0].text).toBe(text);
  });

  test("source reads that quote diagnostics do not become errors", () => {
    for (const output of ["The documentation says: Unsupported import in exec: node:fs", "Script completed\nOutput:\nTypeError: tool `apply_patch` expects a string input"]) {
      expect(wire(request([exec], [output])).results[0].content[0].text).toBe(output);
    }
  });

  test("nonempty wrapper payloads and duplicate empty markers are never discarded", () => {
    for (const output of ["Script completed\nOutput:\n0", "Script failed\nOutput:\n<empty>\n<empty>", `Script failed\nOutput:\n${" ".repeat(100_000)}real error`]) {
      expect(wire(request([exec], [output])).results[0].content[0].text).toBe(output);
    }
  });

  test("result normalization does not cross an intervening user message", () => {
    const parsed = request([exec], ["", ""]);
    parsed.context.messages.splice(3, 0, { role: "user", content: "Stop and explain first." });
    expect(() => wire(parsed)).toThrow("no matching tool use");
  });

  test("custom_tool_call_output from the actual Responses parser gets the same repair", () => {
    const parsed = parseRequest({ model: "kiro/claude-sonnet-4.5", input: [
      { role: "user", content: "Inspect the files" },
      { type: "custom_tool_call", call_id: "call_exec", name: "exec", input: "await tools.exec_command({cmd:'ls'})" },
      { type: "custom_tool_call_output", call_id: "call_exec", output: "" },
    ], tools: [{ type: "custom", name: "exec", description: "JavaScript in a V8 isolate", format: { type: "text" } }] });
    expect(wire(parsed).results[0].content[0].text).toContain("not lost context");
  });
});

describe("Kiro task continuity: bounded catalog retains the execution path", () => {
  test("keeps ordinary declaration order below the budget", () => {
    const tools = [...filler(2), exec];
    expect(names(convertKiroToolContext(request(tools)).tools)).toEqual(tools.map(tool => tool.name));
  });

  test("retains discovered tools, exec and the search gateway ahead of filler", () => {
    const loaded: OcxTool = { name: "discovered", loadedFromToolSearch: true };
    const search: OcxTool = { name: "tool_search", toolSearch: true };
    const context = convertKiroToolContext(request([...filler(50), search, exec, loaded]));
    expect(names(context.tools).slice(0, 3)).toEqual(["discovered", "exec", "tool_search"]);
    expect(context.tools).toHaveLength(MAX_KIRO_TOOL_COUNT);
    expect(context.systemAdditions.join(" ")).not.toContain("unavailable this turn: exec");
  });

  test("reserves exec even when discovered tools alone fill every slot", () => {
    const tools = filler(MAX_KIRO_TOOL_COUNT).map(tool => ({ ...tool, loadedFromToolSearch: true }));
    const context = convertKiroToolContext(request([...tools, exec]));
    expect(context.tools).toHaveLength(MAX_KIRO_TOOL_COUNT);
    expect(names(context.tools)).toContain("exec");
  });

  test("reserves exec within the byte budget as well as the count budget", () => {
    const large = filler(30).map(tool => ({ ...tool, parameters: { type: "object", description: "x".repeat(7_000) } }));
    const context = convertKiroToolContext(request([...large, exec]));
    expect(names(context.tools)).toContain("exec");
    expect(new TextEncoder().encode(JSON.stringify(context.tools)).byteLength).toBeLessThanOrEqual(MAX_KIRO_TOOL_CATALOG_BYTES);
  });

  test("never lets an oversized reserved exec bypass the byte budget", () => {
    const oversized = { ...exec, parameters: { type: "object", description: "x".repeat(MAX_KIRO_TOOL_CATALOG_BYTES) } };
    expect(() => convertKiroToolContext(request([oversized]))).toThrow("exec exceeds");
  });

  test("emitted rather than requested shell tools determine the code-mode contract", () => {
    const parsed = request([...filler(MAX_KIRO_TOOL_COUNT), exec, { name: "exec_command" }]);
    const result = wire(parsed);
    expect(result.names).toContain("exec");
    expect(result.names).not.toContain("exec_command");
    expect(result.instructions).toContain("Nothing in the isolate");
  });

  test("tool_choice none neither reserves tools nor advertises code mode", () => {
    const parsed = request([...filler(50), exec]);
    parsed.options.toolChoice = "none";
    const result = wire(parsed);
    expect(result.names).toEqual([]);
    expect(result.instructions).not.toContain("Nothing in the isolate");
  });
});
