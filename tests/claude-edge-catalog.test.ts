import { expect, test } from "bun:test";
import { claudeEdgeCatalogModels } from "../src/cli/claude-edge-worker";
import { buildFirstPartyCatalog } from "../src/claude/first-party-catalog";
import { pickerPresentationModels } from "../src/claude/picker-presentation";

const now = 1000;
const catalog = buildFirstPartyCatalog([{ provider: "kiro", id: "claude-opus-5.5" }, { provider: "xai", id: "grok-4.7" }], {}, now);
const state = { schemaVersion: 1 as const, desired: true, connected: true, bindingId: "a".repeat(64), catalog };
function request(path: string, entrypoint = "claude-desktop") {
  return new Request(`https://fixture.invalid${path}`, { headers: { "user-agent": `claude-cli/2.1.295 (external, ${entrypoint})` } });
}

test("companion bootstrap publishes the same presentation ids as the Desktop picker with CLI mode off", () => {
  expect(claudeEdgeCatalogModels(request("/api/claude_cli/bootstrap"), state, false, now)).toEqual(pickerPresentationModels(catalog.models));
  expect(claudeEdgeCatalogModels(new Request("https://fixture.invalid/api/claude_cli/bootstrap", { headers: { "user-agent": "claude-code/2.1.295" } }), state, false, now)).toHaveLength(2);
});

test("standalone cc selector still requires CLI intent and cannot be seeded by Desktop", () => {
  expect(claudeEdgeCatalogModels(request("/api/model_selector/cc", "cli"), state, false, now)).toEqual([]);
  expect(claudeEdgeCatalogModels(request("/api/model_selector/cc", "cli"), state, true, now)).toHaveLength(2);
  expect(claudeEdgeCatalogModels(request("/api/model_selector/cc"), state, true, now)).toEqual([]);
});

test("bootstrap admission never invents routes while disconnected, stale, or not opted in", () => {
  const req = request("/api/claude_cli/bootstrap");
  for (const value of [null, { ...state, desired: false }, { ...state, connected: false }, { ...state, bindingId: null }, { ...state, catalog: null }]) {
    expect(claudeEdgeCatalogModels(req, value, false, now)).toEqual([]);
  }
  expect(claudeEdgeCatalogModels(req, state, false, catalog.expiresAt)).toEqual([]);
  expect(claudeEdgeCatalogModels(request("/api/providers"), state, true, now)).toEqual([]);
});
