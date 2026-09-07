import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { normalizeXaiResponsesWebSearch } from "../src/adapters/xai-web-search";
import {
  createXaiCustomToolPayloadRewrite,
  lowerXaiResponsesCustomTools,
  restoreXaiCustomCallsInJson,
} from "../src/responses/xai-custom-tool-compat";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const cliProvider = {
  adapter: "openai-responses",
  baseUrl: "https://cli-chat-proxy.grok.com/v1",
  authMode: "oauth" as const,
  apiKey: "test-token",
};

const apiProvider = {
  adapter: "openai-responses",
  baseUrl: "https://api.x.ai/v1",
  authMode: "key" as const,
  apiKey: "test-key",
};

describe("xAI Responses custom-tool compatibility", () => {
  test("lowers a bare custom tool and its replay items without touching ordinary functions", () => {
    const raw = {
      tools: [
        { type: "custom", name: "apply_patch", description: "Apply patch", format: { type: "text" } },
        { type: "function", name: "grep", parameters: { type: "object", properties: {} } },
      ],
      tool_choice: { type: "custom", name: "apply_patch" },
      input: [
        { type: "custom_tool_call", id: "ctc_old", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
        { type: "custom_tool_call_output", call_id: "call_patch", output: "done" },
      ],
    };

    const lowered = lowerXaiResponsesCustomTools(raw);
    const body = lowered.body as typeof raw;

    expect(lowered.names).toEqual(new Set(["apply_patch"]));
    expect(body.tools[0]).toMatchObject({
      type: "function",
      name: "apply_patch",
      parameters: { type: "object", required: ["input"] },
    });
    expect(body.tools[1]).toEqual(raw.tools[1]);
    expect(body.tool_choice).toEqual({ type: "function", name: "apply_patch" });
    expect(body.input[0]).toMatchObject({
      type: "function_call",
      call_id: "call_patch",
      name: "apply_patch",
      arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }),
    });
    expect(body.input[1]).toMatchObject({ type: "function_call_output", call_id: "call_patch", output: "done" });
    expect(raw.tools[0].type).toBe("custom");
  });

  test("SSE restoration is scoped to the converted item id and leaves a normal function alone", () => {
    const rewrite = createXaiCustomToolPayloadRewrite(new Set(["apply_patch"]))!;
    const customAdded = rewrite(JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "fc_patch", call_id: "call_patch", name: "apply_patch", arguments: "", status: "in_progress" },
    }));
    const normalAdded = rewrite(JSON.stringify({
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", id: "fc_grep", call_id: "call_grep", name: "grep", arguments: "", status: "in_progress" },
    }));
    const customDelta = rewrite(JSON.stringify({
      type: "response.function_call_arguments.delta", item_id: "fc_patch", output_index: 0, delta: "{\"input\":" ,
    }));
    const normalDeltaPayload = JSON.stringify({
      type: "response.function_call_arguments.delta", item_id: "fc_grep", output_index: 1, delta: "{\"query\":\"x\"}",
    });
    const normalDelta = rewrite(normalDeltaPayload);
    const customDone = rewrite(JSON.stringify({
      type: "response.function_call_arguments.done", item_id: "fc_patch", output_index: 0,
      arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }),
    }));
    const customItemDone = rewrite(JSON.stringify({
      type: "response.output_item.done", output_index: 0,
      item: { type: "function_call", id: "fc_patch", call_id: "call_patch", name: "apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }), status: "completed" },
    }));

    expect(JSON.parse(customAdded)).toMatchObject({ item: { type: "custom_tool_call", id: "ctc_patch", name: "apply_patch" } });
    expect(JSON.parse(normalAdded)).toMatchObject({ item: { type: "function_call", id: "fc_grep", name: "grep" } });
    expect(JSON.parse(customDelta)).toMatchObject({ type: "response.custom_tool_call_input.delta", item_id: "ctc_patch", delta: "" });
    expect(normalDelta).toBe(normalDeltaPayload);
    expect(JSON.parse(customDone)).toMatchObject({
      type: "response.custom_tool_call_input.done", item_id: "ctc_patch", input: "*** Begin Patch\n*** End Patch",
    });
    expect(JSON.parse(customItemDone)).toMatchObject({
      item: { type: "custom_tool_call", id: "ctc_patch", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
    });
  });

  test("non-streaming JSON restoration converts only the named function call", () => {
    const text = JSON.stringify({
      id: "resp_1",
      output: [
        { type: "function_call", id: "fc_patch", call_id: "call_patch", name: "apply_patch", arguments: JSON.stringify({ input: "patch" }) },
        { type: "function_call", id: "fc_grep", call_id: "call_grep", name: "grep", arguments: "{}" },
      ],
    });
    const restored = JSON.parse(restoreXaiCustomCallsInJson(text, new Set(["apply_patch"]))) as { output: Array<Record<string, unknown>> };
    expect(restored.output[0]).toMatchObject({ type: "custom_tool_call", id: "ctc_patch", input: "patch" });
    expect(restored.output[1]).toMatchObject({ type: "function_call", id: "fc_grep", name: "grep" });
  });
});

describe("xAI Responses search and schema compatibility", () => {
  test("normalizes Codex hosted-search fields on both xAI Responses destinations", () => {
    const raw = {
      tools: [{
        type: "web_search_preview",
        external_web_access: true,
        search_context_size: "medium",
        search_content_types: ["text", "image"],
        user_location: { country: "US" },
      }],
      tool_choice: { type: "web_search_preview" },
    };
    for (const provider of [cliProvider, apiProvider]) {
      const normalized = normalizeXaiResponsesWebSearch(raw, provider) as typeof raw;
      expect(normalized.tools[0]).toEqual({
        type: "web_search",
        search_content_types: ["text", "image"],
        user_location: { country: "US" },
        enable_image_search: true,
      });
      expect(normalized.tool_choice).toEqual({ type: "web_search" });
    }
    expect(raw.tools[0].type).toBe("web_search_preview");
  });

  test("cached-only search is omitted rather than silently widened to live network access", () => {
    const normalized = normalizeXaiResponsesWebSearch({
      tools: [{ type: "web_search", external_web_access: false }],
      tool_choice: { type: "web_search" },
    }, cliProvider) as Record<string, unknown>;
    expect(normalized.tools).toBeUndefined();
    expect(normalized.tool_choice).toBe("none");
  });

  test("Grok CLI adapter combines custom lowering, hosted-search normalization, and safe root-union flattening", () => {
    const request = createResponsesPassthroughAdapter(cliProvider).buildRequest({
      modelId: "grok-4.6",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "grok-4.6",
        input: [],
        tools: [
          { type: "custom", name: "apply_patch", description: "Patch", format: { type: "text" } },
          { type: "web_search_preview", external_web_access: true, search_context_size: "medium" },
          {
            type: "function",
            name: "mode",
            parameters: {
              oneOf: [
                { type: "object", properties: { value: { const: "a" } }, required: ["value"] },
                { type: "object", properties: { value: { const: "b" } }, required: ["value"] },
              ],
            },
          },
        ],
      },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as { tools: Array<Record<string, unknown>> };
    const patch = body.tools.find(tool => tool.name === "apply_patch");
    const search = body.tools.find(tool => tool.type === "web_search");
    const mode = body.tools.find(tool => tool.name === "mode");
    expect(patch).toMatchObject({ type: "function", parameters: { type: "object" } });
    expect(search).toEqual({ type: "web_search" });
    expect(mode?.parameters).toEqual({
      type: "object",
      properties: { value: { anyOf: [{ const: "a" }, { const: "b" }] } },
      required: ["value"],
    });
  });

  test("public xAI Responses preserves a valid root union instead of applying CLI-only flattening", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "string" } } },
      ],
    };
    const request = createResponsesPassthroughAdapter(apiProvider).buildRequest({
      modelId: "grok-4.6",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "grok-4.6", input: [], tools: [{ type: "function", name: "union", parameters: schema }] },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as { tools: Array<{ parameters: unknown }> };
    expect(body.tools[0].parameters).toEqual({ ...schema, type: "object" });
  });
});
