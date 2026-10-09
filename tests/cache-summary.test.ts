import { describe, expect, test } from "bun:test";
import { summarizeClaudeCache } from "../src/usage/cache-summary";
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
