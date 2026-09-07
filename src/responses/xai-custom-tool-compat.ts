import type { SsePayloadRewrite } from "../server/sse-payload-rewrite";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function collectBareCustomToolNames(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectBareCustomToolNames(entry, out);
    return;
  }
  if (!isPlainObject(value)) return;
  if (value.type === "custom" && typeof value.name === "string" && typeof value.namespace !== "string") {
    out.add(value.name);
  }
  for (const entry of Object.values(value)) collectBareCustomToolNames(entry, out);
}

function collectConvertedCallIds(value: unknown, names: ReadonlySet<string>, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectConvertedCallIds(entry, names, out);
    return;
  }
  if (!isPlainObject(value)) return;
  if (value.type === "custom_tool_call" && typeof value.name === "string" && names.has(value.name) && typeof value.call_id === "string") {
    out.add(value.call_id);
  }
  for (const entry of Object.values(value)) collectConvertedCallIds(entry, names, out);
}

function rewriteToolChoiceForUpstream(value: unknown, names: ReadonlySet<string>): unknown {
  if (!isPlainObject(value)) return value;
  if ((value.type === "custom" || value.type === "function") && typeof value.name === "string" && names.has(value.name)) {
    return value.type === "function" ? value : { ...value, type: "function" };
  }
  if (value.type === "allowed_tools" && Array.isArray(value.tools)) {
    let changed = false;
    const tools = value.tools.map(tool => {
      if (!isPlainObject(tool) || tool.type !== "custom" || typeof tool.name !== "string" || !names.has(tool.name)) return tool;
      changed = true;
      return { ...tool, type: "function" };
    });
    return changed ? { ...value, tools } : value;
  }
  return value;
}

function rewriteForUpstream(value: unknown, names: ReadonlySet<string>, callIds: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map(entry => rewriteForUpstream(entry, names, callIds));
  if (!isPlainObject(value)) return value;

  if (value.type === "custom" && typeof value.name === "string" && names.has(value.name)) {
    const { format: _format, ...rest } = value;
    return {
      ...rest,
      type: "function",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "Raw input for this client-executed custom tool." },
        },
        required: ["input"],
        additionalProperties: false,
      },
    };
  }

  if (value.type === "custom_tool_call" && typeof value.name === "string" && names.has(value.name)) {
    const { input, id: _id, ...rest } = value;
    return {
      ...rest,
      type: "function_call",
      arguments: JSON.stringify({ input: typeof input === "string" ? input : "" }),
    };
  }

  if (value.type === "custom_tool_call_output" && typeof value.call_id === "string" && callIds.has(value.call_id)) {
    return { ...value, type: "function_call_output" };
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const rewritten = key === "tool_choice"
      ? rewriteToolChoiceForUpstream(entry, names)
      : rewriteForUpstream(entry, names, callIds);
    next[key] = rewritten;
    changed ||= rewritten !== entry;
  }
  return changed ? next : value;
}

/** Names of bare Responses custom tools that xAI must receive as ordinary functions. */
export function xaiResponsesCustomToolNames(body: unknown): Set<string> {
  const names = new Set<string>();
  collectBareCustomToolNames(body, names);
  return names;
}

/** Lower bare Responses custom tools to functions for xAI, preserving enough metadata to restore calls. */
export function lowerXaiResponsesCustomTools(body: unknown): { body: unknown; names: Set<string> } {
  const names = xaiResponsesCustomToolNames(body);
  if (names.size === 0) return { body, names };
  const callIds = new Set<string>();
  collectConvertedCallIds(body, names, callIds);
  return { body: rewriteForUpstream(body, names, callIds), names };
}

function customItemId(id: unknown): unknown {
  return typeof id === "string" && id.startsWith("fc_") ? `ctc_${id.slice(3)}` : id;
}

function unwrapInput(argumentsText: unknown): string {
  if (typeof argumentsText !== "string") return "";
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (isPlainObject(parsed) && typeof parsed.input === "string") return parsed.input;
  } catch {
    // Provider may return raw input; preserve it.
  }
  return argumentsText;
}

function restoreItem(item: unknown, names: ReadonlySet<string>): unknown {
  if (!isPlainObject(item) || (item.type !== "function_call" && item.type !== "custom_tool_call")) return item;
  if (typeof item.name !== "string" || !names.has(item.name)) return item;
  const sourceInput = item.type === "function_call" ? item.arguments : item.input;
  const restored: Record<string, unknown> = {
    ...item,
    type: "custom_tool_call",
    id: customItemId(item.id),
    input: unwrapInput(sourceInput),
  };
  delete restored.arguments;
  return restored;
}

function restorePayload(value: unknown, names: ReadonlySet<string>): unknown {
  if (!isPlainObject(value)) return value;
  let changed = false;
  const next: Record<string, unknown> = { ...value };

  if (Array.isArray(value.output)) {
    const output = value.output.map(item => {
      const restored = restoreItem(item, names);
      changed ||= restored !== item;
      return restored;
    });
    if (changed) next.output = output;
  }

  if ((value.type === "response.output_item.added" || value.type === "response.output_item.done") && isPlainObject(value.item)) {
    const restored = restoreItem(value.item, names);
    if (restored !== value.item) {
      next.item = restored;
      changed = true;
    }
  }

  if (typeof value.type === "string" && value.type.startsWith("response.") && isPlainObject(value.response)) {
    const restored = restorePayload(value.response, names);
    if (restored !== value.response) {
      next.response = restored;
      changed = true;
    }
  }
  return changed ? next : value;
}

/** Restore converted calls in a non-streaming Responses JSON body. */
export function restoreXaiCustomCallsInJson(text: string, names: ReadonlySet<string>): string {
  if (names.size === 0) return text;
  try {
    const parsed = JSON.parse(text) as unknown;
    const restored = restorePayload(parsed, names);
    return restored === parsed ? text : JSON.stringify(restored);
  } catch {
    return text;
  }
}

/**
 * Client-facing SSE rewrite. Argument deltas stay preview-only: until the `{input:string}` wrapper
 * becomes valid JSON they are emitted as empty custom-input deltas, then the done frame and final
 * item carry the authoritative raw input. This avoids leaking wrapper JSON while keeping the event
 * sequence valid for Codex.
 */
export function createXaiCustomToolPayloadRewrite(names: ReadonlySet<string>): SsePayloadRewrite | undefined {
  if (names.size === 0) return undefined;
  const itemIds = new Map<string, string>();
  const convertedItemIds = new Set<string>();
  return (payload: string): string => {
    if (payload === "[DONE]") return payload;
    let value: unknown;
    try { value = JSON.parse(payload); } catch { return payload; }
    if (!isPlainObject(value)) return payload;

    if ((value.type === "response.output_item.added" || value.type === "response.output_item.done") && isPlainObject(value.item)) {
      const item = value.item;
      if ((item.type === "function_call" || item.type === "custom_tool_call") && typeof item.name === "string" && names.has(item.name)) {
        const oldId = typeof item.id === "string" ? item.id : undefined;
        const newId = customItemId(oldId);
        if (oldId && typeof newId === "string") {
          itemIds.set(oldId, newId);
          convertedItemIds.add(oldId);
        }
      }
    }

    if (value.type === "response.function_call_arguments.delta") {
      const itemId = typeof value.item_id === "string" ? value.item_id : undefined;
      if (!itemId || !convertedItemIds.has(itemId)) return payload;
      return JSON.stringify({
        ...value,
        type: "response.custom_tool_call_input.delta",
        ...(itemId ? { item_id: itemIds.get(itemId) ?? customItemId(itemId) } : {}),
        delta: "",
      });
    }
    if (value.type === "response.function_call_arguments.done") {
      const itemId = typeof value.item_id === "string" ? value.item_id : undefined;
      if (!itemId || !convertedItemIds.has(itemId)) return payload;
      const input = unwrapInput(value.arguments);
      const next: Record<string, unknown> = {
        ...value,
        type: "response.custom_tool_call_input.done",
        ...(itemId ? { item_id: itemIds.get(itemId) ?? customItemId(itemId) } : {}),
        input,
      };
      delete next.arguments;
      return JSON.stringify(next);
    }

    const restored = restorePayload(value, names);
    return restored === value ? payload : JSON.stringify(restored);
  };
}
