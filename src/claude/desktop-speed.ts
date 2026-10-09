import { upstreamNativeEntry } from "../codex/catalog/metadata";
import { normalizeServiceTiers } from "../codex/catalog/parsing";

// Internal catalog identity only; never send this suffix to a provider.
export const DESKTOP_FAST_SUFFIX = "--ocx-fast";

export function desktopFastModelId(modelId: string): string {
  return `${modelId}${DESKTOP_FAST_SUFFIX}`;
}

export function desktopBaseModelId(modelId: string): string {
  return modelId.endsWith(DESKTOP_FAST_SUFFIX) ? modelId.slice(0, -DESKTOP_FAST_SUFFIX.length) : modelId;
}

/** Only known OpenAI priority-capable models, never GPT models resold by other providers. */
export function supportsDesktopFast(provider: string, modelId: string): boolean {
  if (!["native", "openai", "openai-apikey"].includes(provider)) return false;
  const entry = upstreamNativeEntry(modelId);
  if (!entry) return false;
  const tiers = normalizeServiceTiers(entry).service_tiers;
  return Array.isArray(tiers) && tiers.some(tier => tier?.id === "priority");
}

export function desktopRouteSpeed(route: string): "priority" | "default" | undefined {
  const slash = route.indexOf("/");
  if (slash < 0) return undefined;
  const model = route.slice(slash + 1);
  if (!supportsDesktopFast(route.slice(0, slash), desktopBaseModelId(model))) return undefined;
  return model.endsWith(DESKTOP_FAST_SUFFIX) ? "priority" : "default";
}
