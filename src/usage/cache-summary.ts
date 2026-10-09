import type { OcxConfig } from "../types";
import type { PersistedUsageEntry } from "./log";
import { providerCachePolicy } from "../providers/cache-policy";
import { reportedCacheCount } from "./cache-telemetry";

/** Cache observations are not expiry timestamps or retention guarantees. */
export function summarizeClaudeCache(entries: readonly PersistedUsageEntry[], config: OcxConfig, now = Date.now()) {
  const latest = new Map<string, PersistedUsageEntry>();
  for (const entry of entries.slice(-2000)) {
    if (entry.surface !== "claude") continue;
    const key = JSON.stringify([entry.provider, entry.model]);
    if (!latest.has(key) || latest.get(key)!.timestamp < entry.timestamp) latest.set(key, entry);
  }
  const rows = [...latest.values()].map(entry => {
    const provider = config.providers[entry.provider];
    const policy = provider && (!entry.attempts?.length || entry.attempts.at(-1)?.adapter === provider.adapter)
      ? providerCachePolicy(provider, config.cacheRetention) : { control: "unknown" as const };
    // Aggregate accounting includes failed attempts; display only the terminal successful attempt.
    const lastAttempt = entry.attempts?.at(-1);
    const usage = lastAttempt ? (lastAttempt.status >= 200 && lastAttempt.status < 300 ? lastAttempt.usage : undefined) : entry.usage;
    const valid = entry.status >= 200 && entry.status < 300 && !usage?.estimated;
    const read = usage?.cacheReadInputTokens ?? usage?.cachedInputTokens;
    const readTokens = valid && usage?.cacheTelemetry?.readReported && reportedCacheCount(read) ? read : null;
    const writeTokens = valid && usage?.cacheTelemetry?.writeReported && reportedCacheCount(usage.cacheCreationInputTokens) ? usage.cacheCreationInputTokens : null;
    const hitRatio = readTokens !== null && usage?.cacheTelemetry?.inputIncludesCache
      && reportedCacheCount(usage.inputTokens) && usage.inputTokens > 0 && readTokens <= usage.inputTokens
      ? readTokens / usage.inputTokens : null;
    return {
      provider: entry.provider, model: entry.model, control: policy.control,
      ...("requestedRetention" in policy ? { requestedRetention: policy.requestedRetention } : {}),
      lastObservedAt: entry.timestamp, readTokens, writeTokens,
      status: readTokens === null ? "unreported" as const : readTokens > 0 ? "hit" as const : "miss" as const,
      hitRatio, stale: now - entry.timestamp > 3600_000,
      httpStatus: entry.status,
    };
  });
  return { generatedAt: now, rows };
}
