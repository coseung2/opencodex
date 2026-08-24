/**
 * provider-workspace/report.ts — pure derivations for the workspace detail
 * panels (WP090): quota-report → AccountQuota adaptation, quota source labels,
 * and the models-tab filter. No React, no fetch.
 */
import type { AccountQuota } from "../codex-quota-utils";

/** Wire shape of one /api/provider-quotas report row as the workspace consumes it. */
export interface ProviderQuotaReportView {
  label?: string;
  source?: string;
  updatedAt?: number;
  quota?: unknown;
  aggregation?: unknown;
}

export interface ProviderCapacitySummary {
  presentation: "aggregate" | "effective-account-fallback" | "coverage-only";
  includedAccounts: number;
  excludedAccounts: number;
  unknownPlanAccounts: number;
  nextRecoveryAt?: number;
  nextRecoveryPercent?: number;
}

/** Strictly narrow the public weighted Codex-pool metadata from /api/provider-quotas. */
export function capacitySummaryFromReport(report?: ProviderQuotaReportView): ProviderCapacitySummary | null {
  const raw = report?.aggregation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row.kind !== "capacity-weighted-v1" || row.scope !== "routable-known") return null;
  const finite = (value: unknown): number | undefined => (
    typeof value === "number" && Number.isFinite(value) ? value : undefined
  );
  const includedAccounts = finite(row.includedAccounts);
  const excludedAccounts = finite(row.excludedAccounts);
  const unknownPlanAccounts = finite(row.unknownPlanAccounts);
  if (includedAccounts === undefined || excludedAccounts === undefined || unknownPlanAccounts === undefined) return null;
  const presentation = row.presentation === "effective-account-fallback" || row.presentation === "coverage-only"
    ? row.presentation
    : "aggregate";
  const windows = [row.fiveHour, row.weekly, row.monthly, ...(Array.isArray(row.customWindows) ? row.customWindows : [])]
    .filter((value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value));
  const next = windows
    .map(window => ({ at: finite(window.nextRecoveryAt), percent: finite(window.nextRecoveryPercent) }))
    .filter((value): value is { at: number; percent: number | undefined } => value.at !== undefined)
    .sort((a, b) => a.at - b.at)[0];
  return {
    presentation,
    includedAccounts,
    excludedAccounts,
    unknownPlanAccounts,
    ...(next ? { nextRecoveryAt: next.at } : {}),
    ...(next?.percent !== undefined ? { nextRecoveryPercent: next.percent } : {}),
  };
}

/** Narrow an unknown quota payload into the AccountQuota display shape (null when unusable). */
export function accountQuotaFromReport(report?: ProviderQuotaReportView): AccountQuota | null {
  const quota = report?.quota;
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) return null;
  const q = quota as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const windows = Array.isArray(q.customWindows)
    ? (q.customWindows as unknown[]).flatMap(w => {
        if (!w || typeof w !== "object") return [];
        const row = w as Record<string, unknown>;
        if (typeof row.label !== "string" || num(row.percent) === undefined) return [];
        return [{
          label: row.label,
          percent: row.percent as number,
          ...(num(row.resetAt) !== undefined ? { resetAt: row.resetAt as number } : {}),
          ...(typeof row.valueLabel === "string" && row.valueLabel.trim() ? { valueLabel: row.valueLabel } : {}),
          ...(Array.isArray(row.segments)
            ? {
                segments: (row.segments as unknown[]).flatMap(seg => {
                  if (!seg || typeof seg !== "object") return [];
                  const s = seg as Record<string, unknown>;
                  if (typeof s.label !== "string" || num(s.percent) === undefined) return [];
                  return [{
                    label: s.label,
                    percent: s.percent as number,
                    ...(num(s.resetAt) !== undefined ? { resetAt: s.resetAt as number } : {}),
                  }];
                }),
              }
            : {}),
        }];
      })
    : [];
  const out: AccountQuota = {
    ...(num(q.fiveHourPercent) !== undefined ? { fiveHourPercent: q.fiveHourPercent as number } : {}),
    ...(num(q.fiveHourResetAt) !== undefined ? { fiveHourResetAt: q.fiveHourResetAt as number } : {}),
    ...(num(q.weeklyPercent) !== undefined ? { weeklyPercent: q.weeklyPercent as number } : {}),
    ...(num(q.weeklyResetAt) !== undefined ? { weeklyResetAt: q.weeklyResetAt as number } : {}),
    ...(num(q.monthlyPercent) !== undefined ? { monthlyPercent: q.monthlyPercent as number } : {}),
    ...(num(q.monthlyResetAt) !== undefined ? { monthlyResetAt: q.monthlyResetAt as number } : {}),
    ...(windows.length > 0 ? { customWindows: windows } : {}),
    updatedAt: num(q.updatedAt) ?? report?.updatedAt ?? Date.now(),
  };
  const hasSignal = out.fiveHourPercent !== undefined
    || out.weeklyPercent !== undefined
    || out.monthlyPercent !== undefined
    || (out.customWindows?.length ?? 0) > 0;
  return hasSignal ? out : null;
}

/** Human label for a quota report source id (e.g. "cursor:period-usage"). */
export function formatQuotaSourceLabel(source: string | undefined): string {
  if (!source?.trim()) return "";
  const [provider, path] = source.split(":", 2);
  if (!path) return source;
  return `${provider} · ${path.replace(/-/g, " ")}`;
}

/**
 * Models-tab list derivation: live models, else configured static ids, else
 * the default model as a single-row fallback; filtered by substring query.
 */
export function filterModels(
  base: string[],
  defaultModel: string | undefined,
  query: string,
  configuredModels: string[] | undefined,
  customModels: string[],
  /**
   * Whether the last successful discovery returned any rows, taken from the server. Required:
   * inferring it by subtracting custom ids from `base` misreads a live catalog as custom-only
   * whenever a custom id also appears upstream, which wrongly keeps the configured fallback
   * authoritative.
   */
  hasLiveModels: boolean,
): string[] {
  const fallback = configuredModels && configuredModels.length > 0
    ? configuredModels
    : defaultModel ? [defaultModel] : [];
  const primary = hasLiveModels ? base : fallback;
  const list = [...new Set([...primary, ...customModels])];
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(id => id.toLowerCase().includes(q));
}
