import type { OcxProviderConfig } from "../types";

export type CacheRetention = "none" | "short" | "long";

/** Adapter request policy, not a claim about an upstream cache lease. */
export function providerCacheRetention(provider: OcxProviderConfig, explicit?: CacheRetention): CacheRetention | undefined {
  if (provider.adapter !== "anthropic") return undefined;
  return explicit ?? (provider.authMode === "oauth" ? "long" : "short");
}

export interface ProviderCachePolicy {
  control: "anthropic-breakpoints" | "upstream-managed" | "unknown";
  requestedRetention?: CacheRetention;
  guaranteedRetention: false;
}

/** Serializable subset of ProviderCachePolicy: no guarantees, no provider config. */
export interface CachePolicySnapshot {
  control: ProviderCachePolicy["control"];
  requestedRetention?: CacheRetention;
}

const CACHE_POLICY_CONTROLS = new Set<ProviderCachePolicy["control"]>([
  "anthropic-breakpoints",
  "upstream-managed",
  "unknown",
]);

function isCacheRetention(value: unknown): value is CacheRetention {
  return value === "none" || value === "short" || value === "long";
}

/** Runtime guard for values read back from the usage journal. */
export function isCachePolicySnapshot(value: unknown): value is CachePolicySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  if (typeof policy.control !== "string"
    || !CACHE_POLICY_CONTROLS.has(policy.control as ProviderCachePolicy["control"])) return false;
  const retention = policy.requestedRetention;
  return retention === undefined || isCacheRetention(retention);
}

/**
 * The part of a provider's cache policy worth persisting: which side controls the
 * prompt cache and the retention this request asked for.
 *
 * Called where the EFFECTIVE provider is known, never reconstructed later. A
 * reconstruction from config reports whichever provider is configured now rather
 * than the one that served the request: combo rows rewrite the provider name to
 * "combo", failover/account promotion replaces the provider snapshot, and a routed
 * Claude request carries a request-local retention that the global setting lacks.
 */
export function cachePolicySnapshot(provider: OcxProviderConfig, explicit?: CacheRetention): CachePolicySnapshot {
  const policy = providerCachePolicy(provider, explicit);
  return {
    control: policy.control,
    ...(policy.requestedRetention !== undefined ? { requestedRetention: policy.requestedRetention } : {}),
  };
}

/** Public API contracts do not automatically apply to subscription or gateway endpoints. */
export function providerCachePolicy(provider: OcxProviderConfig, explicit?: CacheRetention): ProviderCachePolicy {
  if (provider.adapter === "anthropic") {
    return { control: "anthropic-breakpoints", requestedRetention: providerCacheRetention(provider, explicit), guaranteedRetention: false };
  }
  let host = "";
  try { host = new URL(provider.baseUrl).hostname; } catch { /* unknown endpoint */ }
  const knownImplicit = provider.authMode !== "oauth" && provider.authMode !== "forward"
    && (provider.adapter === "openai-responses" || provider.adapter === "openai-chat")
    && (host === "api.openai.com" || host === "api.x.ai");
  return { control: knownImplicit ? "upstream-managed" : "unknown", guaranteedRetention: false };
}
