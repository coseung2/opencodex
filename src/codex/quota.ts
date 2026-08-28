import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { captureConfigGeneration, type GenerationContext } from "../lib/state-store-sweeper";

export type StoredAccountQuota = {
  fiveHourPercent?: number;
  weeklyPercent?: number;
  fiveHourResetAt?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  monthlyResetAt?: number;
  resetCredits?: number;
  updatedAt: number;
};

/** Disk snapshot under OPENCODEX_HOME — usage percents only (no emails/tokens). */
const QUOTA_CACHE_FILENAME = "codex-quota-cache.json";
/** Keep last-known bars across restarts; WHAM still refreshes on TTL in live/prime paths. */
const QUOTA_DISK_MAX_AGE_MS = 6 * 60 * 60_000;
const QUOTA_PERSIST_DEBOUNCE_MS = 250;

type QuotaDiskFile = {
  version: 1;
  quotas: Record<string, StoredAccountQuota>;
};

let diskHydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export type WhamUsageResponse = {
  email?: string | null;
  plan_type?: string | null;
  rate_limit?: {
    // Live WHAM payloads send explicit nulls for absent windows (issue #315 repro).
    primary_window?: WhamUsageWindow | null;
    secondary_window?: WhamUsageWindow | null;
    tertiary_window?: WhamUsageWindow | null;
  };
  rate_limit_reset_credits?: {
    available_count: number;
  } | null;
};

type WhamUsageWindow = {
  used_percent?: number | string | null;
  reset_at?: number | string | null;
  limit_window_seconds?: number | string | null;
};

const MONTHLY_WINDOW_MIN_SECONDS = 28 * 24 * 60 * 60;
const MONTHLY_WINDOW_MIN_MINUTES = MONTHLY_WINDOW_MIN_SECONDS / 60;
const FIVE_HOUR_WINDOW_MIN_SECONDS = 2 * 60 * 60;
const FIVE_HOUR_WINDOW_MAX_SECONDS = 12 * 60 * 60;

const accountQuota = new Map<string, StoredAccountQuota>();
let lastReconciledGeneration = 0;
let liveAccountIds = new Set<string>();

function mayCommitAccountQuota(accountId: string, writerGeneration: number): boolean {
  return writerGeneration >= lastReconciledGeneration || liveAccountIds.has(accountId);
}

// Valid upstream percentages are normalized to 0..100. Keep "unknown" outside that domain so an
// actually exhausted account is still eligible for threshold rotation.
export const CODEX_UNKNOWN_USAGE_SCORE = 101;
export const CODEX_EXHAUSTED_USAGE_PERCENT = 100;

/** Plans whose WHAM payloads expose a separate rolling five-hour window. */
export function isCodexFiveHourQuotaPlan(plan: string | null | undefined): boolean {
  const normalized = plan?.trim().toLowerCase();
  // Business is the current name for the older Team workspace plan.
  return normalized === "plus" || normalized === "team" || normalized === "business";
}

export function isCodexQuotaExhausted(
  quota: Pick<StoredAccountQuota, "fiveHourPercent" | "weeklyPercent" | "monthlyPercent"> | null,
  plan?: string | null,
): boolean {
  if (!quota) return false;
  const normalizedPlan = plan?.trim().toLowerCase();
  const values = normalizedPlan === "go" || normalizedPlan === "free"
    ? [quota.monthlyPercent]
    : [
        ...(isCodexFiveHourQuotaPlan(plan) ? [quota.fiveHourPercent] : []),
        quota.weeklyPercent,
        quota.monthlyPercent,
      ];
  return values.some(value => typeof value === "number"
    && Number.isFinite(value)
    && value >= CODEX_EXHAUSTED_USAGE_PERCENT);
}

export function normalizeUsagePercent(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : undefined;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return undefined;
  return Math.max(0, Math.min(100, numeric));
}

function normalizeResetAt(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : undefined;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0) return undefined;
  return numeric;
}

function hasKnownQuotaValue(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return [quota.fiveHourPercent, quota.weeklyPercent, quota.monthlyPercent]
    .some(value => typeof value === "number" && Number.isFinite(value));
}

function windowDurationSeconds(window: WhamUsageWindow | null | undefined): number | undefined {
  const raw: unknown = window?.limit_window_seconds;
  const seconds = typeof raw === "number"
    ? raw
    : typeof raw === "string" && raw.trim() !== ""
      ? Number(raw)
      : undefined;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function isExplicitMonthlyWindow(window: WhamUsageWindow | null | undefined): boolean {
  const seconds = windowDurationSeconds(window);
  return seconds !== undefined && seconds >= MONTHLY_WINDOW_MIN_SECONDS;
}

function isExplicitMonthlyWindowMinutes(windowMinutes: unknown): boolean {
  const minutes = typeof windowMinutes === "number"
    ? windowMinutes
    : typeof windowMinutes === "string" && windowMinutes.trim() !== ""
      ? Number(windowMinutes)
      : undefined;
  return typeof minutes === "number"
    && Number.isFinite(minutes)
    && minutes >= MONTHLY_WINDOW_MIN_MINUTES;
}

function isExplicitFiveHourWindow(window: WhamUsageWindow | null | undefined): boolean {
  const seconds = windowDurationSeconds(window);
  return seconds !== undefined
    && seconds >= FIVE_HOUR_WINDOW_MIN_SECONDS
    && seconds <= FIVE_HOUR_WINDOW_MAX_SECONDS;
}

function isExplicitFiveHourWindowMinutes(windowMinutes: unknown): boolean {
  const minutes = typeof windowMinutes === "number"
    ? windowMinutes
    : typeof windowMinutes === "string" && windowMinutes.trim() !== ""
      ? Number(windowMinutes)
      : undefined;
  return typeof minutes === "number"
    && Number.isFinite(minutes)
    && minutes >= FIVE_HOUR_WINDOW_MIN_SECONDS / 60
    && minutes <= FIVE_HOUR_WINDOW_MAX_SECONDS / 60;
}

function snapshotHasWeekly(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return quota.weeklyPercent !== undefined || quota.weeklyResetAt !== undefined;
}

function snapshotHasFiveHour(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return quota.fiveHourPercent !== undefined || quota.fiveHourResetAt !== undefined;
}

function snapshotHasMonthly(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return quota.monthlyPercent !== undefined || quota.monthlyResetAt !== undefined;
}

function snapshotHasUsage(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return snapshotHasFiveHour(quota) || snapshotHasWeekly(quota) || snapshotHasMonthly(quota);
}
export function setAccountQuotaFromParsed(
  accountId: string,
  quota: Omit<StoredAccountQuota, "updatedAt"> | null,
  writerGeneration = captureConfigGeneration(),
): void {
  if (!quota) return;
  if (!mayCommitAccountQuota(accountId, writerGeneration)) return;
  const existing = accountQuota.get(accountId);
  const next: StoredAccountQuota = { updatedAt: Date.now() };
  const creditsOnly = quota.resetCredits !== undefined && !snapshotHasUsage(quota);

  if (creditsOnly) {
    if (existing?.fiveHourPercent !== undefined) next.fiveHourPercent = existing.fiveHourPercent;
    if (existing?.fiveHourResetAt !== undefined) next.fiveHourResetAt = existing.fiveHourResetAt;
    if (existing?.weeklyPercent !== undefined) next.weeklyPercent = existing.weeklyPercent;
    if (existing?.weeklyResetAt !== undefined) next.weeklyResetAt = existing.weeklyResetAt;
    if (existing?.monthlyPercent !== undefined) next.monthlyPercent = existing.monthlyPercent;
    if (existing?.monthlyResetAt !== undefined) next.monthlyResetAt = existing.monthlyResetAt;
    next.resetCredits = quota.resetCredits;
    accountQuota.set(accountId, next);
    schedulePersistAccountQuotas();
    return;
  }

  const hasFiveHour = snapshotHasFiveHour(quota);
  const hasWeekly = snapshotHasWeekly(quota);
  const hasMonthly = snapshotHasMonthly(quota);

  if (hasFiveHour) {
    if (quota.fiveHourPercent !== undefined) next.fiveHourPercent = quota.fiveHourPercent;
    if (quota.fiveHourResetAt !== undefined) next.fiveHourResetAt = quota.fiveHourResetAt;
    // A five-hour-only response can be a partial snapshot; retain a known
    // weekly value until a later response supplies that window.
    if (!hasWeekly && existing?.weeklyPercent !== undefined) {
      next.weeklyPercent = existing.weeklyPercent;
      if (existing.weeklyResetAt !== undefined) next.weeklyResetAt = existing.weeklyResetAt;
    }
  }

  if (hasWeekly) {
    if (quota.weeklyPercent !== undefined) next.weeklyPercent = quota.weeklyPercent;
    if (quota.weeklyResetAt !== undefined) next.weeklyResetAt = quota.weeklyResetAt;
  } else if (hasMonthly && !hasFiveHour) {
    // Monthly-only snapshots intentionally clear stale weekly values (issue #382).
  }

  if (hasMonthly) {
    if (quota.monthlyPercent !== undefined) next.monthlyPercent = quota.monthlyPercent;
    if (quota.monthlyResetAt !== undefined) next.monthlyResetAt = quota.monthlyResetAt;
  } else if ((hasWeekly || hasFiveHour) && existing?.monthlyPercent !== undefined) {
    next.monthlyPercent = existing.monthlyPercent;
    if (existing.monthlyResetAt !== undefined) next.monthlyResetAt = existing.monthlyResetAt;
  }

  if (quota.resetCredits !== undefined) next.resetCredits = quota.resetCredits;
  else if (existing?.resetCredits !== undefined) next.resetCredits = existing.resetCredits;

  accountQuota.set(accountId, next);
  schedulePersistAccountQuotas();
}

export function parseUpstreamQuotaHeaders(
  headers: Headers,
  plan?: string | null,
): Omit<StoredAccountQuota, "updatedAt"> | null {
  const primaryRaw = headers.get("x-codex-primary-used-percent");
  const secondaryRaw = headers.get("x-codex-secondary-used-percent");
  const tertiaryRaw = headers.get("x-codex-tertiary-used-percent");
  const primaryResetRaw = headers.get("x-codex-primary-reset-at");
  const secondaryResetRaw = headers.get("x-codex-secondary-reset-at");
  const tertiaryResetRaw = headers.get("x-codex-tertiary-reset-at");
  const primaryWindowMinutes = headers.get("x-codex-primary-window-minutes");
  const secondaryWindowMinutes = headers.get("x-codex-secondary-window-minutes");

  const quota: Omit<StoredAccountQuota, "updatedAt"> = {};
  const primaryPercent = normalizeUsagePercent(primaryRaw);
  const secondaryPercent = normalizeUsagePercent(secondaryRaw);
  const tertiaryPercent = normalizeUsagePercent(tertiaryRaw);
  const primaryResetAt = normalizeResetAt(primaryResetRaw);
  const secondaryResetAt = normalizeResetAt(secondaryResetRaw);
  const tertiaryResetAt = normalizeResetAt(tertiaryResetRaw);
  const primaryIsMonthly = primaryRaw !== null && isExplicitMonthlyWindowMinutes(primaryWindowMinutes);
  const trackFiveHour = plan == null || isCodexFiveHourQuotaPlan(plan);
  const primaryIsFiveHour = trackFiveHour && primaryRaw !== null && isExplicitFiveHourWindowMinutes(primaryWindowMinutes);
  const secondaryIsFiveHour = trackFiveHour && secondaryRaw !== null && isExplicitFiveHourWindowMinutes(secondaryWindowMinutes);

  if (primaryIsMonthly) {
    if (primaryPercent !== undefined) {
      quota.monthlyPercent = primaryPercent;
      if (primaryResetAt !== undefined) quota.monthlyResetAt = primaryResetAt;
    }
    if (secondaryIsFiveHour && secondaryPercent !== undefined) {
      quota.fiveHourPercent = secondaryPercent;
      if (secondaryResetAt !== undefined) quota.fiveHourResetAt = secondaryResetAt;
    } else if (secondaryPercent !== undefined) {
      quota.weeklyPercent = secondaryPercent;
      if (secondaryResetAt !== undefined) quota.weeklyResetAt = secondaryResetAt;
    }
  } else {
    if (primaryIsFiveHour && primaryPercent !== undefined) {
      quota.fiveHourPercent = primaryPercent;
      if (primaryResetAt !== undefined) quota.fiveHourResetAt = primaryResetAt;
    }
    if (secondaryIsFiveHour && secondaryPercent !== undefined) {
      quota.fiveHourPercent ??= secondaryPercent;
      if (quota.fiveHourResetAt === undefined && secondaryResetAt !== undefined) {
        quota.fiveHourResetAt = secondaryResetAt;
      }
    }
    const weeklyPercent = primaryIsFiveHour ? secondaryPercent : primaryPercent ?? secondaryPercent;
    const weeklyResetAt = primaryIsFiveHour
      ? secondaryResetAt
      : primaryPercent !== undefined ? primaryResetAt : secondaryResetAt;
    if (weeklyPercent !== undefined) {
      quota.weeklyPercent = weeklyPercent;
      if (weeklyResetAt !== undefined) quota.weeklyResetAt = weeklyResetAt;
    }
    if (trackFiveHour
      && !primaryIsFiveHour
      && primaryPercent !== undefined
      && secondaryPercent !== undefined
      && primaryWindowMinutes === null
      && secondaryWindowMinutes === null) {
      quota.fiveHourPercent = primaryPercent;
      if (primaryResetAt !== undefined) quota.fiveHourResetAt = primaryResetAt;
      quota.weeklyPercent = secondaryPercent;
      if (secondaryResetAt !== undefined) quota.weeklyResetAt = secondaryResetAt;
    }
  }

  if (tertiaryPercent !== undefined && quota.monthlyPercent === undefined) {
    quota.monthlyPercent = tertiaryPercent;
    if (tertiaryResetAt !== undefined) quota.monthlyResetAt = tertiaryResetAt;
  }

  return hasKnownQuotaValue(quota) ? quota : null;
}

export function applyAccountQuotaFromUpstreamHeaders(
  accountId: string,
  headers: Headers,
  writerGeneration = captureConfigGeneration(),
  plan?: string | null,
): void {
  const quota = parseUpstreamQuotaHeaders(headers, plan);
  if (!quota) return;
  setAccountQuotaFromParsed(accountId, quota, writerGeneration);
}

export function updateAccountQuota(
  accountId: string,
  weekly: unknown,
  weeklyResetAt?: unknown,
  monthly?: unknown,
  monthlyResetAt?: unknown,
  resetCredits?: number,
  writerGeneration = captureConfigGeneration(),
): void {
  if (!mayCommitAccountQuota(accountId, writerGeneration)) return;
  const existing = accountQuota.get(accountId);
  const nextWeekly = normalizeUsagePercent(weekly);
  const nextMonthly = normalizeUsagePercent(monthly);
  if (nextWeekly === undefined && nextMonthly === undefined && resetCredits === undefined) return;

  const quota: StoredAccountQuota = {
    ...(existing?.fiveHourPercent !== undefined ? { fiveHourPercent: existing.fiveHourPercent } : {}),
    ...(existing?.weeklyPercent !== undefined ? { weeklyPercent: existing.weeklyPercent } : {}),
    ...(existing?.fiveHourResetAt !== undefined ? { fiveHourResetAt: existing.fiveHourResetAt } : {}),
    ...(existing?.monthlyPercent !== undefined ? { monthlyPercent: existing.monthlyPercent } : {}),
    ...(existing?.weeklyResetAt !== undefined ? { weeklyResetAt: existing.weeklyResetAt } : {}),
    ...(existing?.monthlyResetAt !== undefined ? { monthlyResetAt: existing.monthlyResetAt } : {}),
    ...(existing?.resetCredits !== undefined ? { resetCredits: existing.resetCredits } : {}),
    updatedAt: Date.now(),
  };

  const nextWeeklyResetAt = normalizeResetAt(weeklyResetAt);
  const nextMonthlyResetAt = normalizeResetAt(monthlyResetAt);
  if (nextWeekly !== undefined) {
    quota.weeklyPercent = nextWeekly;
    if (nextWeeklyResetAt !== undefined) quota.weeklyResetAt = nextWeeklyResetAt;
  }
  if (nextMonthly !== undefined) {
    quota.monthlyPercent = nextMonthly;
    if (nextMonthlyResetAt !== undefined) quota.monthlyResetAt = nextMonthlyResetAt;
  }
  if (resetCredits !== undefined) quota.resetCredits = resetCredits;

  accountQuota.set(accountId, quota);
  schedulePersistAccountQuotas();
}

function hydrateAccountQuotasFromDisk(): void {
  if (diskHydrated) return;
  diskHydrated = true;
  try {
    const path = join(getConfigDir(), QUOTA_CACHE_FILENAME);
    if (!existsSync(path)) return;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as QuotaDiskFile;
    if (!parsed || parsed.version !== 1 || !parsed.quotas || typeof parsed.quotas !== "object") return;
    const now = Date.now();
    for (const [accountId, quota] of Object.entries(parsed.quotas)) {
      if (!quota || typeof quota !== "object" || typeof quota.updatedAt !== "number") continue;
      if (now - quota.updatedAt > QUOTA_DISK_MAX_AGE_MS) continue;
      if (!accountQuota.has(accountId)) accountQuota.set(accountId, quota);
    }
  } catch {
    // Corrupt/missing cache must never block routing or the dashboard.
  }
}

function schedulePersistAccountQuotas(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const quotas: Record<string, StoredAccountQuota> = {};
      for (const [accountId, quota] of accountQuota.entries()) {
        quotas[accountId] = quota;
      }
      const body: QuotaDiskFile = { version: 1, quotas };
      atomicWriteFile(join(getConfigDir(), QUOTA_CACHE_FILENAME), `${JSON.stringify(body)}\n`);
    } catch {
      // Best-effort persistence only.
    }
  }, QUOTA_PERSIST_DEBOUNCE_MS);
}

export function getAccountQuota(accountId: string): StoredAccountQuota | null {
  hydrateAccountQuotasFromDisk();
  return accountQuota.get(accountId) ?? null;
}

export function listAccountQuotas(): IterableIterator<[string, StoredAccountQuota]> {
  hydrateAccountQuotasFromDisk();
  return accountQuota.entries();
}

export function clearAccountQuota(accountId?: string): void {
  if (accountId) {
    accountQuota.delete(accountId);
    schedulePersistAccountQuotas();
    return;
  }
  accountQuota.clear();
  diskHydrated = false;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    const path = join(getConfigDir(), QUOTA_CACHE_FILENAME);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best-effort; memory is already cleared.
  }
}

export function reconcileCodexQuotaAccounts(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  hydrateAccountQuotasFromDisk();
  let removed = 0;
  for (const accountId of accountQuota.keys()) {
    if (context.codexAccountIds.has(accountId)) continue;
    accountQuota.delete(accountId);
    removed += 1;
  }
  liveAccountIds = new Set(context.codexAccountIds);
  lastReconciledGeneration = context.generation;
  if (removed > 0) schedulePersistAccountQuotas();
  return removed;
}

export function parseUsageQuota(data: WhamUsageResponse): Omit<StoredAccountQuota, "updatedAt"> | null {
  const resetCredits = typeof data.rate_limit_reset_credits?.available_count === "number"
    ? data.rate_limit_reset_credits.available_count
    : undefined;

  if (!data.rate_limit) {
    return resetCredits !== undefined ? { resetCredits } : null;
  }

  const quota: Omit<StoredAccountQuota, "updatedAt"> = {};
  const thirtyDayOnly = data.plan_type?.trim().toLowerCase() === "go" || data.plan_type?.trim().toLowerCase() === "free";
  const primaryWindow = data.rate_limit.primary_window;
  const secondaryWindow = data.rate_limit.secondary_window;
  const tertiaryWindow = data.rate_limit.tertiary_window;
  const primaryPercent = normalizeUsagePercent(primaryWindow?.used_percent);
  const secondaryPercent = normalizeUsagePercent(secondaryWindow?.used_percent);
  const tertiaryPercent = normalizeUsagePercent(tertiaryWindow?.used_percent);
  const primaryResetAt = normalizeResetAt(primaryWindow?.reset_at);
  const secondaryResetAt = normalizeResetAt(secondaryWindow?.reset_at);
  const tertiaryResetAt = normalizeResetAt(tertiaryWindow?.reset_at);
  const primaryIsMonthly = isExplicitMonthlyWindow(primaryWindow);
  const primaryIsFiveHour = isExplicitFiveHourWindow(primaryWindow);
  const secondaryIsFiveHour = isExplicitFiveHourWindow(secondaryWindow);

  // Explicit durations win over positional assumptions. This matters because
  // WHAM has shipped both a legacy primary=weekly shape and a dual-window
  // primary=5h, secondary=weekly shape over time.
  let weeklyPercent = primaryIsMonthly ? secondaryPercent : primaryPercent ?? secondaryPercent;
  let weeklyResetAt = primaryIsMonthly
    ? secondaryResetAt
    : primaryPercent !== undefined ? primaryResetAt : secondaryResetAt;
  const monthlyPercent = primaryIsMonthly ? primaryPercent ?? tertiaryPercent : tertiaryPercent;
  const monthlyResetAt = primaryIsMonthly && primaryPercent !== undefined ? primaryResetAt : tertiaryResetAt;
  const trackFiveHour = !thirtyDayOnly
    && (isCodexFiveHourQuotaPlan(data.plan_type)
      // If WHAM omitted plan_type, an explicit 5h duration is still
      // unambiguous and should not be discarded from the display contract.
      || (data.plan_type == null && (primaryIsFiveHour || secondaryIsFiveHour)));
  let fiveHourPercent = trackFiveHour && primaryIsFiveHour ? primaryPercent : undefined;
  let fiveHourResetAt = trackFiveHour && primaryIsFiveHour ? primaryResetAt : undefined;
  if (trackFiveHour && secondaryIsFiveHour && fiveHourPercent === undefined) {
    fiveHourPercent = secondaryPercent;
    fiveHourResetAt = secondaryResetAt;
  }
  // Older dual-window payloads omitted durations. For Plus/Team/Business,
  // the primary+secondary pair is the legacy positional 5h+weekly shape.
  if (trackFiveHour && !primaryIsMonthly && !primaryIsFiveHour
    && primaryPercent !== undefined && secondaryPercent !== undefined
    && windowDurationSeconds(primaryWindow) === undefined
    && windowDurationSeconds(secondaryWindow) === undefined) {
    fiveHourPercent = primaryPercent;
    fiveHourResetAt = primaryResetAt;
    weeklyPercent = secondaryPercent;
    weeklyResetAt = secondaryResetAt;
  } else if (trackFiveHour && primaryIsFiveHour) {
    weeklyPercent = secondaryPercent;
    weeklyResetAt = secondaryResetAt;
  }
  if (thirtyDayOnly) {
    if (monthlyPercent !== undefined) {
      quota.monthlyPercent = monthlyPercent;
      if (monthlyResetAt !== undefined) quota.monthlyResetAt = monthlyResetAt;
    }
  } else if (weeklyPercent !== undefined) {
    quota.weeklyPercent = weeklyPercent;
    if (weeklyResetAt !== undefined) quota.weeklyResetAt = weeklyResetAt;
  }
  if (trackFiveHour && fiveHourPercent !== undefined) {
    quota.fiveHourPercent = fiveHourPercent;
    if (fiveHourResetAt !== undefined) quota.fiveHourResetAt = fiveHourResetAt;
  }
  if (!thirtyDayOnly && monthlyPercent !== undefined) {
    quota.monthlyPercent = monthlyPercent;
    if (monthlyResetAt !== undefined) quota.monthlyResetAt = monthlyResetAt;
  }
  if (resetCredits !== undefined) quota.resetCredits = resetCredits;

  return hasKnownQuotaValue(quota) || resetCredits !== undefined ? quota : null;
}
