import type { OcxConfig, OcxProviderConfig } from "../types";
import { PROVIDER_REGISTRY } from "./registry";

export interface ModelRename {
  provider: string;
  from: string;
  to: string;
  reason: string;
  dropReasoningEffortMap?: boolean;
}

const RETIRED_ANTIGRAVITY_FLASH_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.6-flash-low",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-high",
  "gemini-3.5-flash-extra-low",
  "gemini-3.5-flash-low",
  "gemini-3.5-flash-mid",
  "gemini-3.5-flash-high",
  "gemini-3-flash-agent",
] as const;

export const MODEL_RENAMES: readonly ModelRename[] = RETIRED_ANTIGRAVITY_FLASH_MODELS.map(from => ({
  provider: "google-antigravity",
  from,
  to: "gemini-3.7-flash",
  reason: "Google retires the previous Antigravity Flash generation from Cloud Code Assist when its successor ships",
  dropReasoningEffortMap: true,
}));

const MODEL_KEYED_RECORDS = [
  "modelContextWindows",
  "modelMaxOutputTokens",
  "modelInputModalities",
  "modelReasoningEfforts",
  "modelDefaultReasoningEfforts",
  "modelReasoningEffortMap",
] as const;

const MODEL_ID_LISTS = [
  "models",
  "selectedModels",
  "noVisionModels",
  "noReasoningModels",
  "noTemperatureModels",
  "noTopPModels",
  "noPenaltyModels",
  "autoToolChoiceOnlyModels",
  "preserveReasoningContentModels",
  "thinkingBudgetModels",
] as const;

function renameInList(value: unknown, from: string, to: string): string[] | null {
  if (!Array.isArray(value) || !value.includes(from)) return null;
  const next: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const mapped = entry === from ? to : entry;
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    next.push(mapped);
  }
  return next;
}

function renameInRecord(value: unknown, from: string, to: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!(from in record)) return null;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const mapped = key === from ? to : key;
    if (mapped in next) continue;
    next[mapped] = key === from && to in record ? record[to] : entry;
  }
  return next;
}

function dropFromRecord(value: unknown, from: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!(from in record)) return null;
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== from));
}

function providerStillMatchesRegistry(name: string, provider: OcxProviderConfig): boolean {
  const entry = PROVIDER_REGISTRY.find(row => row.id === name);
  if (!entry) return false;
  if (!provider.baseUrl || !entry.baseUrl) return true;
  const known = [entry.baseUrl, ...(entry.baseUrlChoices?.map(choice => choice.baseUrl).filter(Boolean) ?? [])]
    .map(url => url!.replace(/\/+$/, ""));
  return known.includes(provider.baseUrl.replace(/\/+$/, ""));
}

export interface ModelRenameProjection {
  config: OcxConfig;
  changed: boolean;
  warnings: string[];
}

export function projectModelRenames(
  config: OcxConfig,
  renames: readonly ModelRename[] = MODEL_RENAMES,
): ModelRenameProjection {
  let changed = false;
  const warnings: string[] = [];

  for (const rename of renames) {
    const provider = config.providers?.[rename.provider];
    const registry = PROVIDER_REGISTRY.find(row => row.id === rename.provider);
    if (!provider || !registry?.models?.includes(rename.to) || !providerStillMatchesRegistry(rename.provider, provider)) continue;

    const row = provider as unknown as Record<string, unknown>;
    let touched = false;
    for (const field of MODEL_ID_LISTS) {
      const next = renameInList(row[field], rename.from, rename.to);
      if (!next) continue;
      row[field] = next;
      touched = true;
    }
    for (const field of MODEL_KEYED_RECORDS) {
      const next = rename.dropReasoningEffortMap && field === "modelReasoningEffortMap"
        ? dropFromRecord(row[field], rename.from)
        : renameInRecord(row[field], rename.from, rename.to);
      if (!next) continue;
      row[field] = next;
      touched = true;
    }
    if (provider.defaultModel === rename.from) {
      provider.defaultModel = rename.to;
      touched = true;
    }
    const disabled = `${rename.provider}/${rename.from}`;
    if (config.disabledModels?.includes(disabled)) {
      config.disabledModels = config.disabledModels.filter(model => model !== disabled);
      touched = true;
    }
    if (touched) {
      changed = true;
      warnings.push(`renamed "${rename.provider}/${rename.from}" to "${rename.to}": ${rename.reason}.`);
    }
  }

  return { config, changed, warnings };
}
