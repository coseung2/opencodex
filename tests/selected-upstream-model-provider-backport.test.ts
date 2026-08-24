import { describe, expect, test } from "bun:test";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_MODEL_CONTEXT_WINDOWS,
  ANTIGRAVITY_MODEL_EFFORTS,
  ANTIGRAVITY_MODEL_INPUT_MODALITIES,
  resolveAntigravityEffortWireModel,
} from "../src/providers/antigravity-models";
import { catalogHintsFromModelsApiItem } from "../src/codex/catalog/provider-fetch";
import {
  NATIVE_DAYBREAK_BLUE_MODEL,
  NATIVE_GPT56_CONTEXT_WINDOW,
  NATIVE_GPT56_MAX_INPUT_TOKENS,
  NATIVE_OPENAI_MODELS,
  nativeOpenAiContextWindow,
  nativeOpenAiMaxInputTokens,
  upstreamNativeEntry,
} from "../src/codex/catalog/metadata";
import { applyNativeOpenAiContextOverride } from "../src/codex/catalog/parsing";
import { projectModelRenames } from "../src/providers/model-rename-migration";
import { providerModelMatchesDiscoveryFilter } from "../src/providers/model-discovery";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { OcxConfig } from "../src/types";

function provider(id: string) {
  const entry = PROVIDER_REGISTRY.find(row => row.id === id);
  if (!entry) throw new Error(`missing provider ${id}`);
  return entry;
}

describe("selected upstream model metadata", () => {
  test("native GPT-5.6 and Daybreak advertise the measured 1.05M contract safely", () => {
    expect(NATIVE_GPT56_CONTEXT_WINDOW).toBe(1_050_000);
    expect(NATIVE_GPT56_MAX_INPUT_TOKENS).toBe(922_000);
    expect(NATIVE_OPENAI_MODELS).toContain(NATIVE_DAYBREAK_BLUE_MODEL);
    expect(nativeOpenAiContextWindow(NATIVE_DAYBREAK_BLUE_MODEL)).toBe(1_050_000);
    expect(nativeOpenAiMaxInputTokens(NATIVE_DAYBREAK_BLUE_MODEL)).toBe(922_000);
    expect(upstreamNativeEntry(NATIVE_DAYBREAK_BLUE_MODEL)).toMatchObject({
      slug: NATIVE_DAYBREAK_BLUE_MODEL,
      input_modalities: ["text", "image"],
    });

    const row = { slug: "gpt-5.6-sol" };
    applyNativeOpenAiContextOverride(row);
    expect(row).toMatchObject({
      context_window: 1_050_000,
      max_context_window: 1_050_000,
      auto_compact_token_limit: 922_000,
    });
  });

  test("GLM-5.3 keeps its published three-tier contract", () => {
    const zai = provider("zai");
    expect(zai.defaultModel).toBe("glm-5.3");
    expect(zai.models).toEqual(expect.arrayContaining(["glm-5.3", "glm-5.3[1m]"]));
    expect(zai.modelReasoningEfforts?.["glm-5.3"]).toEqual(["low", "high", "max"]);
    expect(zai.modelDefaultReasoningEfforts?.["glm-5.3"]).toBe("max");
    expect(zai.modelMaxOutputTokens?.["glm-5.3"]).toBe(131_072);

    expect(catalogHintsFromModelsApiItem("zai", {
      id: "glm-5.3",
      capabilities: { reasoning_effort: true },
    }).reasoningEfforts).toEqual(["low", "high", "max"]);
  });

  test("Grok 4.6 exposes xhigh without changing Grok 4.5", () => {
    const xai = provider("xai");
    expect(xai.modelReasoningEfforts?.["grok-4.6"]).toEqual(["low", "medium", "high", "xhigh"]);
    expect(xai.modelDefaultReasoningEfforts?.["grok-4.6"]).toBe("high");
    expect(xai.modelReasoningEfforts?.["grok-4.5"]).toEqual(["low", "medium", "high"]);
  });

  test("Ox Alpha and DeepSeek vision preview have bounded multimodal metadata", () => {
    const openrouter = provider("openrouter");
    expect(openrouter.models).toContain("stealth/ox-alpha");
    expect(openrouter.modelContextWindows?.["stealth/ox-alpha"]).toBe(1_048_576);
    expect(openrouter.modelInputModalities?.["stealth/ox-alpha"]).toEqual(["text", "image"]);

    const deepseek = provider("deepseek");
    expect(deepseek.models).toContain("deepseek-v4-flash-vision-exp");
    expect(deepseek.modelContextWindows?.["deepseek-v4-flash-vision-exp"]).toBe(1_048_576);
    expect(deepseek.modelInputModalities?.["deepseek-v4-flash-vision-exp"]).toEqual(["text", "image"]);
    expect(deepseek.noVisionModels).not.toContain("deepseek-v4-flash-vision-exp");
  });

  test("OpenCode rows receive metadata only and keep live discovery identities", () => {
    for (const id of ["opencode-go", "opencode-free", "opencode-zen"]) {
      const entry = provider(id);
      expect(entry.models).toBeUndefined();
      expect(entry.modelContextWindows?.["x-preview-f-free"]).toBe(1_048_576);
      expect(entry.modelInputModalities?.["deepseek-v4-flash-vision-exp"]).toEqual(["text", "image"]);
    }
  });
});

describe("Gemini 3.7 Flash replacement", () => {
  test("fresh state exposes only the current Flash generation and preserves effort", () => {
    expect(ANTIGRAVITY_MODELS).toContain("gemini-3.7-flash");
    expect(ANTIGRAVITY_MODELS).not.toContain("gemini-3.6-flash");
    expect(ANTIGRAVITY_MODEL_CONTEXT_WINDOWS["gemini-3.7-flash"]).toBe(1_048_576);
    expect(ANTIGRAVITY_MODEL_EFFORTS["gemini-3.7-flash"]).toEqual(["low", "medium", "high"]);
    expect(ANTIGRAVITY_MODEL_INPUT_MODALITIES["gemini-3.7-flash"]).toEqual(["text", "image"]);
    expect(resolveAntigravityEffortWireModel("gemini-3.7-flash")).toEqual({
      wireModelId: "gemini-3.7-flash",
      thinkingLevel: "medium",
    });
    expect(resolveAntigravityEffortWireModel("gemini-3.6-flash-low")).toEqual({
      wireModelId: "gemini-3.7-flash",
      thinkingLevel: "low",
    });
  });

  test("rename projection repairs allowlists and drops dead wire effort maps", () => {
    const config = {
      port: 10100,
      defaultProvider: "google-antigravity",
      disabledModels: ["google-antigravity/gemini-3.6-flash-low"],
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          models: ["gemini-3.6-flash-low"],
          selectedModels: ["gemini-3.6-flash-low"],
          defaultModel: "gemini-3.6-flash-low",
          modelReasoningEffortMap: { "gemini-3.6-flash-low": { high: "gemini-3.6-flash-high" } },
        },
      },
    } as OcxConfig;

    const projected = projectModelRenames(config);
    expect(projected.changed).toBe(true);
    expect(projected.config.providers["google-antigravity"]?.models).toEqual(["gemini-3.7-flash"]);
    expect(projected.config.providers["google-antigravity"]?.selectedModels).toEqual(["gemini-3.7-flash"]);
    expect(projected.config.providers["google-antigravity"]?.defaultModel).toBe("gemini-3.7-flash");
    expect(projected.config.providers["google-antigravity"]?.modelReasoningEffortMap).toEqual({});
    expect(projected.config.disabledModels).toEqual([]);
  });
});

describe("bounded provider presets", () => {
  test("only registry-compatible selected presets are installed", () => {
    const installed = ["nebius", "digitalocean", "scaleway", "nscale", "vultr"];
    for (const id of installed) {
      const entry = provider(id);
      expect(entry.liveModels).toBe(true);
      expect(entry.preserveCustomDestination).toBe(true);
      expect(entry.parallelToolCalls).toBe(false);
      expect(entry.reasoningEfforts).toEqual([]);
      expect(entry.modelDiscovery).toBeDefined();
    }
    for (const deferred of ["sambanova", "chutes", "featherless", "novita", "nous"]) {
      expect(PROVIDER_REGISTRY.some(row => row.id === deferred)).toBe(false);
    }
  });

  test("provider filters reject unsupported mixed-catalog rows", () => {
    expect(providerModelMatchesDiscoveryFilter(
      { id: "meta-llama/Llama-3.1-8B-Instruct" },
      provider("nscale").modelDiscovery!.filter,
    )).toBe(true);
    expect(providerModelMatchesDiscoveryFilter(
      { id: "embedding-model" },
      provider("nscale").modelDiscovery!.filter,
    )).toBe(false);
    expect(providerModelMatchesDiscoveryFilter(
      { id: "text-model", architecture: { modality: "text+image->text" } },
      provider("nebius").modelDiscovery!.filter,
    )).toBe(true);
    expect(providerModelMatchesDiscoveryFilter(
      { id: "image-model", architecture: { modality: "text->image" } },
      provider("nebius").modelDiscovery!.filter,
    )).toBe(false);
    expect(catalogHintsFromModelsApiItem("nebius", {
      id: "vision-model",
      architecture: { modality: "text+image->text" },
    }).inputModalities).toEqual(["text", "image"]);
  });
});
