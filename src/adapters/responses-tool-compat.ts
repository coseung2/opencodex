import { createHash } from "node:crypto";

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** xAI requires an item identity for custom-tool replay, even with store:false. */
export function repairXaiCustomToolIds(body: unknown): unknown {
  if (!object(body) || !Array.isArray(body.input)) return body;
  return { ...body, input: body.input.map((item, index) => {
    if (!object(item) || item.type !== "custom_tool_call" || (typeof item.id === "string" && item.id)) return item;
    const identity = createHash("sha256").update(JSON.stringify([item.call_id, index])).digest("hex").slice(0, 32);
    return { ...item, id: `ctc_${identity}` };
  }) };
}

// Inspect schema nodes only: property names and defaults are arbitrary user data.
function hasOptionalProperties(schema: unknown): boolean {
  if (!object(schema)) return false;
  if (object(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (Object.keys(schema.properties).some(key => !required.includes(key))) return true;
    if (Object.values(schema.properties).some(hasOptionalProperties)) return true;
  }
  for (const key of ["$defs", "definitions"]) {
    if (object(schema[key]) && Object.values(schema[key]).some(hasOptionalProperties)) return true;
  }
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (Array.isArray(schema[key]) && schema[key].some(hasOptionalProperties)) return true;
  }
  return [schema.items, schema.additionalProperties].some(hasOptionalProperties);
}

/** Preserve optional arguments rather than inventing required/null arguments for the caller. */
export function relaxMuseOptionalToolSchemas(body: unknown): unknown {
  if (!object(body)) return body;
  const rewrite = (tools: unknown[]): unknown[] => tools.map(tool => {
    if (!object(tool)) return tool;
    if (tool.type === "namespace" && Array.isArray(tool.tools)) return { ...tool, tools: rewrite(tool.tools) };
    if (tool.type === "function" && tool.strict === true && hasOptionalProperties(tool.parameters)) {
      return { ...tool, strict: false };
    }
    return tool;
  });
  return {
    ...body,
    ...(Array.isArray(body.tools) ? { tools: rewrite(body.tools) } : {}),
    ...(Array.isArray(body.input) ? { input: body.input.map(item =>
      object(item) && item.type === "additional_tools" && Array.isArray(item.tools)
        ? { ...item, tools: rewrite(item.tools) } : item) } : {}),
  };
}
