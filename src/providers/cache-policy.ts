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
