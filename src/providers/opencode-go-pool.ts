import { createHash } from "node:crypto";
import { getConfigDir, resolveEnvValue, saveConfigPreservingClaudeCode } from "../config";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { getKeyCooldownUntil, hasKeyPoolFailover, recordKeyQuotaExhaustion } from "./key-failover";
import type { fetchOpencodeGoUsageApi } from "./quota";

type Usage = Awaited<ReturnType<typeof fetchOpencodeGoUsageApi>>;
type Observation = { until: number; value: Promise<Usage> };
const observations = new Map<string, Observation>();
const CACHE_MS = 15_000;
const MAX_ENTRIES = 128;
const PROBE_TIMEOUT_MS = 2_000;
const MAX_PROBES = 8;

export function isOpenCodeGoKeyDestination(provider: OcxProviderConfig): boolean {
  if (provider.authMode === "oauth" || provider.authMode === "forward") return false;
  try {
    const url = new URL(provider.baseUrl);
    return url.origin === "https://opencode.ai" && url.pathname.replace(/\/+$/, "") === "/zen/go/v1"
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function resolvedKey(value: string | undefined): string | undefined {
  return resolveEnvValue(value)?.trim() || undefined;
}

/** No raw keys in cache identifiers; homes and destinations never share observations. */
function cacheId(providerName: string, key: string): string {
  return createHash("sha256").update(JSON.stringify([getConfigDir(), providerName, key])).digest("hex");
}

async function observe(providerName: string, key: string): Promise<Usage> {
  const id = cacheId(providerName, key);
  const now = Date.now();
  const cached = observations.get(id);
  if (cached && cached.until > now) return cached.value;
  for (const [entryId, entry] of observations) if (entry.until <= now) observations.delete(entryId);
  while (observations.size >= MAX_ENTRIES) observations.delete(observations.keys().next().value!);
  // Lazy import avoids adding the quota dashboard's auth graph to provider initialization.
  const value = import("./quota").then(module => module.fetchOpencodeGoUsageApi(key, PROBE_TIMEOUT_MS)).catch(() => null);
  observations.set(id, { until: now + CACHE_MS, value });
  return value;
}

function exhaustedUntil(usage: Usage, now: number): number | undefined {
  if (!usage) return undefined;
  let until: number | undefined;
  for (const window of [usage.fiveHour, usage.weekly, usage.monthly]) {
    if (window.percent === undefined || window.percent < 100) continue;
    if (window.resetAt !== undefined && window.resetAt <= now) continue;
    // All full windows must recover, not just the first one to reset.
    until = Math.max(until ?? 0, window.resetAt ?? now + CACHE_MS);
  }
  return until;
}

export type OpenCodeGoPoolSelection<T> = { provider: T; unavailable?: false }
  | { unavailable: true; retryAfterSeconds: number; configurationChanged?: boolean };

/** Use authoritative Go allocation only. Estimates and failed probes cannot exclude a key. */
export async function selectOpenCodeGoPoolKey<T extends OcxProviderConfig>(
  config: OcxConfig,
  providerName: string,
  provider: T,
  signal?: AbortSignal,
): Promise<OpenCodeGoPoolSelection<T>> {
  if (!hasKeyPoolFailover(provider) || !isOpenCodeGoKeyDestination(provider)) {
    return { provider };
  }
  const stored = config.providers[providerName];
  if (!stored || !hasKeyPoolFailover(stored)) return { provider };
  const active = stored.apiKey;
  const activeKey = resolvedKey(provider.apiKey);
  const pool = stored.apiKeyPool!;
  const first = pool.findIndex(entry => resolvedKey(entry.key) === activeKey);
  if (!activeKey || first < 0) return { provider };
  const seen = new Set<string>();
  let retryAt: number | undefined;
  for (let offset = 0; offset < pool.length; offset++) {
    if (signal?.aborted) return { provider };
    const entry = pool[(first + offset) % pool.length]!;
    const key = resolvedKey(entry.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const now = Date.now();
    const cooldown = getKeyCooldownUntil(providerName, entry.id, now);
    // Beyond the probe budget a candidate stays unknown and may serve normally. Never fall
    // back to an already-proven exhausted key merely because the pool is unusually large.
    const blockedUntil = cooldown ?? (seen.size <= MAX_PROBES
      ? exhaustedUntil(await observe(providerName, key), Date.now()) : undefined);
    if (signal?.aborted) return { provider };
    if (blockedUntil !== undefined) {
      if (cooldown === null) recordKeyQuotaExhaustion(providerName, entry.id, blockedUntil);
      retryAt = Math.min(retryAt ?? Infinity, blockedUntil);
      continue;
    }
    if (config.providers[providerName] !== stored || stored.disabled
      || !stored.apiKeyPool?.some(candidate => candidate.id === entry.id && resolvedKey(candidate.key) === key)) {
      return { unavailable: true, retryAfterSeconds: 1, configurationChanged: true };
    }
    if (stored.apiKey !== active) {
      // Concurrent requests often choose the same healthy replacement. Reuse that selection;
      // never return the old exhausted key or overwrite a different administrative choice.
      return resolvedKey(stored.apiKey) === key
        ? { provider: { ...provider, apiKey: key } }
        : { unavailable: true, retryAfterSeconds: 1, configurationChanged: true };
    }
    if (key !== activeKey) {
      stored.apiKey = entry.key;
      saveConfigPreservingClaudeCode(config);
    }
    return { provider: { ...provider, apiKey: key } };
  }
  if (retryAt === undefined) return { provider };
  return { unavailable: true, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)) };
}

export function clearOpenCodeGoPoolObservations(): void { observations.clear(); }
