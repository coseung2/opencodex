import { expect, test } from "bun:test";
import { anthropicToResponsesTranslation } from "../src/claude/inbound";

function translatedParameters(schema: Record<string, unknown>) {
  const result = anthropicToResponsesTranslation({
    model: "claude-ocx-xai--grok-4.7",
    messages: [{ role: "user", content: "fixture" }],
    max_tokens: 16,
    tools: [{ name: "Artifact", input_schema: schema }],
  });
  return (result.body.tools as Array<{ parameters: Record<string, unknown> }>)[0]!.parameters;
}

test("Claude Artifact NUL patterns retain their constraint with a portable Unicode escape", () => {
  const schema = { type: "object", properties: {
    file_path: { type: "string", pattern: "^[^\\0]*$", minLength: 1, maxLength: 1024 },
    file_paths: { type: "array", items: { type: "string", pattern: "^[^\\0]*$" } },
  } };
  const result = translatedParameters(schema);
  expect(result).toEqual({ type: "object", properties: {
    file_path: { type: "string", pattern: "^[^\\u0000]*$", minLength: 1, maxLength: 1024 },
    file_paths: { type: "array", items: { type: "string", pattern: "^[^\\u0000]*$" } },
  } });
  expect(schema.properties.file_path.pattern).toBe("^[^\\0]*$");
  const pattern = new RegExp((result.properties as typeof schema.properties).file_path.pattern, "u");
  expect(pattern.test("C:/fixture.html")).toBe(true);
  expect(pattern.test("C:/fixture\0.html")).toBe(false);
});

test("pattern rewriting visits schema positions, not names or example/constant payloads", () => {
  const data = { pattern: "^[^\\0]*$" };
  const schema = { type: "object", properties: {
    pattern: { type: "string", pattern: "\\0", default: "\\0" },
    nested: { anyOf: [{ type: "string", pattern: "\\0" }, { type: "null" }] },
  }, $defs: { pattern: { type: "string", pattern: "\\0" } },
  propertyNames: { pattern: "\\0" }, additionalProperties: { pattern: "\\0" },
  allOf: [{ properties: { example: { pattern: "\\0" } } }],
  examples: [data], const: data, enum: [data] };
  const result = translatedParameters(schema);
  expect(result).toEqual({ ...schema, properties: {
    pattern: { type: "string", pattern: "\\u0000", default: "\\0" },
    nested: { anyOf: [{ type: "string", pattern: "\\u0000" }, { type: "null" }] },
  }, $defs: { pattern: { type: "string", pattern: "\\u0000" } },
  propertyNames: { pattern: "\\u0000" }, additionalProperties: { pattern: "\\u0000" },
  allOf: [{ properties: { example: { pattern: "\\u0000" } } }] });
});

test("literal backslashes and legacy octal escapes are not rewritten as NUL", () => {
  for (const pattern of ["\\\\0", "\\01", "\\077", "\\u0000", "^[a-z]+$", "\\\\\\\\0"]) {
    expect(translatedParameters({ type: "object", properties: { path: { pattern } } }))
      .toEqual({ type: "object", properties: { path: { pattern } } });
  }
  expect(translatedParameters({ type: "object", properties: { path: { pattern: "\\\\\\0" } } }))
    .toEqual({ type: "object", properties: { path: { pattern: "\\\\\\u0000" } } });
});
