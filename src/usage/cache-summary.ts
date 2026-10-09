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

/** One provider+model's cache effectiveness over the window. */
export interface CacheEffectivenessRow {
  provider: string;
  model: string;
  control: ProviderCachePolicy["control"];
  requestedRetention?: CacheRetention;
  /** Requests for this provider+model in the window. */
  samples: number;
  /** Requests that actually reported a cache read — the only basis for a hit ratio. */
  reportedSamples: number;
  readTokens: number;
  writeTokens: number;
  inputTokens: number;
  /** Summed read / summed inclusive input over reported samples; null when nothing reported. */
  hitRatio: number | null;
  /**
   * Context-reuse share for a provider that never reports a cache read but does expose an
   * absolute context checkpoint (Kiro): the fraction of the context not re-sent. Labelled an
   * estimate by consumers; null when no such signal exists. Never a substituted hit ratio.
   */
  estimatedReuseRatio: number | null;
  /** Longest cache-write lifetime the provider named (Bedrock `cacheDetails.ttl`). */
  observedTtl?: "5m" | "1h";
  /** "hit"/"miss" from reported reads; "unreported" for a provider that never names one. */
  status: "hit" | "miss" | "unreported";
  lastObservedAt: number;
}

interface EffectivenessAcc {
  provider: string;
  model: string;
  control: ProviderCachePolicy["control"];
  requestedRetention?: CacheRetention;
  samples: number;
  reportedSamples: number;
  readTokens: number;
  writeTokens: number;
  inputTokens: number;
  reuseContext: number;
  reuseInput: number;
  observedTtl?: "5m" | "1h";
  policyAt: number;
  lastObservedAt: number;
}

const longerTtl = (a: "5m" | "1h" | undefined, b: "5m" | "1h"): "5m" | "1h" =>
  a === "1h" || b === "1h" ? "1h" : "5m";

/**
 * Per provider+model cache effectiveness across EVERY surface over the recent window.
 *
 * Distinct from summarizeClaudeCache (one latest row for the Claude dashboard): this sums
 * read/input across the window so a hit *rate* survives, and it never draws a fabricated 0%
 * for a provider that stayed silent — such a provider is `status: "unreported"`, optionally
 * with a labelled reuse estimate when it exposes an absolute context checkpoint. The hit
 * criterion is summed identically to summarizeClaudeCache: reported read over inclusive input.
 */
export function summarizeCacheEffectiveness(
  entries: readonly PersistedUsageEntry[],
  config: OcxConfig,
  now = Date.now(),
): { generatedAt: number; rows: CacheEffectivenessRow[] } {
  const acc = new Map<string, EffectivenessAcc>();
  for (const entry of entries.slice(-2000)) {
    const key = JSON.stringify([entry.provider, entry.model]);
    let row = acc.get(key);
    if (!row) {
      row = {
        provider: entry.provider, model: entry.model, control: "unknown",
        samples: 0, reportedSamples: 0, readTokens: 0, writeTokens: 0, inputTokens: 0,
        reuseContext: 0, reuseInput: 0, policyAt: -Infinity, lastObservedAt: 0,
      };
      acc.set(key, row);
    }
    row.samples++;
    row.lastObservedAt = Math.max(row.lastObservedAt, entry.timestamp);

    // The policy recorded at request time is authoritative; only a row predating the field
    // falls back to reconstructing from the current config (same rule as summarizeClaudeCache).
    if (entry.timestamp >= row.policyAt) {
      const recorded = recordedCachePolicy(entry);
      const provider = config.providers[entry.provider];
      const policy: { control: ProviderCachePolicy["control"]; requestedRetention?: CacheRetention } =
        recorded
        ?? (provider && (!entry.attempts?.length || entry.attempts.at(-1)?.adapter === provider.adapter)
          ? providerCachePolicy(provider, config.cacheRetention)
          : { control: "unknown" as const });
      row.control = policy.control;
      row.requestedRetention = policy.requestedRetention;
      row.policyAt = entry.timestamp;
    }

    const usage = entry.usage;
    if (!usage) continue;
    const read = usage.cacheReadInputTokens ?? usage.cachedInputTokens;
    const readReported = usage.cacheTelemetry ? usage.cacheTelemetry.readReported === true : reportedCacheCount(read);
    const input = usage.inputTokens;
    const includesCache = usage.cacheTelemetry?.inputIncludesCache !== false;
    if (readReported && includesCache && reportedCacheCount(read) && reportedCacheCount(input) && input > 0 && read <= input) {
      row.reportedSamples++;
      row.readTokens += read;
      row.inputTokens += input;
      row.writeTokens += reportedCacheCount(usage.cacheCreationInputTokens) ? usage.cacheCreationInputTokens : 0;
    } else if (!readReported && reportedCacheCount(usage.contextTotalTokens) && reportedCacheCount(input)
      && usage.contextTotalTokens > input) {
      // No read was named, but an absolute checkpoint exists: the tokens the turn did not re-send.
      row.reuseContext += usage.contextTotalTokens;
      row.reuseInput += input;
    }
    if (usage.cacheWriteTtl === "5m" || usage.cacheWriteTtl === "1h") {
      row.observedTtl = row.observedTtl ? longerTtl(row.observedTtl, usage.cacheWriteTtl) : usage.cacheWriteTtl;
    }
  }

  const rows: CacheEffectivenessRow[] = [...acc.values()].map(row => {
    const hitRatio = row.reportedSamples > 0 && row.inputTokens > 0 ? row.readTokens / row.inputTokens : null;
    const estimatedReuseRatio = row.reportedSamples === 0 && row.reuseContext > 0
      ? Math.min(1, Math.max(0, 1 - row.reuseInput / row.reuseContext))
      : null;
    const status: CacheEffectivenessRow["status"] =
      row.reportedSamples === 0 ? "unreported" : row.readTokens > 0 ? "hit" : "miss";
    return {
      provider: row.provider, model: row.model, control: row.control,
      ...(row.requestedRetention !== undefined ? { requestedRetention: row.requestedRetention } : {}),
      samples: row.samples, reportedSamples: row.reportedSamples,
      readTokens: row.readTokens, writeTokens: row.writeTokens, inputTokens: row.inputTokens,
      hitRatio, estimatedReuseRatio,
      ...(row.observedTtl !== undefined ? { observedTtl: row.observedTtl } : {}),
      status, lastObservedAt: row.lastObservedAt,
    };
  }).sort((a, b) => b.readTokens - a.readTokens || a.provider.localeCompare(b.provider));

  return { generatedAt: now, rows };
}
