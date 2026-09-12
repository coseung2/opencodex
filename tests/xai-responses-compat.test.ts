import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { normalizeXaiResponsesWebSearch } from "../src/adapters/xai-web-search";
import {
  createXaiCustomToolPayloadRewrite,
  lowerXaiResponsesCustomTools,
  restoreXaiCustomCallsInJson,
} from "../src/responses/xai-custom-tool-compat";
import {
  createXaiNamespaceToolPayloadRewrite,
  lowerXaiResponsesNamespaceTools,
  restoreXaiNamespaceCallsInJson,
  xaiResponsesNamespaceToolAliases,
} from "../src/responses/xai-namespace-tool-compat";
import {
  createXaiToolSearchPayloadRewrite,
  lowerXaiToolSearch,
  restoreXaiToolSearchCallsInJson,
} from "../src/responses/xai-tool-search-compat";
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
  test("undeclared custom history retains required item identity with store:false", () => {
    const raw = { model: "grok-4.6", store: false, input: [
      { type: "custom_tool_call", call_id: "call_history", name: "old_tool", input: "synthetic" },
      { type: "custom_tool_call_output", call_id: "call_history", output: "done" },
    ] };
    const build = (provider: typeof apiProvider) => JSON.parse(createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: raw.model, context: { messages: [] }, stream: false, options: {}, _rawBody: raw,
    }, { headers: new Headers() }).body);
    const first = build(apiProvider);
    expect(first.input[0].id).toMatch(/^ctc_[a-f0-9]{32}$/);
    expect(build(apiProvider).input[0].id).toBe(first.input[0].id);
    expect(first.input[0]).toMatchObject(raw.input[0]);
    expect(first.input[1]).toEqual(raw.input[1]);
    expect(build({ ...apiProvider, baseUrl: "https://custom.test/v1" }).input).toEqual(raw.input);
    expect(raw.input[0]).not.toHaveProperty("id");
  });
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

describe("xAI Responses namespace-tool compatibility", () => {
  test("lowers client tool search to a function and restores JSON/SSE calls", () => {
    const raw = {
      model: "grok-4.6",
      input: [],
      tools: [{
        type: "tool_search",
        execution: "client",
        parameters: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "integer" } },
          required: ["query"],
        },
      }],
    };

    const lowered = lowerXaiToolSearch(raw);
    const body = lowered.body as any;
    expect(body.tools[0]).toMatchObject({ type: "function", name: lowered.alias, parameters: raw.tools[0].parameters });
    expect(body.tools[0]).not.toHaveProperty("execution");
    expect(raw.tools[0].execution).toBe("client");

    const upstreamItem = {
      type: "function_call", id: "fc_search", call_id: "call_search",
      name: lowered.alias, arguments: JSON.stringify({ query: "repo tools", limit: 3 }), status: "completed",
    };
    const restoredJson = JSON.parse(restoreXaiToolSearchCallsInJson(JSON.stringify({ output: [upstreamItem] }), lowered.alias));
    expect(restoredJson.output[0]).toEqual({
      type: "tool_search_call", id: "tsc_search", call_id: "call_search",
      execution: "client", arguments: { query: "repo tools", limit: 3 }, status: "completed",
    });
    const rewrite = createXaiToolSearchPayloadRewrite(lowered.alias)!;
    const restoredEvent = JSON.parse(rewrite(JSON.stringify({ type: "response.output_item.done", item: upstreamItem })));
    expect(restoredEvent.item).toEqual(restoredJson.output[0]);

    for (const provider of [cliProvider, apiProvider]) {
      const request = createResponsesPassthroughAdapter(provider).buildRequest({
        modelId: raw.model,
        context: { messages: [] },
        stream: true,
        options: {},
        _rawBody: raw,
      }, { headers: new Headers() });
      const wire = JSON.parse(request.body) as typeof raw;
      expect(wire.tools[0]).toMatchObject({ type: "function", name: lowered.alias });
      expect(wire.tools[0]).not.toHaveProperty("execution");
      expect(wire.tools[0].parameters).toEqual(raw.tools[0].parameters);
    }
  });

  test("replays a search result as function history and promotes loaded tools", () => {
    const search = {
      type: "tool_search", execution: "client",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    };
    const loaded = { type: "function", name: "repo_read", description: "Read a repository file", parameters: { type: "object" } };
    const raw = {
      tools: [search],
      input: [
        { type: "tool_search_call", id: "tsc_1", call_id: "call_1", execution: "client", arguments: { query: "repo read" } },
        { type: "tool_search_output", call_id: "call_1", execution: "client", status: "completed", tools: [loaded] },
      ],
    };
    const lowered = lowerXaiToolSearch(raw);
    const body = lowered.body as any;
    expect(body.input[0]).toMatchObject({ type: "function_call", name: lowered.alias, call_id: "call_1", arguments: JSON.stringify({ query: "repo read" }) });
    expect(body.input[1]).toMatchObject({ type: "function_call_output", call_id: "call_1" });
    expect(JSON.parse(body.input[1].output)).toEqual({ status: "completed", loaded_tools: [loaded] });
    expect(body.tools).toContainEqual(loaded);
    expect(raw.input[0].type).toBe("tool_search_call");
  });

  test("flattens Codex namespaces, preserves the synthetic functions group, and avoids flat-name collisions", () => {
    const raw = {
      tools: [
        { type: "function", name: "mcp__repo__read", parameters: { type: "object" } },
        {
          type: "namespace",
          name: "mcp__repo",
          tools: [{ type: "function", name: "read", defer_loading: true, parameters: { type: "object" } }],
        },
        {
          type: "namespace",
          name: "functions",
          tools: [{ type: "function", name: "shell", defer_loading: true, parameters: { type: "object" } }],
        },
      ],
      tool_choice: { type: "function", namespace: "mcp__repo", name: "read" },
      input: [
        { type: "function_call", namespace: "mcp__repo", name: "read", call_id: "call_read", arguments: "{}" },
        {
          type: "additional_tools",
          tools: [{
            type: "namespace",
            name: "mcp__browser",
            tools: [{ type: "function", name: "click", parameters: { type: "object" } }],
          }],
        },
      ],
    };

    const lowered = lowerXaiResponsesNamespaceTools(raw);
    const body = lowered.body as typeof raw;
    const repo = body.tools.find(tool => tool.type === "function" && tool.name !== "mcp__repo__read" && tool.name !== "shell")!;
    expect(repo.name).toStartWith("ocxns_");
    expect(repo).not.toHaveProperty("defer_loading");
    expect(body.tools.some(tool => tool.type === "namespace")).toBe(false);
    expect(body.tools.find(tool => tool.name === "shell")).not.toHaveProperty("defer_loading");
    expect(body.tool_choice).toEqual({ type: "function", name: repo.name });
    expect(body.input[0]).toMatchObject({ type: "function_call", name: repo.name, call_id: "call_read" });
    expect(body.input[0]).not.toHaveProperty("namespace");
    const additional = body.input[1] as { tools: Array<Record<string, unknown>> };
    expect(additional.tools).toEqual([{
      type: "function",
      name: "mcp__browser__click",
      parameters: { type: "object" },
    }]);
    expect(lowered.aliases.get(repo.name)).toEqual({ namespace: "mcp__repo", name: "read" });
    expect(raw.tools[1].type).toBe("namespace");
  });

  test("restores xAI namespace aliases in JSON and SSE without guessing unknown flat names", () => {
    const raw = {
      tools: [{
        type: "namespace",
        name: "mcp__workspace",
        tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
      }],
    };
    const aliases = xaiResponsesNamespaceToolAliases(raw);
    expect(aliases.get("mcp__workspace__read_file")).toEqual({ namespace: "mcp__workspace", name: "read_file" });

    const json = JSON.stringify({
      output: [
        { type: "function_call", name: "mcp__workspace__read_file", call_id: "call_1", arguments: "{}" },
        { type: "function_call", name: "unknown__tool", call_id: "call_2", arguments: "{}" },
      ],
    });
    const restored = JSON.parse(restoreXaiNamespaceCallsInJson(json, aliases)) as { output: Array<Record<string, unknown>> };
    expect(restored.output[0]).toMatchObject({ namespace: "mcp__workspace", name: "read_file" });
    expect(restored.output[1]).toMatchObject({ name: "unknown__tool" });
    expect(restored.output[1]).not.toHaveProperty("namespace");

    const rewrite = createXaiNamespaceToolPayloadRewrite(aliases)!;
    const event = JSON.parse(rewrite(JSON.stringify({
      type: "response.output_item.done",
      item: { type: "function_call", name: "mcp__workspace__read_file", call_id: "call_1", arguments: "{}" },
    })));
    expect(event.item).toMatchObject({ namespace: "mcp__workspace", name: "read_file" });
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
          {
            type: "namespace",
            name: "mcp__workspace",
            tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: {} } }],
          },
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
    const workspace = body.tools.find(tool => tool.name === "mcp__workspace__read_file");
    const mode = body.tools.find(tool => tool.name === "mode");
    expect(patch).toMatchObject({ type: "function", parameters: { type: "object" } });
    expect(search).toEqual({ type: "web_search" });
    expect(workspace).toMatchObject({ type: "function", parameters: { type: "object" } });
    expect(body.tools.some(tool => tool.type === "namespace")).toBe(false);
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
