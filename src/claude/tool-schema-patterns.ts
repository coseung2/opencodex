type Schema = Record<string, unknown>;
const schemaMapKeys = new Set(["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]);
const schemaKeys = new Set(["items", "additionalProperties", "additionalItems", "unevaluatedProperties", "unevaluatedItems", "contains", "propertyNames", "not", "if", "then", "else", "contentSchema"]);
const schemaArrayKeys = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const isSchema = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);

/** Python/Rust-backed schema validators reject JS's NUL escape; Unicode spelling is equivalent. */
function portablePattern(pattern: string): string {
  let out = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char !== "\\" || index + 1 === pattern.length) { out += char; continue; }
    const next = pattern[++index]!;
    // Consume every escape as a pair so literal backslashes stay literal. A digit
    // after zero denotes a legacy octal escape, not the standalone NUL escape.
    out += next === "0" && !/[0-9]/.test(pattern[index + 1] ?? "") ? "\\u0000" : `\\${next}`;
  }
  return out;
}

/** Visit schema positions only: property names and default/enum/example data are not keywords. */
export function portableToolSchemaPatterns(schema: Schema): Schema {
  const out = { ...schema };
  const pending = [{ schema, out }];
  const copySchema = (value: unknown): unknown => {
    if (!isSchema(value)) return value;
    const copy = { ...value };
    pending.push({ schema: value, out: copy });
    return copy;
  };
  while (pending.length) {
    const { schema: current, out: copy } = pending.pop()!;
    for (const [key, value] of Object.entries(current)) {
      if (key === "pattern" && typeof value === "string") copy[key] = portablePattern(value);
      else if (schemaMapKeys.has(key) && isSchema(value)) {
        copy[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, copySchema(child)]));
      } else if (schemaArrayKeys.has(key) && Array.isArray(value) || key === "items" && Array.isArray(value)) {
        copy[key] = (value as unknown[]).map(copySchema);
      } else if (schemaKeys.has(key)) copy[key] = copySchema(value);
    }
  }
  return out;
}
