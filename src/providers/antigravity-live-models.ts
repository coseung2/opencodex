import { antigravityUserAgent } from "../adapters/client-fingerprint";
import { ANTIGRAVITY_MODELS, resolveAntigravityEffortWireModel, ANTIGRAVITY_MODEL_EFFORTS, ANTIGRAVITY_MODEL_ALIASES } from "./antigravity-models";
import { MODEL_DISCOVERY_MAX_MODELS, MODEL_DISCOVERY_MAX_RESPONSE_BYTES, extractProviderModelItems, readBoundedDiscoveryJson } from "./model-discovery";

// Like the CCA image fallback, discovery sends credentials only to this first-party endpoint.
const MODELS_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";

export interface AntigravityLiveModel {
  id: string;
  contextWindow?: number;
  reasoningEfforts?: string[];
  inputModalities?: string[];
}

export type AntigravityModelsResult =
  | { ok: true; models: AntigravityLiveModel[] }
  | { ok: false; error: "auth" | "http" | "invalid_response" | "network" };

/** Keep known picker aliases only when their default wire target is actually available. */
export function parseAntigravityModels(value: unknown): AntigravityModelsResult {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).models : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid_response" };
  const rows = Object.entries(raw);
  if (rows.length > MODEL_DISCOVERY_MAX_MODELS || rows.some(([, info]) => !info || typeof info !== "object" || Array.isArray(info))) {
    return { ok: false, error: "invalid_response" };
  }
  const extracted = extractProviderModelItems({ data: rows.map(([id, info]) => ({ ...(info as object), id })) }, {
    maxModels: MODEL_DISCOVERY_MAX_MODELS, maxResponseBytes: MODEL_DISCOVERY_MAX_RESPONSE_BYTES,
  });
  if (!extracted.ok || extracted.items.length !== rows.length) return { ok: false, error: "invalid_response" };
  const available = new Set(extracted.items.map(item => item.id));
  const aliases = new Map<string, string>();
  for (const id of ANTIGRAVITY_MODELS) {
    const defaultWire = resolveAntigravityEffortWireModel(id).wireModelId;
    if (!available.has(defaultWire)) continue;
    aliases.set(defaultWire, id);
    for (const effort of ANTIGRAVITY_MODEL_EFFORTS[id] ?? []) {
      aliases.set(resolveAntigravityEffortWireModel(id, effort).wireModelId, id);
    }
  }
  // Saved retired selectors already route through these compatibility aliases. Do not publish
  // duplicate picker rows that would silently route to the same current wire model.
  for (const [alias, wire] of Object.entries(ANTIGRAVITY_MODEL_ALIASES)) {
    if (available.has(wire)) aliases.set(alias, aliases.get(wire) ?? wire);
  }
  const models = new Map<string, AntigravityLiveModel>();
  for (const item of extracted.items) {
    // CCA includes editor autocomplete/internal models alongside conversational models.
    if (item.isInternal === true || item.apiProvider === "API_PROVIDER_INTERNAL" || item.id.startsWith("tab_")) continue;
    const id = aliases.get(item.id) ?? item.id;
    const contextWindow = typeof item.maxTokens === "number" && Number.isSafeInteger(item.maxTokens) && item.maxTokens > 0
      ? item.maxTokens : undefined;
    const knownEfforts = Object.hasOwn(ANTIGRAVITY_MODEL_EFFORTS, id) ? ANTIGRAVITY_MODEL_EFFORTS[id] : undefined;
    const efforts = knownEfforts?.filter(effort => available.has(resolveAntigravityEffortWireModel(id, effort).wireModelId));
    const previous = models.get(id);
    const window = contextWindow === undefined ? previous?.contextWindow
      : previous?.contextWindow === undefined ? contextWindow : Math.min(previous.contextWindow, contextWindow);
    models.set(id, {
      id,
      ...(window !== undefined ? { contextWindow: window } : {}),
      ...(efforts?.length ? { reasoningEfforts: efforts } : {}),
      ...(typeof item.supportsImages === "boolean" ? { inputModalities: item.supportsImages ? ["text", "image"] : ["text"] } : previous?.inputModalities ? { inputModalities: previous.inputModalities } : {}),
    });
  }
  return { ok: true, models: [...models.values()] };
}

export async function fetchAntigravityModels(options: {
  accessToken: string;
  projectId: string;
  fetchImpl?: typeof fetch;
}): Promise<AntigravityModelsResult> {
  if (!options.accessToken || !options.projectId) return { ok: false, error: "auth" };
  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(MODELS_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: "application/json", "Content-Type": "application/json",
        "User-Agent": antigravityUserAgent(), Authorization: `Bearer ${options.accessToken}`,
      },
      body: JSON.stringify({ project: options.projectId }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, error: response.status === 401 || response.status === 403 ? "auth" : "http" };
    }
    const bounded = await readBoundedDiscoveryJson(response, MODEL_DISCOVERY_MAX_RESPONSE_BYTES);
    return bounded.ok ? parseAntigravityModels(bounded.value) : { ok: false, error: "invalid_response" };
  } catch {
    return { ok: false, error: "network" };
  }
}
