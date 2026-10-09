import { afterEach, describe, expect, test } from "bun:test";
import { gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import { providerConfigSeed } from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";
import { parseAntigravityModels } from "../src/providers/antigravity-live-models";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("google-antigravity");
});

describe("Google Antigravity static catalog", () => {
  test("parses the CCA response into picker models and context windows", () => {
    const result = parseAntigravityModels({
      models: {
        "gemini-3.7-flash-tiered": { maxTokens: 900_000 },
        "gemini-3.1-pro-low": { maxTokens: 800_000 },
        "gemini-pro-agent": { maxTokens: 800_000 },
        "claude-sonnet-4-6": { maxTokens: 200_000 },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid response");
    expect(result.models.map(model => model.id).sort()).toEqual([
      "claude-sonnet-4-6", "gemini-3.1-pro", "gemini-3.7-flash",
    ]);
    expect(result.models.find(model => model.id === "gemini-3.7-flash")?.contextWindow).toBe(900_000);
  });

  test("explicit opt-out surfaces the fallback models without live discovery", async () => {
    const entry = PROVIDER_REGISTRY.find(provider => provider.id === "google-antigravity")!;
    const staticModels = entry.models!;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      return Promise.resolve(Response.json({ data: [{ id: "unexpected-live-model" }] }));
    }) as typeof fetch;

    const models = await gatherRoutedModels(withStubbedProviderFetch({
      providers: {
        "google-antigravity": {
          ...providerConfigSeed(entry),
          liveModels: false,
          authMode: "key",
          apiKey: "test-token",
        },
      },
    }));

    expect(fetchCalls).toBe(0);
    expect(models.filter(model => model.provider === entry.id).map(model => model.id).sort()).toEqual([...staticModels].sort());
  });
});
