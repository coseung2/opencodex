import { expect, test } from "bun:test";
import type { OcxProviderConfig } from "../src/types";
import { providerCachePolicy, providerCacheRetention } from "../src/providers/cache-policy";
import { parseKiroEvent } from "../src/adapters/kiro-events";
import { resolveAdapter } from "../src/server/adapter-resolve";

function provider(adapter: OcxProviderConfig["adapter"], authMode?: OcxProviderConfig["authMode"], baseUrl = "https://gateway.example"): OcxProviderConfig {
  return { adapter, authMode, baseUrl } as OcxProviderConfig;
}
test("routed Anthropic OAuth defaults consistently to long, explicit policy wins", () => {
  const p = provider("anthropic", "oauth");
  expect(providerCacheRetention(p)).toBe("long");
  for (const value of ["none", "short", "long"] as const) expect(providerCacheRetention(p, value)).toBe(value);
  expect(providerCacheRetention(provider("anthropic", "key"))).toBe("short");
});
test("shared adapter dispatch emits OAuth 1h while respecting explicit short/none", async () => {
  const p = { ...provider("anthropic", "oauth", "https://api.anthropic.com"), apiKey: "synthetic-test-token" };
  const parsed = { modelId: "claude-haiku-4-5", context: { messages: [{ role: "user" as const, content: "synthetic", timestamp: 0 }] }, stream: false, options: {} };
  const body = async (retention?: "none" | "short" | "long") => JSON.parse((await resolveAdapter(p, retention).buildRequest(parsed)).body);
  expect(JSON.stringify(await body())).toContain('"ttl":"1h"');
  expect(JSON.stringify(await body("short"))).not.toContain('"ttl":"1h"');
  expect(JSON.stringify(await body("none"))).not.toContain('"cache_control"');
});
test("unknown native/gateway paths never acquire Anthropic TTL", () => {
  for (const p of [provider("kiro"), provider("google"), provider("openai-chat"), provider("openai-responses", "forward", "https://chatgpt.com/backend-api/codex")]) {
    expect(providerCacheRetention(p, "long")).toBeUndefined();
    expect(providerCachePolicy(p, "long")).toEqual({ control: "unknown", guaranteedRetention: false });
  }
  expect(providerCachePolicy(provider("openai-chat", undefined, "https://api.x.ai/v1")).control).toBe("upstream-managed");
  expect(providerCachePolicy(provider("openai-chat", "oauth", "https://api.x.ai/v1")).control).toBe("unknown");
});
test("Kiro telemetry distinguishes absent counters from explicit zero", () => {
  const parse = (data: unknown) => parseKiroEvent("metadataEvent", new TextEncoder().encode(JSON.stringify(data)));
  const absent = parse({ stopReason: "end_turn" });
  expect(absent).toMatchObject({ cacheTelemetry: { usageReported: false, readReported: false, writeReported: false } });
  const zero = parse({ tokenUsage: { uncachedInputTokens: 10, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, totalTokens: 11 } });
  expect(zero).toMatchObject({ cacheTelemetry: { usageReported: true, readReported: true, writeReported: true }, usage: { cacheReadInputTokens: 0 } });
  const omitted = parse({ tokenUsage: { uncachedInputTokens: 10, outputTokens: 1, totalTokens: 11 } });
  expect(omitted).toMatchObject({ cacheTelemetry: { usageReported: true, readReported: false, writeReported: false } });
});
