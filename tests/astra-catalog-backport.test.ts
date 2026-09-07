import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NATIVE_GPT6_ASTRA_MODEL as ASTRA,
  UPSTREAM_NATIVE_ENTRIES,
  nativeDefaultReasoningEffort,
  nativeOpenAiContextWindow,
  nativeOpenAiMaxInputTokens,
  nativeReasoningEfforts,
  upstreamNativeEntry,
  shouldUpgradeToUpstreamEntry,
} from "../src/codex/catalog/metadata";
import { nativeEffortClamp } from "../src/codex/catalog/effort";
import { normalizeRoutedCatalogEntry, normalizeServiceTiers } from "../src/codex/catalog/parsing";
import { buildCatalogEntries, mergeCatalogEntriesForSync, resetCatalogRuntimeStateForTests } from "../src/codex/catalog/sync";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { resolveMatchedPrice, estimateRequestCost } from "../src/usage/cost";
import type { OcxConfig } from "../src/types";

const priorHome = process.env.CODEX_HOME;
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-astra-catalog-"));
  process.env.CODEX_HOME = home;
  resetCatalogRuntimeStateForTests();
});
afterEach(() => {
  resetCatalogRuntimeStateForTests();
  if (priorHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});

function config(window?: number, cap?: number): OcxConfig {
  return {
    providers: { openai: {
      adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex",
      ...(window === undefined ? {} : { modelContextWindows: { [ASTRA]: window } }),
    } },
    ...(cap === undefined ? {} : { providerContextCaps: { openai: cap } }),
  } as OcxConfig;
}

const ladder = ["low", "medium", "high", "xhigh", "max", "ultra"];

describe("Astra self-described native contract", () => {
  test("uses its own pinned identity, default, tool mode and complete ladder", () => {
    const row = upstreamNativeEntry(ASTRA);
    expect(row).toMatchObject({ slug: ASTRA, display_name: "GPT-6-Astra", default_reasoning_level: "low", tool_mode: "code_mode_only", multi_agent_version: "v2", multi_agent_reasoning_effort: "xhigh", context_window: 272_000, max_context_window: 872_000 });
    expect(row?.base_instructions).toContain("based on GPT-6.");
    expect(row?.minimal_client_version).toBeUndefined();
    expect(nativeReasoningEfforts(ASTRA)).toEqual(ladder);
    expect(nativeDefaultReasoningEffort(ASTRA)).toBe("low");
    expect(nativeEffortClamp(ASTRA, "max")).toBeNull();
    expect(nativeEffortClamp(ASTRA, "ultra")).toBeNull();
    expect(nativeEffortClamp("gpt-5.5", "ultra")).toBe("xhigh");
    for (const slug of ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]) expect(UPSTREAM_NATIVE_ENTRIES.has(slug)).toBe(false);
  });

  test("native clones are independent and Fast keeps the corrected label", () => {
    const row = upstreamNativeEntry(ASTRA)!;
    expect(row).not.toBeNull();
    expect(row.service_tiers).toEqual([{ id: "priority", name: "Fast", description: "2x speed, increased usage" }]);
    row.display_name = "changed";
    expect(upstreamNativeEntry(ASTRA)?.display_name).toBe("GPT-6-Astra");
    const old = normalizeServiceTiers({ slug: ASTRA, service_tiers: [{ id: "priority", description: "1.5x speed, increased usage" }] });
    expect(old.service_tiers[0].description).toBe("2x speed, increased usage");
    const custom = normalizeServiceTiers({ slug: ASTRA, service_tiers: [{ id: "priority", description: "my label" }] });
    expect(custom.service_tiers[0].description).toBe("my label");
  });

  test("ordinary build and persisted placeholder repair retain native capabilities", () => {
    const built = buildCatalogEntries(null, [ASTRA], [], ["gpt-5.5", ASTRA]);
    expect(built[0]).toMatchObject({ slug: ASTRA, priority: 1, default_reasoning_level: "low", use_responses_lite: true });
    expect(built[0].supported_reasoning_levels.map((row: { effort: string }) => row.effort)).toEqual(ladder);
    expect(built[0].prefer_websockets).toBeUndefined();
    const merged = mergeCatalogEntriesForSync([{ slug: ASTRA, display_name: ASTRA, priority: 9 }], [], new Map(), [], false);
    expect(merged.find(row => row.slug === ASTRA)).toMatchObject({ display_name: "GPT-6-Astra", default_reasoning_level: "low", visibility: "list" });
    expect(shouldUpgradeToUpstreamEntry({ slug: ASTRA, display_name: "My own model label" })).toBe(false);
  });

  test("routed clones never inherit Astra's native-only tool and delegation fields", () => {
    const native = upstreamNativeEntry(ASTRA)!;
    expect(native).not.toBeNull();
    const routed = normalizeRoutedCatalogEntry({ ...native, slug: "other/model" });
    expect(routed.multi_agent_reasoning_effort).toBeUndefined();
    expect(routed.multi_agent_version).toBeUndefined();
    expect(routed.tool_mode).toBeUndefined();
    expect(routed.model_messages).toBeUndefined();
  });

  test("long-window selection is Astra-scoped and never exceeds its own ceiling", () => {
    expect(nativeOpenAiContextWindow(ASTRA)).toBe(272_000);
    expect(nativeOpenAiMaxInputTokens(ASTRA)).toBe(272_000);
    expect(nativeOpenAiContextWindow(ASTRA, config(undefined, 922_000))).toBe(872_000);
    expect(nativeOpenAiContextWindow(ASTRA, config(400_000, 922_000))).toBe(400_000);
    expect(nativeOpenAiContextWindow(ASTRA, config(872_000, 120_000))).toBe(120_000);
    expect(nativeOpenAiMaxInputTokens(ASTRA, config(400_000, 922_000))).toBe(400_000);
    // This backport deliberately preserves the fork's existing GPT-5.6 policy.
    expect(nativeOpenAiContextWindow("gpt-5.6-sol", config(undefined, 922_000))).toBe(1_050_000);
    const built = buildCatalogEntries(null, [ASTRA], [], [], false, "default", new Set(), config(undefined, 922_000));
    expect(built[0].context_window).toBe(872_000);
    expect(built[0].auto_compact_token_limit).toBe(784_800);
  });
});

describe("Astra API and price boundaries", () => {
  test("API metadata does not borrow the Codex-native ultra ladder", () => {
    const api = getProviderRegistryEntry("openai-apikey")!;
    expect(api.models).toContain(ASTRA);
    expect(api.modelReasoningEfforts?.[ASTRA]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(api.modelContextWindows?.[ASTRA]).toBe(1_050_000);
    expect(api.modelMaxInputTokens?.[ASTRA]).toBe(922_000);
    expect(api.modelInputModalities?.[ASTRA]).toEqual(["text", "image"]);
  });

  test("native dollar estimates carry API-reference provenance, not subscription billing", () => {
    expect(resolveMatchedPrice("openai", ASTRA)).toMatchObject({ status: "verified-derived", cost4: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } });
    expect(resolveMatchedPrice("openai-apikey", ASTRA)?.status).toBe("verified");
  });

  test("Astra long-context and Fast rates compose without repricing other providers", () => {
    const estimate = (provider: string, inputTokens: number, serviceTier?: string) => estimateRequestCost({
      provider, model: ASTRA, usage: { inputTokens, outputTokens: 1000, totalTokens: inputTokens + 1000 }, usageStatus: "reported", serviceTier,
    });
    expect(estimate("openai-apikey", 272_000)?.cost.total).toBeCloseTo(2.77);
    expect(estimate("openai-apikey", 272_001)?.cost.total).toBeCloseTo(5.51502);
    expect(estimate("openai-apikey", 272_001, "priority")?.cost.total).toBeCloseTo(11.03004);
    expect(estimate("openai", 272_001, "priority")?.estimated).toBe(true);
    expect(resolveMatchedPrice("unrelated-reseller", ASTRA)).toBeNull();
  });
});
