function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function reference(schema: Record<string, unknown>, root: unknown): unknown {
  if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) return undefined;
  let target: unknown = root;
  for (const part of schema.$ref.slice(2).split("/")) {
    target = object(target) ? target[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
  }
  return target;
}

function acceptsNull(schema: unknown, root: unknown, seen = new Set<unknown>()): boolean {
  if (schema === true) return true;
  if (!object(schema)) return false;
  if (seen.has(schema)) return true;
  const next = new Set([...seen, schema]);
  if (schema.$ref !== undefined) {
    const target = reference(schema, root);
    if (target !== undefined && !acceptsNull(target, root, next)) return false;
  }
  if ("const" in schema && schema.const !== null) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(null)) return false;
  if (schema.type !== undefined && schema.type !== "null" && !(Array.isArray(schema.type) && schema.type.includes("null"))) return false;
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[key]) && !schema[key].some(branch => acceptsNull(branch, root, next))) return false;
  }
  if (Array.isArray(schema.allOf) && !schema.allOf.every(branch => acceptsNull(branch, root, next))) return false;
  if (schema.not !== undefined && acceptsNull(schema.not, root, next)) return false;
  return true;
}

function mapSchema(schema: unknown, root: unknown): unknown {
  if (!object(schema)) return schema;
  const result = { ...schema };
  for (const key of ["$defs", "definitions", "properties"]) {
    if (object(schema[key])) result[key] = Object.fromEntries(Object.entries(schema[key]).map(([name, value]) => [name, mapSchema(value, root)]));
  }
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (Array.isArray(schema[key])) result[key] = schema[key].map(value => mapSchema(value, root));
  }
  if (schema.items !== undefined) result.items = mapSchema(schema.items, root);
  if (object(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    const properties = result.properties as Record<string, unknown>;
    for (const key of Object.keys(properties)) {
      if (!required.includes(key) && !acceptsNull(schema.properties[key], root)) {
        properties[key] = { anyOf: [properties[key], { type: "null" }] };
      }
    }
    result.required = Object.keys(properties);
    result.additionalProperties = false;
  }
  return result;
}

function toolLists(body: Record<string, unknown>): unknown[][] {
  const lists: unknown[][] = [];
  if (Array.isArray(body.tools)) lists.push(body.tools);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (object(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
        lists.push(item.tools);
      }
    }
  }
  return lists;
}

function toolSearches(body: Record<string, unknown>): Record<string, unknown>[] {
  return toolLists(body)
    .flatMap(tools => tools)
    .filter((tool): tool is Record<string, unknown> => (
      object(tool) && tool.type === "tool_search" && object(tool.parameters)
    ));
}

/** Native Muse tool_search validates strict schemas even when strict:false is supplied. */
export function repairMuseToolSearchSchemas(body: unknown): unknown {
  if (!object(body)) return body;
  let changed = false;
  const repairTools = (tools: unknown[]): unknown[] => tools.map(tool => {
    if (!object(tool) || tool.type !== "tool_search" || !object(tool.parameters)) return tool;
    changed = true;
    return { ...tool, parameters: mapSchema(tool.parameters, tool.parameters) };
  });
  const result: Record<string, unknown> = { ...body };
  if (Array.isArray(body.tools)) result.tools = repairTools(body.tools);
  if (Array.isArray(body.input)) {
    result.input = body.input.map(item => (
      object(item) && item.type === "additional_tools" && Array.isArray(item.tools)
        ? { ...item, tools: repairTools(item.tools) }
        : item
    ));
  }
  return changed ? result : body;
}

function restoreArguments(value: unknown, schema: unknown, root: unknown, refs = new Set<unknown>()): unknown {
  if (!object(schema)) return value;
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
    const target = reference(schema, root);
    if (target && target !== schema && !refs.has(target)) return restoreArguments(value, target, root, new Set([...refs, schema]));
  }
  if (Array.isArray(value)) return value.map(item => restoreArguments(item, schema.items, root));
  if (!object(value) || !object(schema.properties)) return value;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const result = { ...value };
  for (const [key, child] of Object.entries(schema.properties)) {
    if (!(key in value)) continue;
    if (value[key] === null && !required.includes(key) && !acceptsNull(child, root)) delete result[key];
    else result[key] = restoreArguments(value[key], child, root);
  }
  return result;
}

/** Restore optional argument omission only in tool-search calls, never arbitrary tool/user data. */
export function createMuseToolSearchRestoreRewrite(body: unknown): ((text: string) => string) | undefined {
  if (!object(body)) return undefined;
  const searches = toolSearches(body);
  if (searches.length !== 1) return undefined;
  const schema = (searches[0] as Record<string, unknown>).parameters;
  const item = (value: unknown): unknown => {
    if (!object(value) || value.type !== "tool_search_call" || !object(value.arguments)) return value;
    return { ...value, arguments: restoreArguments(value.arguments, schema, schema) };
  };
  const response = (value: unknown): unknown => object(value) && Array.isArray(value.output)
    ? { ...value, output: value.output.map(item) } : value;
  return text => {
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return text; }
    if (!object(payload)) return text;
    let result = response(payload) as Record<string, unknown>;
    if (payload.item !== undefined) result = { ...result, item: item(payload.item) };
    if (payload.response !== undefined) result = { ...result, response: response(payload.response) };
    return JSON.stringify(result);
  };
}
