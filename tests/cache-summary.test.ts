import { describe, expect, test } from "bun:test";
import { summarizeCacheEffectiveness, summarizeClaudeCache } from "../src/usage/cache-summary";
import type { OcxConfig } from "../src/types";
import type { PersistedUsageEntry } from "../src/usage/log";
const config = { providers: {} } as OcxConfig;
const entry = (extra: Partial<PersistedUsageEntry> = {}): PersistedUsageEntry => ({ requestId: "test", timestamp: 1000, provider: "gateway", model: "model", surface: "claude", status: 200, durationMs: 1, usageStatus: "reported", ...extra });
describe("Claude cache observations", () => {
  test("legacy compatibility zero is unknown", () => {
    expect(summarizeClaudeCache([entry({ usage: { inputTokens: 100, outputTokens: 1, cachedInputTokens: 0 } })], config, 2000).rows[0].status).toBe("unreported");
  });
  test("reported hit and explicit miss are separate", () => {
    const usage = { inputTokens: 100, outputTokens: 1, cachedInputTokens: 80, cacheTelemetry: { readReported: true, writeReported: false, inputIncludesCache: true } };
    const row = summarizeClaudeCache([entry({ usage })], config, 2000).rows[0];
    expect(row.status).toBe("hit"); expect(row.hitRatio).toBe(.8); expect(row.writeTokens).toBeNull();
    expect(summarizeClaudeCache([entry({ usage: { ...usage, cachedInputTokens: 0 } })], config, 2000).rows[0].status).toBe("miss");
  });
  test("failed latest request cannot advertise a hit", () => {
    const row = summarizeClaudeCache([entry({ status: 429, usage: { inputTokens: 100, outputTokens: 1, cachedInputTokens: 80, cacheTelemetry: { readReported: true, writeReported: false, inputIncludesCache: true } } })], config, 2000).rows[0];
    expect(row.status).toBe("unreported"); expect(row.httpStatus).toBe(429);
  });
  test("excludes other surfaces and never exposes private fields", () => {
    expect(summarizeClaudeCache([entry({ surface: "claude-desktop" })], config).rows).toHaveLength(0);
    expect(JSON.stringify(summarizeClaudeCache([entry({ conversationId: "private", apiKeyId: "secret" })], config))).not.toContain("private");
  });
});
describe("cache effectiveness", () => {
  const tel = { readReported: true, writeReported: false, inputIncludesCache: true } as const;
  test("aggregates a hit rate across rows, not just the latest", () => {
    const rows = summarizeCacheEffectiveness([
      entry({ timestamp: 1, usage: { inputTokens: 100, outputTokens: 1, cachedInputTokens: 80, cacheTelemetry: tel } }),
      entry({ timestamp: 2, usage: { inputTokens: 100, outputTokens: 1, cachedInputTokens: 0, cacheTelemetry: tel } }),
    ], config, 2000).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].samples).toBe(2);
    expect(rows[0].reportedSamples).toBe(2);
    expect(rows[0].hitRatio).toBeCloseTo(0.4, 5);
    expect(rows[0].status).toBe("hit");
  });
  test("a silent provider is unreported, never a fabricated 0%", () => {
    const row = summarizeCacheEffectiveness([
      entry({ provider: "kiro", timestamp: 1, usage: { inputTokens: 220, outputTokens: 40, contextTotalTokens: 100_000 } }),
      entry({ provider: "kiro", timestamp: 2, usage: { inputTokens: 300, outputTokens: 40, contextTotalTokens: 100_300 } }),
    ], config, 2000).rows[0];
    expect(row.status).toBe("unreported");
    expect(row.hitRatio).toBeNull();
    expect(row.observedTtl).toBeUndefined();
    expect(row.estimatedReuseRatio).toBeGreaterThan(0.99);
  });
  test("the longest cache-write TTL the provider named survives", () => {
    const withTtl = (timestamp: number, cacheWriteTtl: "5m" | "1h") =>
      entry({ timestamp, usage: { inputTokens: 50, outputTokens: 1, cachedInputTokens: 10, cacheCreationInputTokens: 4, cacheWriteTtl, cacheTelemetry: { readReported: true, writeReported: true, inputIncludesCache: true } } });
    const row = summarizeCacheEffectiveness([withTtl(1, "5m"), withTtl(2, "1h")], config, 2000).rows[0];
    expect(row.observedTtl).toBe("1h");
    expect(row.writeTokens).toBe(8);
  });
  test("covers every surface and never exposes private fields", () => {
    expect(summarizeCacheEffectiveness([entry({ surface: "claude-desktop" })], config).rows).toHaveLength(1);
    expect(JSON.stringify(summarizeCacheEffectiveness([entry({ conversationId: "private", apiKeyId: "secret" })], config))).not.toContain("private");
  });
});
