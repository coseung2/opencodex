import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { injectPickerModels, rewriteBootstrapBody, rewrittenHeaders, isPickerBootstrapRequest } from "../src/claude/intercept/picker-bootstrap";
import { pickerJsonBytes, PickerRewriteBudget } from "../src/claude/intercept/picker-budget";
const native = { id: "claude-fixture", name: "Native", section: "main", effort_levels: ["low", "medium", "high"], disabled: false, badge: "native", version: "fixture" };
const model = { id: "ocx/fixture", name: "Fixture", contextWindow: 100000, effortLevels: ["high", "max"] };
function body() { return { model_selector_config: ["chat", "ccr", "ccd", "code"].map(id => ({ id, models: [{ ...native }] })) }; }
test("only local Code surfaces gain rows and effort vocabulary is intersected", () => {
  const doc = body(); expect(injectPickerModels(doc, [model, model])).toBe(2);
  expect(doc.model_selector_config[0]!.models).toEqual([native]); expect(doc.model_selector_config[1]!.models).toEqual([native]);
  for (const row of doc.model_selector_config.slice(2)) {
    expect(row.models[0]).toEqual(native);
    expect(row.models[1]).toEqual({ id: model.id, name: model.name, section: "main", context_window: 100000, effort_levels: ["high"] });
  }
  expect(injectPickerModels(doc, [model])).toBe(0);
});
test("native thinking effort menu is narrowed without modifying native rows", () => {
  const original = { id: "claude-fixture", name: "Native", thinking: { effort_options: [
    { id: "low", label: "Low", recommended: true }, { id: "high", label: "High" }, { id: "max", label: "Max" },
  ] } };
  const doc = { model_selector_config: [{ id: "ccd", models: [structuredClone(original)] }] };
  expect(injectPickerModels(doc, [{ ...model, effortLevels: ["low", "high"] }])).toBe(1);
  expect(doc.model_selector_config[0]!.models[0]).toEqual(original);
  expect((doc.model_selector_config[0]!.models[1] as unknown as typeof original).thinking.effort_options).toEqual([
    { id: "low", label: "Low" }, { id: "high", label: "High", recommended: true },
  ]);
  const noEffort = { model_selector_config: [{ id: "ccd", models: [structuredClone(original)] }] };
  expect(injectPickerModels(noEffort, [{ ...model, effortLevels: [] }])).toBe(1);
  expect(noEffort.model_selector_config[0]!.models[1]).not.toHaveProperty("thinking");
});
test("unknown target shape and oversized additions rollback every surface", () => {
  const doc = body(); (doc.model_selector_config[3] as unknown as { models: unknown }).models = {};
  const before = JSON.stringify(doc); expect(injectPickerModels(doc, [model])).toBe(0); expect(JSON.stringify(doc)).toBe(before);
  const large = body(), original = JSON.stringify(large);
  expect(injectPickerModels(large, [{ ...model, name: "x".repeat(70000) }])).toBe(0); expect(JSON.stringify(large)).toBe(original);
});
test("encoded transforms return identity JSON; unknown encoding or invalid UTF8 leaves bytes untouched", () => {
  const input = Buffer.from(JSON.stringify(body()));
  const output = rewriteBootstrapBody(gzipSync(input), "gzip", [model]); expect(output).not.toBeNull();
  expect(JSON.parse(output!.toString()).model_selector_config[2].models).toHaveLength(2);
  expect(rewriteBootstrapBody(input, "zstd", [model])).toBeNull();
  expect(rewriteBootstrapBody(Buffer.from([255]), "identity", [model])).toBeNull();
  expect(rewriteBootstrapBody(Buffer.from("{}"), "identity", [model])).toBeNull();
  expect(rewrittenHeaders(["ETag", "old", "Content-Encoding", "gzip", "X-Fixture", "kept"], 12)).toEqual(["X-Fixture", "kept", "Content-Length", "12"]);
});
test("bounds reject cyclic/deep graphs, excessive rows and encoded bodies", () => {
  const cycle: unknown[] = []; cycle.push(cycle); expect(() => pickerJsonBytes(cycle, 100)).toThrow();
  expect(() => new PickerRewriteBudget({ key: "x".repeat(17 * 1024 * 1024) })).toThrow();
  expect(rewriteBootstrapBody(Buffer.alloc(4 * 1024 * 1024 + 1), "identity", [model])).toBeNull();
  expect(isPickerBootstrapRequest("GET", "/api/bootstrap/fixture/app_start")).toBe(true);
  expect(isPickerBootstrapRequest("POST", "/api/bootstrap")).toBe(false);
});
