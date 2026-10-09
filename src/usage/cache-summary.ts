import type { OcxConfig } from "../types";
import type { PersistedUsageEntry } from "./log";
import { providerCachePolicy, type CachePolicySnapshot, type CacheRetention, type ProviderCachePolicy } from "../providers/cache-policy";
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
    // A policy recorded when the request ran is authoritative; only fall back to
    // reconstructing from the current config when the row predates the field. The
    // reconstruction can be wrong — `entry.provider` is "combo" for combo rows, and the
    // provider's endpoint/auth/retention (or a routed Claude request's local TTL) may
    // have changed since the request that produced this row.
    const policy = recordedCachePolicy(entry)
      ?? (provider && (!entry.attempts?.length || entry.attempts.at(-1)?.adapter === provider.adapter)
        ? providerCachePolicy(provider, config.cacheRetention)
        : { control: "unknown" as const });
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

/** The policy captured at request time, entry-level first, else the terminal attempt's. */
function recordedCachePolicy(entry: PersistedUsageEntry): CachePolicySnapshot | undefined {
  return entry.cachePolicy ?? entry.attempts?.at(-1)?.cachePolicy;
}

export interface ObservedCachePolicyRow {
  provider: string;
  model: string;
  control: ProviderCachePolicy["control"];
  requestedRetention?: CacheRetention;
  lastObservedAt: number;
}

/**
 * Latest RECORDED cache policy per provider+model, across every surface.
 *
 * Only rows whose request captured a policy appear, so a consumer can tell "not observed
 * yet" apart from an answer, and absence never reads as "no caching". Nothing is
 * reconstructed from config here: the value's whole point is that it was resolved while
 * the serving provider and the request-local retention were both in scope. Keyed by
 * provider+model because a per-model wire override can pick a different adapter — and so
 * a different policy — than the provider's default.
 */
export function summarizeRecordedCachePolicies(
  entries: readonly PersistedUsageEntry[],
  now = Date.now(),
): { generatedAt: number; rows: ObservedCachePolicyRow[] } {
  const latest = new Map<string, ObservedCachePolicyRow>();
  for (const entry of entries.slice(-2000)) {
    const policy = recordedCachePolicy(entry);
    if (!policy) continue;
    const key = JSON.stringify([entry.provider, entry.model]);
    const previous = latest.get(key);
    if (previous && previous.lastObservedAt >= entry.timestamp) continue;
    latest.set(key, {
      provider: entry.provider,
      model: entry.model,
      control: policy.control,
      ...(policy.requestedRetention !== undefined ? { requestedRetention: policy.requestedRetention } : {}),
      lastObservedAt: entry.timestamp,
    });
  }
  return { generatedAt: now, rows: [...latest.values()] };
}
