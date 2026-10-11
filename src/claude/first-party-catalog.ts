import { createHash } from "node:crypto";
import { claudeCodeAlias, claudeCodeNativeAlias, resolveAlias } from "./alias";
import type { OcxClaudeCodeConfig } from "../types";

export const FIRST_PARTY_CATALOG_SCHEMA = 1;
export const FIRST_PARTY_MAX_MODELS = 2000;
export const FIRST_PARTY_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const FIRST_PARTY_CATALOG_TTL_MS = 5 * 60_000;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
export interface FirstPartyModelRow {
  id: string;
  route: string;
  name: string;
  contextWindow?: number;
  effortLevels: string[];
}
export interface FirstPartyCatalogSnapshot {
  schemaVersion: 1;
  revision: string;
  generatedAt: number;
  expiresAt: number;
  models: FirstPartyModelRow[];
  modelMap: Record<string, string>;
}
export interface FirstPartyCatalogInput {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoningEfforts?: readonly string[];
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\s<>\x00-\x1f]/.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Secret-free, versioned projection; credentials and arbitrary provider config never enter this DTO. */
export function buildFirstPartyCatalog(
  inputs: readonly FirstPartyCatalogInput[],
  policy: Pick<OcxClaudeCodeConfig, "modelMap"> = {},
  now = Date.now(),
): FirstPartyCatalogSnapshot {
  const models: FirstPartyModelRow[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    if (models.length >= FIRST_PARTY_MAX_MODELS) break;
    if (!identifier(input.provider) || !identifier(input.id)) continue;
    const id = input.provider === "native" ? claudeCodeNativeAlias(input.id) : claudeCodeAlias(input.provider, input.id);
    // Native Anthropic is already present in the bootstrap. Do not make its login a VM route.
    if (id === input.id && input.provider === "anthropic") continue;
    const route = input.provider === "native" ? input.id : `${input.provider}/${input.id}`;
    if (!identifier(id) || resolveAlias(id) !== route || seen.has(id)) continue;
    const name = input.name ?? `${input.id} (${input.provider})`;
    if (!name || name.length > 160 || /[\x00-\x1f]/.test(name)) continue;
    const effortLevels = [...new Set(input.reasoningEfforts ?? [])].filter(value => EFFORTS.has(value));
    models.push({ id, route, name, effortLevels,
      ...(Number.isSafeInteger(input.contextWindow) && input.contextWindow! > 0 ? { contextWindow: input.contextWindow } : {}),
    });
    seen.add(id);
  }
  const modelMap = Object.fromEntries(Object.entries(policy.modelMap ?? {}).filter(([from, to]) => identifier(from) && identifier(to)).slice(0, FIRST_PARTY_MAX_MODELS).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  const revision = createHash("sha256").update(JSON.stringify({ models, modelMap })).digest("hex");
  return { schemaVersion: 1, revision, generatedAt: now, expiresAt: now + FIRST_PARTY_CATALOG_TTL_MS, models, modelMap };
}

export function parseFirstPartyCatalog(value: unknown, now = Date.now()): FirstPartyCatalogSnapshot {
  const invalid = () => { throw new Error("invalid_first_party_catalog"); };
  if (!record(value) || value.schemaVersion !== 1 || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision)
    || !Number.isSafeInteger(value.generatedAt) || !Number.isSafeInteger(value.expiresAt)
    || (value.generatedAt as number) > now + 60_000 || (value.expiresAt as number) < (value.generatedAt as number)
    || (value.expiresAt as number) - (value.generatedAt as number) > FIRST_PARTY_CATALOG_TTL_MS
    || !Array.isArray(value.models) || value.models.length > FIRST_PARTY_MAX_MODELS || !record(value.modelMap)) return invalid();
  if (Buffer.byteLength(JSON.stringify(value)) > FIRST_PARTY_MAX_SNAPSHOT_BYTES) return invalid();
  const models: FirstPartyModelRow[] = [];
  const seen = new Set<string>();
  for (const row of value.models) {
    if (!record(row) || !identifier(row.id) || !identifier(row.route) || resolveAlias(row.id) !== row.route || seen.has(row.id)
      || typeof row.name !== "string" || !row.name || row.name.length > 160 || /[\x00-\x1f]/.test(row.name)
      || !Array.isArray(row.effortLevels) || row.effortLevels.length > 5 || !row.effortLevels.every(level => typeof level === "string" && EFFORTS.has(level))
      || (row.contextWindow !== undefined && (!Number.isSafeInteger(row.contextWindow) || (row.contextWindow as number) <= 0))) return invalid();
    seen.add(row.id);
    models.push({ id: row.id, route: row.route, name: row.name, effortLevels: [...row.effortLevels] as string[],
      ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow as number } : {}),
    });
  }
  const entries = Object.entries(value.modelMap);
  if (entries.length > FIRST_PARTY_MAX_MODELS || !entries.every(([from, to]) => identifier(from) && identifier(to))) return invalid();
  const modelMap = Object.fromEntries(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) as Record<string, string>;
  const revision = createHash("sha256").update(JSON.stringify({ models, modelMap })).digest("hex");
  if (revision !== value.revision) return invalid();
  return { schemaVersion: 1, revision, generatedAt: value.generatedAt as number, expiresAt: value.expiresAt as number, models, modelMap };
}
