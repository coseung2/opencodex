import { createHash } from "node:crypto";
import type { OcxProviderConfig } from "../types";
import { registryEntryForProviderDestination } from "./registry";

export const OPENCODE_GO_SESSION_HEADER = "x-opencode-session";

const MUSE_RESPONSE_MODELS = new Set(["muse-spark-1.2-contributor", "muse-spark-1.3-contributor"]);
const MUSE_RESPONSE_URLS = new Set([
  "https://opencode.ai/zen/v1/responses",
  "https://opencode.ai/zen/go/v1/responses",
]);

/** Compatibility belongs to the exact model AND effective destination, not a provider label. */
export function isOpenCodeMuseResponses(modelId: unknown, responseUrl: string): boolean {
  if (typeof modelId !== "string" || !MUSE_RESPONSE_MODELS.has(modelId.trim().toLowerCase())) return false;
  try {
    const url = new URL(responseUrl);
    if (url.username || url.password || url.search || url.hash) return false;
    return MUSE_RESPONSE_URLS.has(`${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`);
  } catch {
    return false;
  }
}

function hasHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  name: string,
): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers ?? {}).some(key => key.toLowerCase() === target);
}

/** Derive a provider-scoped opaque value without exposing Codex task or subagent ids. */
export function deriveOpenCodeGoSessionId(sessionLane: string): string {
  const digest = createHash("sha256")
    .update("opencodex/opencode-go/session/v1\0")
    .update(sessionLane)
    .digest("hex")
    .slice(0, 32);
  return `ocx_${digest}`;
}

/** Add per-conversation Go affinity only to the canonical fixed-key destination. */
export function resolveOpenCodeGoTransport<T extends OcxProviderConfig>(
  provider: T,
  sessionLane: string | undefined,
): T {
  if (registryEntryForProviderDestination(provider)?.id !== "opencode-go") return provider;
  if (!sessionLane) return provider;
  if (hasHeaderCaseInsensitive(provider.headers, OPENCODE_GO_SESSION_HEADER)) return provider;

  return {
    ...provider,
    headers: {
      ...(provider.headers ?? {}),
      [OPENCODE_GO_SESSION_HEADER]: deriveOpenCodeGoSessionId(sessionLane),
    },
  };
}
