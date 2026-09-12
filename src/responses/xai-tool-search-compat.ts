import { createHash } from "node:crypto";
import type { SsePayloadRewrite } from "../server/sse-payload-rewrite";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function collectNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectNames(entry, names);
    return;
  }
  if (!isPlainObject(value)) return;
  if ((value.type === "function" || value.type === "custom") && typeof value.name === "string") names.add(value.name);
  for (const entry of Object.values(value)) collectNames(entry, names);
}

function hasClientToolSearch(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasClientToolSearch);
  if (!isPlainObject(value)) return false;
  if (value.type === "tool_search" && value.execution === "client") return true;
  return Object.values(value).some(hasClientToolSearch);
}

/** Stable collision-free function name used only on the xAI wire. */
export function xaiToolSearchAlias(body: unknown): string | undefined {
  if (!hasClientToolSearch(body)) return undefined;
  const occupied = new Set<string>();
  collectNames(body, occupied);
  const base = "ocx_tool_search";
  if (!occupied.has(base)) return base;
  for (let salt = 0; ; salt += 1) {
    const suffix = createHash("sha256").update(`xai-tool-search\0${salt}`).digest("hex").slice(0, 16);
    const candidate = `${base}_${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

function functionDeclaration(tool: Record<string, unknown>, alias: string): Record<string, unknown> {
  const { execution: _execution, ...rest } = tool;
  return {
    ...rest,
    type: "function",
    name: alias,
    description: typeof tool.description === "string"
      ? tool.description
      : "Search for additional client tools to load for the next turn.",
    parameters: isPlainObject(tool.parameters) ? tool.parameters : {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer" } },
      required: ["query"],
    },
  };
}

function rewriteChoice(value: unknown, alias: string): unknown {
  if (!isPlainObject(value)) return value;
  if (value.type === "tool_search") return { ...value, type: "function", name: alias };
  if (value.type !== "allowed_tools" || !Array.isArray(value.tools)) return value;
  let changed = false;
  const tools = value.tools.map(tool => {
    if (!isPlainObject(tool) || tool.type !== "tool_search") return tool;
    changed = true;
    return { ...tool, type: "function", name: alias };
  });
  return changed ? { ...value, tools } : value;
}

function rewriteToolGroup(group: unknown[], alias: string): unknown[] {
  return group.map(tool => isPlainObject(tool) && tool.type === "tool_search"
    ? functionDeclaration(tool, alias)
    : tool);
}

/** Lower alpha-only xAI tool discovery to an ordinary function and replayable function history. */
export function lowerXaiToolSearch(body: unknown): { body: unknown; alias?: string } {
  const alias = xaiToolSearchAlias(body);
  if (!alias || !isPlainObject(body)) return { body, ...(alias ? { alias } : {}) };
  const loadedTools: unknown[] = [];
  let input = body.input;
  if (Array.isArray(body.input)) {
    input = body.input.map(item => {
      if (!isPlainObject(item)) return item;
      if (item.type === "tool_search_call") {
        const { execution: _execution, arguments: args, ...rest } = item;
        return { ...rest, type: "function_call", name: alias, arguments: JSON.stringify(isPlainObject(args) ? args : {}) };
      }
      if (item.type === "tool_search_output") {
        const { tools, execution: _execution, status, ...rest } = item;
        if (Array.isArray(tools)) loadedTools.push(...tools);
        return {
          ...rest,
          type: "function_call_output",
          output: JSON.stringify({ status: typeof status === "string" ? status : "completed", loaded_tools: Array.isArray(tools) ? tools : [] }),
        };
      }
      if ((item.type === "additional_tools") && Array.isArray(item.tools)) {
        return { ...item, tools: rewriteToolGroup(item.tools, alias) };
      }
      return item;
    });
  }
  const declared = Array.isArray(body.tools) ? rewriteToolGroup(body.tools, alias) : [];
  return {
    body: {
      ...body,
      tools: [...declared, ...loadedTools],
      ...(Array.isArray(body.input) ? { input } : {}),
      ...(Object.hasOwn(body, "tool_choice") ? { tool_choice: rewriteChoice(body.tool_choice, alias) } : {}),
    },
    alias,
  };
}

function searchItemId(id: unknown): unknown {
  return typeof id === "string" && id.startsWith("fc_") ? `tsc_${id.slice(3)}` : id;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : {};
  } catch { return {}; }
}

function restoreItem(item: unknown, alias: string): unknown {
  if (!isPlainObject(item) || item.type !== "function_call" || item.name !== alias) return item;
  const restored: Record<string, unknown> = {
    ...item,
    type: "tool_search_call",
    id: searchItemId(item.id),
    execution: "client",
    arguments: parseArguments(item.arguments),
  };
  delete restored.name;
  return restored;
}

function restorePayload(value: unknown, alias: string): unknown {
  if (!isPlainObject(value)) return value;
  let changed = false;
  const next: Record<string, unknown> = { ...value };
  if (Array.isArray(value.output)) {
    const output = value.output.map(item => {
      const restored = restoreItem(item, alias);
      changed ||= restored !== item;
      return restored;
    });
    if (changed) next.output = output;
  }
  if ((value.type === "response.output_item.added" || value.type === "response.output_item.done") && isPlainObject(value.item)) {
    const restored = restoreItem(value.item, alias);
    if (restored !== value.item) { next.item = restored; changed = true; }
  }
  if (typeof value.type === "string" && value.type.startsWith("response.") && isPlainObject(value.response)) {
    const restored = restorePayload(value.response, alias);
    if (restored !== value.response) { next.response = restored; changed = true; }
  }
  return changed ? next : value;
}

export function restoreXaiToolSearchCallsInJson(text: string, alias: string | undefined): string {
  if (!alias) return text;
  try {
    const parsed = JSON.parse(text) as unknown;
    const restored = restorePayload(parsed, alias);
    return restored === parsed ? text : JSON.stringify(restored);
  } catch { return text; }
}

export function createXaiToolSearchPayloadRewrite(alias: string | undefined): SsePayloadRewrite | undefined {
  if (!alias) return undefined;
  const ids = new Map<string, string>();
  return payload => {
    if (payload === "[DONE]") return payload;
    let value: unknown;
    try { value = JSON.parse(payload); } catch { return payload; }
    if (!isPlainObject(value)) return payload;
    if ((value.type === "response.output_item.added" || value.type === "response.output_item.done") && isPlainObject(value.item)
      && value.item.type === "function_call" && value.item.name === alias && typeof value.item.id === "string") {
      ids.set(value.item.id, String(searchItemId(value.item.id)));
    }
    if ((value.type === "response.function_call_arguments.delta" || value.type === "response.function_call_arguments.done")
      && typeof value.item_id === "string" && ids.has(value.item_id)) {
      // Codex commits tool-search arguments from the authoritative output-item.done object.
      return JSON.stringify({ type: "response.output_text.delta", delta: "", output_index: value.output_index ?? 0 });
    }
    const restored = restorePayload(value, alias);
    return restored === value ? payload : JSON.stringify(restored);
  };
}
