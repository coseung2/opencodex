import { expect, test } from "bun:test";
import { claudeCliCatalogKind, claudeCliCatalogEligible, rewriteClaudeCliCatalog } from "../src/claude/cli-catalog";
import { pickerPresentationModels } from "../src/claude/picker-presentation";
const model = { id: "claude-ocx-fixture--model", name: "Fixture", effortLevels: ["high"] };
test("first-party presentation uses an effort-capable native family without losing its source route", () => {
  const rows = pickerPresentationModels([{ ...model, route: "fixture/model" }]);
  expect(rows[0]!.id).toMatch(/^claude-opus-4-8-[a-z][0-9a-z]{2}$/);
  expect(rows[0]!.sourceId).toBe(model.id);
  expect(rows[0]!.route).toBe("fixture/model");
});

test("colliding presentation codes are withheld instead of routing to the wrong model", () => {
  const seen = new Map<string, string>();
  let collision: string[] | undefined;
  for (let index = 0; index < 5000 && !collision; index++) {
    const route = `fixture/model-${index}`;
    const [row] = pickerPresentationModels([{ ...model, route }]);
    const previous = seen.get(row!.id);
    if (previous) collision = [previous, route];
    else seen.set(row!.id, route);
  }
  expect(collision).toBeDefined();
  expect(pickerPresentationModels(collision!.map(route => ({ ...model, route })))).toEqual([]);
});
test("CLI catalog paths and entrypoints do not claim Desktop or management requests", () => {
  expect(claudeCliCatalogKind("GET", "/api/organizations/fixture/model_selector/cc")).toBe("selector");
  expect(claudeCliCatalogKind("GET", "/api/claude_cli/bootstrap")).toBe("bootstrap");
  for (const path of ["/api/model_selector/ccd", "/api/providers", "/api/bootstrap"]) expect(claudeCliCatalogKind("GET", path)).toBeNull();
  for (const ua of ["claude-code/2.1.278", "claude-cli/2.1.278 (external, cli)"]) expect(claudeCliCatalogEligible(new Request("https://fixture.invalid", { headers: { "user-agent": ua } }))).toBe(true);
  expect(claudeCliCatalogEligible(new Request("https://fixture.invalid", { headers: { "user-agent": "claude-cli/2.1.278 (external, claude-desktop)" } }))).toBe(false);
});
test("CLI served catalog uses effort-capable native template without rewriting Desktop", () => {
  const surfaces = ["cc", "ccd", "ccr"].map(id => ({ id, models: [
    { id: "claude-haiku", name: "Haiku" },
    { id: "claude-opus", name: "Opus", thinking: { effort_options: [{ id: "low" }, { id: "high" }] } },
  ] }));
  const original = Buffer.from(JSON.stringify({ model_selector_config: surfaces }));
  const output = rewriteClaudeCliCatalog(original, null, "selector", [model, model]);
  const result = JSON.parse(output!.toString());
  expect(result.model_selector_config.map((surface: { models: unknown[] }) => surface.models.length)).toEqual([3, 2, 2]);
  expect(result.model_selector_config[0].models[2].thinking.effort_options).toEqual([{ id: "high" }]);
  expect(JSON.parse(original.toString()).model_selector_config[0].models).toHaveLength(2);
});
test("fallback bootstrap options deduplicate and unknown shapes remain unchanged", () => {
  const output = rewriteClaudeCliCatalog(Buffer.from('{}'), null, "bootstrap", [model, model]);
  expect(JSON.parse(output!.toString()).additional_model_options).toHaveLength(1);
  expect(rewriteClaudeCliCatalog(Buffer.from('{"additional_model_options":{}}'), null, "bootstrap", [model])).toBeNull();
  expect(rewriteClaudeCliCatalog(Buffer.from('{}'), null, "selector", [model])).toBeNull();
  expect(rewriteClaudeCliCatalog(Buffer.from('{}'), "zstd", "bootstrap", [model])).toBeNull();
});
