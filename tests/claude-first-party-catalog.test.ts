import { describe, expect, test } from "bun:test";
import { buildFirstPartyCatalog, parseFirstPartyCatalog } from "../src/claude/first-party-catalog";

describe("first-party catalog projection", () => {
  test("readable alias round-trips provider collision and slash model ids", () => {
    const catalog = buildFirstPartyCatalog([
      { provider: "openai", id: "gpt", reasoningEfforts: ["low", "high"] },
      { provider: "other", id: "gpt", reasoningEfforts: ["high", "unsupported"] },
      { provider: "openrouter", id: "vendor/model", contextWindow: 300000 },
      { provider: "native", id: "gpt-native" },
      { provider: "anthropic", id: "claude-sonnet" },
    ], { modelMap: { "claude-opus": "openai/gpt" } }, 1000);
    expect(catalog.models).toHaveLength(4);
    expect(new Set(catalog.models.map(row => row.id)).size).toBe(4);
    expect(catalog.models[1]?.effortLevels).toEqual(["high"]);
    expect(catalog.models[2]?.route).toBe("openrouter/vendor/model");
    expect(parseFirstPartyCatalog(catalog, 1000)).toEqual(catalog);
    expect(catalog.modelMap).toEqual({ "claude-opus": "openai/gpt" });
  });
  test("revisions exclude refresh timestamps and never expose provider credentials", () => {
    const model = { provider: "mock", id: "model", apiKey: "fixture-secret", reasoningEfforts: ["high"] };
    const a = buildFirstPartyCatalog([model], {}, 1000);
    const b = buildFirstPartyCatalog([model], {}, 2000);
    expect(a.revision).toBe(b.revision);
    expect(JSON.stringify(a)).not.toContain("fixture-secret");
  });
  test("invalid remote rows fail rather than binding the wrong route", () => {
    const catalog = buildFirstPartyCatalog([{ provider: "one", id: "model" }], {}, 1000);
    expect(() => parseFirstPartyCatalog({ ...catalog, models: [{ ...catalog.models[0], route: "two/model" }] }, 1000)).toThrow("invalid_first_party_catalog");
    expect(() => parseFirstPartyCatalog({ ...catalog, revision: "0".repeat(64) }, 1000)).toThrow();
    expect(() => parseFirstPartyCatalog({ ...catalog, expiresAt: 99999999 }, 1000)).toThrow();
    expect(() => parseFirstPartyCatalog({ ...catalog, generatedAt: 99999999 }, 1000)).toThrow();
  });
});
