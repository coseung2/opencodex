import { afterEach, expect, test } from "bun:test";
import { fetchAntigravityModels, parseAntigravityModels } from "../src/providers/antigravity-live-models";
import { fetchProviderModels } from "../src/codex/catalog/provider-fetch";
import { clearModelCache, getProviderDiscoveryStatus } from "../src/codex/model-cache";
import type { OcxProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; clearModelCache("google-antigravity"); });

test("new wire IDs are discoverable without a bundled entry; only available effort variants collapse", () => {
  expect(parseAntigravityModels({ models: {
    "gemini-pro-agent": { maxTokens: 123456 }, "future-model": { maxTokens: 900000 },
  } })).toEqual({ ok: true, models: [
    { id: "gemini-3.1-pro", contextWindow: 123456, reasoningEfforts: ["high"] },
    { id: "future-model", contextWindow: 900000 },
  ] });
  expect(parseAntigravityModels({ models: { "gemini-3.1-pro-low": {} } })).toEqual({ ok: true, models: [{ id: "gemini-3.1-pro-low" }] });
});

test("malformed responses fail while an empty model map is authoritative", () => {
  for (const value of [null, {}, { models: [] }, { models: { bad: null } }, { models: { "bad\n": {} } }]) {
    expect(parseAntigravityModels(value).ok).toBe(false);
  }
  expect(parseAntigravityModels({ models: {} })).toEqual({ ok: true, models: [] });
});

test("CCA editor-only models are hidden and retired aliases share their current picker row", () => {
  const result = parseAntigravityModels({ models: {
    "gemini-3.7-flash-tiered": { supportsImages: true },
    "gemini-3.6-flash-low": { supportsImages: true },
    "tab_flash_lite_preview": {}, "chat_23310": { isInternal: true },
    "internal-provider": { apiProvider: "API_PROVIDER_INTERNAL" },
    "new-chat": { supportsImages: true, maxTokens: 123456 },
  } });
  expect(result).toEqual({ ok: true, models: [
    { id: "gemini-3.7-flash", reasoningEfforts: ["low", "medium", "high"], inputModalities: ["text", "image"] },
    { id: "new-chat", contextWindow: 123456, inputModalities: ["text", "image"] },
  ] });
});

test("CCA request uses a fixed first-party POST and rejects redirects", async () => {
  let seen = false;
  const result = await fetchAntigravityModels({ accessToken: "fixture-token", projectId: "fixture-project", fetchImpl: (async (url, init) => {
    seen = true;
    expect(String(url)).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ project: "fixture-project" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
    return Response.json({ models: { "new-model": {} } });
  }) as typeof fetch });
  expect(seen).toBe(true);
  expect(result).toEqual({ ok: true, models: [{ id: "new-model" }] });
});

test("live catalog is authoritative, cached, and survives a failed refresh with cooldown", async () => {
  const provider: OcxProviderConfig = {
    adapter: "google", authMode: "key", apiKey: "fixture-token", project: "fixture-project",
    baseUrl: "https://untrusted.invalid", liveModels: true, models: ["old-static"],
    modelReasoningEfforts: { "gemini-3.1-pro": ["low", "high"] },
  };
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ models: { "gemini-pro-agent": { maxTokens: 123456 }, "new-model": {} } }); }) as typeof fetch;
  const live = await fetchProviderModels("google-antigravity", provider, 60000);
  expect(live.map(m => m.id)).toEqual(["gemini-3.1-pro", "new-model"]);
  expect(live[0]?.reasoningEfforts).toEqual(["high"]);
  expect(await fetchProviderModels("google-antigravity", provider, 60000)).toEqual(live);
  expect(calls).toBe(1);
  globalThis.fetch = (async () => { calls++; return new Response(null, { status: 503 }); }) as typeof fetch;
  expect(await fetchProviderModels("google-antigravity", provider, 0)).toEqual(live);
  expect(await fetchProviderModels("google-antigravity", provider, 0)).toEqual(live);
  expect(calls).toBe(2);
  expect(getProviderDiscoveryStatus("google-antigravity")).toBeDefined();
  clearModelCache("google-antigravity");
  expect((await fetchProviderModels("google-antigravity", provider, 0)).map(m => m.id)).toEqual(["old-static"]);
});
