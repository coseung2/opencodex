import { fetchMainAccountInfo, listCodexAuthAccounts } from "../codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/main-account";
import { resolveEnvValue } from "../config";
import { getValidAccessToken, getValidAccessTokenForAccount } from "../oauth";
import { getAccountCredential, getAccountSet, getCredential } from "../oauth/store";
import { readUsageEntries } from "../usage/log";
import { antigravityUserAgent } from "../adapters/client-fingerprint";
import { resolveKiroApiRegion, resolveKiroProfileArn } from "../oauth/kiro";
import type { KiroOAuthMetadata } from "../oauth/types";
import { getProviderRegistryEntry, providerCodexAccountMode } from "./registry";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "./openai-tiers";
import {
  captureConfigGeneration,
  sweepExpiredOnWrite,
  type GenerationContext,
} from "../lib/state-store-sweeper";

/** Match oauth/index REFRESH_SKEW_MS — use stored access without refresh when still fresh. */
const ACCOUNT_TOKEN_SKEW_MS = 60_000;

const CACHE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
/** Kiro's getUsageLimits endpoint cold-starts slowly after idle periods (>8s seen); keep a
 *  dedicated, more generous bound so a flaky first hit does not drop the provider into the
 *  "no quota" bucket for the rest of the negative-cache window. */
const KIRO_QUOTA_TIMEOUT_MS = 20_000;
const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_CODE_USAGE_URL = `${KIMI_CODE_BASE_URL}/usages`;
const KIRO_USAGE_LIMITS_PATH = "getUsageLimits";
/** Keep a failed probe's previous row at most this long before dropping it. */
const LAST_GOOD_MAX_AGE_MS = 30 * 60_000;

const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const OPENCODE_GO_COST_WINDOW_MS = 30 * 86_400_000;
const OPENCODE_GO_FIVE_HOUR_MS = 5 * 3_600_000;
const OPENCODE_GO_WEEK_MS = 7 * 86_400_000;

/** opencode.go published request limits per window (1x tier), opencode.ai/docs/go. */
const OPENCODE_GO_LIMITS: Record<string, { label: string; fiveHour: number; weekly: number; monthly: number }> = {
  "grok-4.5": { label: "Grok 4.5", fiveHour: 120, weekly: 300, monthly: 600 },
  "gpt-5.6-luna": { label: "GPT 5.6 Luna", fiveHour: 2_050, weekly: 5_100, monthly: 10_250 },
  "glm-5.2": { label: "GLM-5.2", fiveHour: 880, weekly: 2_150, monthly: 4_300 },
  "glm-5.1": { label: "GLM-5.1", fiveHour: 880, weekly: 2_150, monthly: 4_300 },
  "kimi-k3": { label: "Kimi K3", fiveHour: 110, weekly: 250, monthly: 490 },
  "kimi-k2.7-code": { label: "Kimi K2.7 Code", fiveHour: 1_350, weekly: 3_380, monthly: 6_750 },
  "kimi-k2.6": { label: "Kimi K2.6", fiveHour: 1_150, weekly: 2_880, monthly: 5_750 },
  "mimo-v2.5": { label: "MiMo-V2.5", fiveHour: 30_100, weekly: 75_200, monthly: 150_400 },
  "mimo-v2.5-pro": { label: "MiMo-V2.5 Pro", fiveHour: 3_250, weekly: 8_150, monthly: 16_300 },
  "minimax-m3": { label: "MiniMax M3", fiveHour: 3_200, weekly: 8_000, monthly: 16_000 },
  "minimax-m2.7": { label: "MiniMax M2.7", fiveHour: 3_400, weekly: 8_500, monthly: 17_000 },
  "qwen3.8-max": { label: "Qwen3.8 Max", fiveHour: 160, weekly: 400, monthly: 810 },
  "qwen3.7-max": { label: "Qwen3.7 Max", fiveHour: 340, weekly: 840, monthly: 1_690 },
  "qwen3.7-plus": { label: "Qwen3.7 Plus", fiveHour: 4_300, weekly: 10_800, monthly: 21_600 },
  "qwen3.6-plus": { label: "Qwen3.6 Plus", fiveHour: 3_300, weekly: 8_200, monthly: 16_300 },
  "deepseek-v4-pro": { label: "DeepSeek V4 Pro", fiveHour: 3_450, weekly: 8_550, monthly: 17_150 },
  "deepseek-v4-flash": { label: "DeepSeek V4 Flash", fiveHour: 31_650, weekly: 79_050, monthly: 158_150 },
  "hy3": { label: "Hy3", fiveHour: 4_300, weekly: 10_750, monthly: 21_500 },
};

export interface ProviderQuotaWindow {
  label: string;
  percent: number;
  resetAt?: number;
  /** Text value shown instead of a percent bar (e.g. an estimated cost). */
  valueLabel?: string;
  /** Compact percent segments rendered as narrow bars on ONE row (label/percent per segment). */
  segments?: { label: string; percent: number; resetAt?: number }[];
}

export interface ProviderQuota {
  fiveHourPercent?: number;
  fiveHourResetAt?: number;
  weeklyPercent?: number;
  weeklyResetAt?: number;
  monthlyPercent?: number;
  monthlyResetAt?: number;
  customWindows?: ProviderQuotaWindow[];
  updatedAt: number;
}

export interface ProviderQuotaReport {
  provider: string;
  label: string;
  source: string;
  quota: ProviderQuota;
  updatedAt: number;
  reverseEngineered?: boolean;
}

export interface ProviderQuotaResponse {
  generatedAt: number;
  reports: ProviderQuotaReport[];
}

let cache: { key: string; ts: number; response: ProviderQuotaResponse } | null = null;
const inflight = new Map<string, { epoch: number; promise: Promise<ProviderQuotaResponse> }>();
/** Bumped on cache clear and on force-refresh start; stale-epoch probes lose commit authority. */
let invalidationEpoch = 0;

/** Invalidate the report cache (e.g. after switching a provider's active account). */
export function clearProviderQuotaCache(): void {
  cache = null;
  invalidationEpoch += 1;
}

function cacheKey(config: OcxConfig): string {
  const providers = Object.entries(config.providers)
    .map(([name, provider]) => `${name}:${provider.adapter}:${provider.authMode ?? "key"}:${providerCodexAccountMode(name, provider) ?? "none"}:${provider.disabled === true ? "off" : "on"}:${provider.baseUrl}`)
    .sort()
    .join("|");
  return `${config.defaultProvider}|${config.activeCodexAccountId ?? ""}|${providers}`;
}

function hasQuotaRows(quota: ProviderQuota | null | undefined): quota is ProviderQuota {
  if (!quota) return false;
  return typeof quota.fiveHourPercent === "number"
    || typeof quota.weeklyPercent === "number"
    || typeof quota.monthlyPercent === "number"
    || !!quota.customWindows?.some(window =>
      typeof window.percent === "number" || typeof window.valueLabel === "string");
}

function providerLabel(providerId: string): string {
  return getProviderRegistryEntry(providerId)?.label ?? providerId;
}

function normalizeResetAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    // Cursor Connect RPC returns billingCycleEnd as a unix-ms decimal string ("1771077734000").
    // Date.parse treats that as invalid; numeric epoch strings must be handled explicitly.
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizePercent(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  return numeric === undefined ? undefined : Math.max(0, Math.min(100, numeric));
}

/** Numeric value from a billing object ({ val: 123 }) or a bare number. */
function billingValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const record = asRecord(value);
  return toFiniteNumber(record?.val);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isBuiltInChatGptForwardProvider(name: string, provider: OcxProviderConfig): boolean {
  return name === OPENAI_CODEX_PROVIDER_ID && isCanonicalOpenAiForwardProvider(provider);
}

function report(provider: string, source: string, quota: ProviderQuota): ProviderQuotaReport | null {
  if (!hasQuotaRows(quota)) return null;
  return {
    provider,
    label: providerLabel(provider),
    source,
    quota,
    updatedAt: quota.updatedAt,
  };
}

async function fetchChatGptForwardQuota(
  config: OcxConfig,
  provider: string,
  providerConfig: OcxProviderConfig,
  forceRefresh: boolean,
): Promise<ProviderQuotaReport | null> {
  if (providerCodexAccountMode(provider, providerConfig) === "direct") {
    const main = await fetchMainAccountInfo(forceRefresh);
    const quota = main.quota ? { ...main.quota, updatedAt: Date.now() } as ProviderQuota : null;
    return quota ? report(provider, "chatgpt:wham", quota) : null;
  }
  const accounts = await listCodexAuthAccounts(config, forceRefresh);
  const activeId = config.activeCodexAccountId || MAIN_CODEX_ACCOUNT_ID;
  const active = accounts.find(account => account.id === activeId)
    ?? accounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID)
    ?? accounts[0];
  const quota = active?.quota ? { ...active.quota, updatedAt: active.quota.updatedAt ?? Date.now() } as ProviderQuota : null;
  return quota ? report(provider, "chatgpt:wham", quota) : null;
}

async function fetchXaiQuota(provider: string): Promise<ProviderQuotaReport | null> {
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken("xai");
  } catch {
    return null;
  }
  const response = await fetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-grok-client-mode": "cli",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = asRecord(await response.json().catch(() => null));
  const config = asRecord(body?.config);
  const currentPeriod = asRecord(config?.currentPeriod);
  // A weekly window is the meter contract; other shapes (spend-cap etc.) fail closed.
  if (currentPeriod?.type !== "USAGE_PERIOD_TYPE_WEEKLY") return null;
  if (typeof currentPeriod.end !== "string" || !currentPeriod.end.trim()) return null;
  const resetAt = normalizeResetAt(currentPeriod.end);
  if (resetAt === undefined) return null;

  let weeklyPercent: number | undefined;
  if (typeof config?.creditUsagePercent === "number"
    && Number.isFinite(config.creditUsagePercent)
    && config.creditUsagePercent >= 0
    && config.creditUsagePercent <= 100) {
    weeklyPercent = config.creditUsagePercent;
  } else {
    // Unified-billing shape exposes on-demand usage vs cap as { val } objects.
    const cap = billingValue(config?.onDemandCap);
    const used = billingValue(config?.onDemandUsed);
    if (cap !== undefined && cap > 0 && used !== undefined) {
      weeklyPercent = normalizePercent((used / cap) * 100);
    } else if (used === 0) {
      // A zero-usage unified account still owns the weekly meter; report 0% so the
      // provider stays in the usage section instead of being reclassified as no-quota.
      weeklyPercent = 0;
    }
  }
  if (weeklyPercent === undefined) return null;
  const quota: ProviderQuota = {
    weeklyPercent,
    weeklyResetAt: resetAt,
    updatedAt: Date.now(),
  };
  return report(provider, "xai:grok-credits", quota);
}

function parseClaudeBucket(value: unknown): { percent?: number; resetAt?: number } | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const percent = normalizePercent(rec.utilization);
  const resetAt = normalizeResetAt(rec.resets_at);
  if (percent === undefined && resetAt === undefined) return null;
  return { percent, resetAt };
}

function kiroCreditRow(body: Record<string, unknown>): Record<string, unknown> | null {
  const rows = Array.isArray(body.usageBreakdownList) ? body.usageBreakdownList : [];
  const credit = rows
    .map(row => asRecord(row))
    .find((row): row is Record<string, unknown> => row?.resourceType === "CREDIT");
  return credit ?? asRecord(body.usageBreakdown);
}

/**
 * Probe one Kiro credential using only that account's persisted routing metadata.
 * Passing an explicit metadata object is load-bearing: the Kiro resolvers then
 * cannot borrow environment or local-CLI state from a different account.
 */
async function fetchKiroUsageQuota(
  accessToken: string,
  metadata: Pick<KiroOAuthMetadata, "profileArn" | "apiRegion" | "ssoRegion">,
): Promise<ProviderQuota | null> {
  const region = resolveKiroApiRegion(metadata);
  const profileArn = resolveKiroProfileArn(metadata);
  const url = new URL(`https://q.${region}.amazonaws.com/${KIRO_USAGE_LIMITS_PATH}`);
  url.searchParams.set("origin", "KIRO_CLI");
  url.searchParams.set("resourceType", "AGENTIC_REQUEST");
  if (profileArn) url.searchParams.set("profileArn", profileArn);

  const response = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(KIRO_QUOTA_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = asRecord(await response.json().catch(() => null));
  if (!body) return null;
  const credit = kiroCreditRow(body);
  if (!credit) return null;

  const used = toFiniteNumber(credit.currentUsageWithPrecision)
    ?? toFiniteNumber(credit.currentUsage);
  const limit = toFiniteNumber(credit.usageLimitWithPrecision)
    ?? toFiniteNumber(credit.usageLimit);
  if (used === undefined || limit === undefined || limit <= 0) return null;
  const percent = normalizePercent((used / limit) * 100);
  if (percent === undefined) return null;
  const resetAt = normalizeResetAt(credit.nextDateReset)
    ?? normalizeResetAt(body.nextDateReset);
  return {
    monthlyPercent: percent,
    ...(resetAt !== undefined ? { monthlyResetAt: resetAt } : {}),
    updatedAt: Date.now(),
  };
}

/** Claude's OAuth usage endpoint, probed with ONE account's own bearer token. */
const anthropicUsageInflight = new Map<string, Promise<ProviderQuota | null>>();

async function fetchAnthropicUsageQuota(accessToken: string): Promise<ProviderQuota | null> {
  const joinable = anthropicUsageInflight.get(accessToken);
  if (joinable) return joinable;

  const probe = (async (): Promise<ProviderQuota | null> => {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": "claude-cli/2.1.63 (external, cli)",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = asRecord(await response.json().catch(() => null));
    if (!body) return null;
    const fiveHour = parseClaudeBucket(body.five_hour);
    const sevenDay = parseClaudeBucket(body.seven_day);
    const opus = parseClaudeBucket(body.seven_day_opus);
    const sonnet = parseClaudeBucket(body.seven_day_sonnet);
    const customWindows: ProviderQuotaWindow[] = [];
    if (opus?.percent !== undefined) customWindows.push({ label: "Opus", percent: opus.percent, ...(opus.resetAt !== undefined ? { resetAt: opus.resetAt } : {}) });
    if (sonnet?.percent !== undefined) customWindows.push({ label: "Sonnet", percent: sonnet.percent, ...(sonnet.resetAt !== undefined ? { resetAt: sonnet.resetAt } : {}) });
    const quota: ProviderQuota = {
      // Claude's 5-hour window is a first-class rate limit, same as the Codex login 5h/weekly
      // rows: report it in the canonical fields so the dashboard renders it with the standard
      // "5-hour limit" label and ordering instead of as a generic extra window.
      ...(fiveHour?.percent !== undefined ? { fiveHourPercent: fiveHour.percent } : {}),
      ...(fiveHour?.resetAt !== undefined ? { fiveHourResetAt: fiveHour.resetAt } : {}),
      ...(sevenDay?.percent !== undefined ? { weeklyPercent: sevenDay.percent } : {}),
      ...(sevenDay?.resetAt !== undefined ? { weeklyResetAt: sevenDay.resetAt } : {}),
      ...(customWindows.length > 0 ? { customWindows } : {}),
      updatedAt: Date.now(),
    };
    // Empty / schema-changed payloads must not cache as "success with no bars".
    return hasQuotaRows(quota) ? quota : null;
  })().finally(() => {
    if (anthropicUsageInflight.get(accessToken) === probe) anthropicUsageInflight.delete(accessToken);
  });
  anthropicUsageInflight.set(accessToken, probe);
  return probe;
}

async function fetchAnthropicQuota(provider: string): Promise<ProviderQuotaReport | null> {
  // Capture the account we intend to probe before awaiting — a mid-flight active
  // switch must not seed the wrong account's cache with this response.
  const probedAccountId = getAccountSet("anthropic")?.activeAccountId;
  const probedAccountKey = probedAccountId ? accountCacheKey("anthropic", probedAccountId) : null;
  const writerGeneration = captureConfigGeneration();
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken("anthropic");
  } catch {
    return null;
  }
  const quota = await fetchAnthropicUsageQuota(accessToken);
  if (!quota) return null;
  // Share the active-account probe with the per-account cache so Providers-page
  // loads do not double-hit Anthropic's rate-limited usage endpoint.
  if (probedAccountId && probedAccountKey) {
    const stillOwnsToken = getAccountCredential("anthropic", probedAccountId)?.access === accessToken;
    if (stillOwnsToken && mayCommitAccountQuotaKey(probedAccountKey, writerGeneration)) {
      accountQuotaCache.set(probedAccountKey, { ts: Date.now(), quota });
    }
  }
  return report(provider, "anthropic:oauth-usage", quota);
}

// ---------------------------------------------------------------------------
// Per-account quota (multiauth)
// ---------------------------------------------------------------------------

/**
 * Anthropic reports usage per CREDENTIAL, so every logged-in account can be probed with its
 * own bearer token — the active-account selection and the local usage log are irrelevant here.
 * Mirrors the Codex pool behaviour (codex/auth-api.ts:fetchPoolAccountQuota), including a
 * per-account TTL so N accounts cost at most N upstream calls per window.
 *
 * The TTL is deliberately longer than the provider-level one: this path multiplies by account
 * count, and Anthropic rate-limits the usage endpoint (observed 429 under repeated probing).
 */
const ACCOUNT_QUOTA_TTL_MS = 10 * 60_000;
type AccountQuotaCacheEntry = {
  ts: number;
  quota: ProviderQuota | null;
  /** Last probe failed (429 / network / expired login); still may hold last-good quota. */
  unavailable?: true;
};
const accountQuotaCache = new Map<string, AccountQuotaCacheEntry>();
const accountQuotaInflight = new Map<string, Promise<AccountQuotaCacheEntry>>();
let lastReconciledGeneration = 0;
let liveAccountQuotaKeys = new Set<string>();
let liveProviderQuotaKeys = new Set<string>();

function mayCommitAccountQuotaKey(key: string, writerGeneration: number): boolean {
  return writerGeneration >= lastReconciledGeneration || liveAccountQuotaKeys.has(key);
}

function mayCommitProviderQuotaKey(key: string, writerGeneration: number): boolean {
  return writerGeneration >= lastReconciledGeneration || liveProviderQuotaKeys.has(key);
}

export interface ProviderAccountQuota {
  accountId: string;
  quota: ProviderQuota | null;
  /** Set when the probe could not reach upstream (expired login, 429, network). */
  unavailable?: true;
}

/** Providers whose per-account quota can be probed. Extend as other OAuth APIs are covered. */
export function supportsPerAccountQuota(provider: string): boolean {
  return provider === "anthropic" || provider === "kiro";
}

function accountCacheKey(provider: string, accountId: string): string {
  return `${provider}\u0000${accountId}`;
}

/**
 * Synchronous last-good per-account quota read for routing. Never probes the network.
 * Returns null when nothing is cached (or the cached row has no bars).
 */
export function getCachedProviderAccountQuota(provider: string, accountId: string): ProviderQuota | null {
  const entry = accountQuotaCache.get(accountCacheKey(provider, accountId));
  return entry?.quota ?? null;
}

/** Test-only: seed or clear the per-account quota cache without probing upstream. */
export function setCachedProviderAccountQuotaForTests(
  provider: string,
  accountId: string,
  quota: ProviderQuota | null,
): void {
  const key = accountCacheKey(provider, accountId);
  if (quota === null) {
    accountQuotaCache.delete(key);
    return;
  }
  accountQuotaCache.set(key, { ts: Date.now(), quota });
}

export function sweepExpiredProviderAccountQuotaRows(now = Date.now()): number {
  let removed = 0;
  for (const [key, entry] of accountQuotaCache) {
    if (entry.ts + ACCOUNT_QUOTA_TTL_MS > now) continue;
    accountQuotaCache.delete(key);
    removed += 1;
  }
  return removed;
}

export function reconcileProviderAccountQuotaRows(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  let removed = 0;
  for (const key of accountQuotaCache.keys()) {
    if (context.oauthAccountKeys.has(key)) continue;
    accountQuotaCache.delete(key);
    removed += 1;
  }
  if (cache) {
    const reports = cache.response.reports.filter(report => context.providerNames.has(report.provider));
    removed += cache.response.reports.length - reports.length;
    cache = { ...cache, response: { ...cache.response, reports } };
  }
  liveAccountQuotaKeys = new Set(context.oauthAccountKeys);
  liveProviderQuotaKeys = new Set(context.providerNames);
  lastReconciledGeneration = context.generation;
  return removed;
}

/** Drop cached per-account rows (all, or just one provider's). */
export function clearAccountQuotaCache(provider?: string): void {
  if (!provider) {
    accountQuotaCache.clear();
    accountQuotaInflight.clear();
    return;
  }
  const prefix = `${provider}\u0000`;
  for (const key of [...accountQuotaCache.keys()]) {
    if (key.startsWith(prefix)) accountQuotaCache.delete(key);
  }
  // Drop in-flight probes too so a late resolve cannot repopulate after logout/remove.
  for (const key of [...accountQuotaInflight.keys()]) {
    if (key.startsWith(prefix)) accountQuotaInflight.delete(key);
  }
}

/**
 * Resolve a bearer for quota probing without silently adopting a newer global
 * Claude CLI credential into a background multiauth slot.
 *
 * - Fresh stored access → use as-is (no refresh).
 * - Active account with expired access → normal refresh path.
 * - Background `local-cli` with expired access → fail closed (unavailable):
 *   `getValidAccessTokenForAccount` can persist a mismatched Claude CLI identity.
 * - Background ordinary OAuth (`source !== "local-cli"`) → safe to refresh;
 *   Anthropic's lock only adopts disk credentials for `local-cli` rows.
 */
async function getTokenForAccountQuotaProbe(provider: string, accountId: string): Promise<string> {
  const stored = getAccountCredential(provider, accountId);
  if (!stored) throw new Error("account credential missing");
  if (stored.expires > Date.now() + ACCOUNT_TOKEN_SKEW_MS) return stored.access;
  const activeId = getAccountSet(provider)?.activeAccountId;
  if (activeId !== accountId && stored.source === "local-cli") {
    throw new Error("background local-cli token expired; skip CLI-adopting refresh for quota probe");
  }
  return getValidAccessTokenForAccount(provider, accountId);
}

async function fetchUsageQuotaForAccount(
  provider: string,
  accountId: string,
  accessToken: string,
): Promise<ProviderQuota | null> {
  if (provider === "anthropic") return fetchAnthropicUsageQuota(accessToken);
  if (provider === "kiro") {
    const credential = getAccountCredential(provider, accountId);
    if (!credential || credential.access !== accessToken) {
      throw new Error("account credential changed during Kiro quota probe");
    }
    return fetchKiroUsageQuota(accessToken, credential.kiro ?? {});
  }
  return null;
}

async function fetchAccountQuota(
  provider: string,
  accountId: string,
  forceRefresh: boolean,
): Promise<AccountQuotaCacheEntry> {
  const key = accountCacheKey(provider, accountId);
  const writerGeneration = captureConfigGeneration();
  const cached = accountQuotaCache.get(key);
  if (!forceRefresh && cached && Date.now() - cached.ts < ACCOUNT_QUOTA_TTL_MS) return cached;
  const joinable = accountQuotaInflight.get(key);
  if (joinable) return joinable;

  const probe = (async (): Promise<AccountQuotaCacheEntry> => {
    try {
      const token = await getTokenForAccountQuotaProbe(provider, accountId);
      const quota = await fetchUsageQuotaForAccount(provider, accountId, token);
      if (!quota) {
        // Preserve last-good bars and mark unavailable; advance TTL so failures
        // negative-cache instead of re-probing on every GUI poll.
        const entry: AccountQuotaCacheEntry = {
          ts: Date.now(),
          quota: cached?.quota ?? null,
          unavailable: true,
        };
        if (mayCommitAccountQuotaKey(key, writerGeneration)) {
          accountQuotaCache.set(key, entry);
          sweepExpiredOnWrite(entry.ts);
        }
        return entry;
      }
      const entry: AccountQuotaCacheEntry = { ts: Date.now(), quota };
      if (mayCommitAccountQuotaKey(key, writerGeneration)) {
        accountQuotaCache.set(key, entry);
        sweepExpiredOnWrite(entry.ts);
      }
      return entry;
    } catch {
      const entry: AccountQuotaCacheEntry = {
        ts: Date.now(),
        quota: cached?.quota ?? null,
        unavailable: true,
      };
      if (mayCommitAccountQuotaKey(key, writerGeneration)) {
        accountQuotaCache.set(key, entry);
        sweepExpiredOnWrite(entry.ts);
      }
      return entry;
    }
  })().finally(() => {
    if (accountQuotaInflight.get(key) === probe) accountQuotaInflight.delete(key);
  });
  accountQuotaInflight.set(key, probe);
  return probe;
}

/**
 * Per-account quota rows for a provider's logged-in accounts. Probes run in parallel; a
 * single failing account never blocks the others.
 */
export async function fetchProviderAccountQuotas(
  provider: string,
  forceRefresh = false,
): Promise<ProviderAccountQuota[]> {
  if (!supportsPerAccountQuota(provider)) return [];
  const set = getAccountSet(provider);
  if (!set) return [];
  return await Promise.all(set.accounts.map(async account => {
    const entry = await fetchAccountQuota(provider, account.id, forceRefresh);
    return {
      accountId: account.id,
      quota: entry.quota,
      ...(entry.unavailable ? { unavailable: true as const } : {}),
    };
  }));
}

async function fetchKiroQuota(provider: string, forceRefresh: boolean): Promise<ProviderQuotaReport | null> {
  const activeAccountId = getAccountSet("kiro")?.activeAccountId;
  if (!activeAccountId) return null;
  const entry = await fetchAccountQuota("kiro", activeAccountId, forceRefresh);
  return entry.quota ? report(provider, "kiro:getUsageLimits", entry.quota) : null;
}

function normalizedBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.search || url.hash) return null;
    return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function quotaResetAt(row: Record<string, unknown>): number | undefined {
  return normalizeResetAt(row.resetTime ?? row.resetAt ?? row.reset_time ?? row.reset_at);
}

function isCanonicalKimiCodeBaseUrl(baseUrl: string): boolean {
  return normalizedBaseUrl(baseUrl) === KIMI_CODE_BASE_URL;
}

/** Prefer the nested `data` shell when the outer object is only an envelope. */
function unwrapKimiQuotaPayload(value: unknown): Record<string, unknown> | null {
  const body = asRecord(value);
  if (!body) return null;
  const nested = asRecord(body.data);
  if (!nested) return body;
  // A null/non-usable outer field is a placeholder, not data — an envelope like
  // { usage: null, data: { usage: {...} } } must still unwrap to the nested payload.
  const usable = (field: unknown): boolean => field !== undefined && field !== null;
  const outerHasUsage = usable(body.usage) || usable(body.limits) || usable(body.totalQuota);
  const nestedHasUsage = usable(nested.usage) || usable(nested.limits) || usable(nested.totalQuota);
  return !outerHasUsage && nestedHasUsage ? nested : body;
}

function kimiLimitLabel(item: Record<string, unknown>, detail: Record<string, unknown>): string {
  return [item.name, item.title, item.scope, detail.name, detail.title]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function parseKimiQuotaRow(value: unknown, resetFallback?: Record<string, unknown>): { percent: number; resetAt?: number } | null {
  const row = asRecord(value);
  if (!row) return null;
  const resetAt = quotaResetAt(row) ?? (resetFallback ? quotaResetAt(resetFallback) : undefined);
  const limit = toFiniteNumber(row.limit);
  if (limit !== undefined && limit > 0) {
    let used = toFiniteNumber(row.used);
    if (used === undefined) {
      const remaining = toFiniteNumber(row.remaining);
      if (remaining !== undefined) used = limit - remaining;
    }
    if (used !== undefined) {
      const percent = normalizePercent((used / limit) * 100);
      if (percent !== undefined) return { percent, ...(resetAt !== undefined ? { resetAt } : {}) };
    }
  }
  // Some payloads expose utilisation directly when limit/used arithmetic is absent.
  const direct = normalizePercent(row.utilization ?? row.percent ?? row.usedPercent ?? row.used_percent);
  return direct === undefined ? null : { percent: direct, ...(resetAt !== undefined ? { resetAt } : {}) };
}

function isKimiFiveHourLimit(item: Record<string, unknown>, detail: Record<string, unknown>, window: Record<string, unknown>): boolean {
  const duration = toFiniteNumber(window.duration ?? item.duration ?? detail.duration);
  const unit = String(window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? "").toUpperCase();
  if ((unit.includes("MINUTE") && duration === 300) || (unit.includes("HOUR") && duration === 5)) return true;
  return /(^|\b)5\s*(?:h|hour)/.test(kimiLimitLabel(item, detail));
}

function isKimiWeeklyLimit(item: Record<string, unknown>, detail: Record<string, unknown>, window: Record<string, unknown>): boolean {
  const duration = toFiniteNumber(window.duration ?? item.duration ?? detail.duration);
  const unit = String(window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? "").toUpperCase();
  if ((unit.includes("DAY") && duration === 7) || (unit.includes("HOUR") && duration === 168)) return true;
  return /weekly|7\s*(?:d|day)/.test(kimiLimitLabel(item, detail));
}

function parseKimiQuotaPayload(value: unknown): ProviderQuota | null {
  const body = unwrapKimiQuotaPayload(value);
  if (!body) return null;
  let weekly = parseKimiQuotaRow(body.usage);
  const total = parseKimiQuotaRow(body.totalQuota);
  let fiveHour: { percent: number; resetAt?: number } | null = null;
  if (Array.isArray(body.limits)) {
    for (const rawItem of body.limits) {
      const item = asRecord(rawItem);
      if (!item) continue;
      const detail = asRecord(item.detail) ?? item;
      const window = asRecord(item.window) ?? {};
      if (!fiveHour && isKimiFiveHourLimit(item, detail, window)) {
        fiveHour = parseKimiQuotaRow(detail, window);
      }
      if (!weekly && isKimiWeeklyLimit(item, detail, window)) {
        weekly = parseKimiQuotaRow(detail, window);
      }
      if (fiveHour && weekly) break;
    }
  }
  const quota: ProviderQuota = {
    ...(fiveHour ? {
      fiveHourPercent: fiveHour.percent,
      ...(fiveHour.resetAt !== undefined ? { fiveHourResetAt: fiveHour.resetAt } : {}),
    } : {}),
    ...(weekly ? {
      weeklyPercent: weekly.percent,
      ...(weekly.resetAt !== undefined ? { weeklyResetAt: weekly.resetAt } : {}),
    } : {}),
    ...(total ? { customWindows: [{ label: "Total subscription credits", percent: total.percent, ...(total.resetAt !== undefined ? { resetAt: total.resetAt } : {}) }] } : {}),
    updatedAt: Date.now(),
  };
  return hasQuotaRows(quota) ? quota : null;
}

async function resolveKimiQuotaBearer(config: OcxProviderConfig): Promise<string | null> {
  if (config.authMode === "oauth") {
    try {
      return await getValidAccessToken("kimi");
    } catch {
      return null;
    }
  }
  // ACTIVE key only: silently walking apiKeyPool when the primary env reference is
  // unresolved would render a quota bar for a DIFFERENT account than the one routing
  // requests — a wrong meter is worse than no meter.
  const primary = resolveEnvValue(config.apiKey)?.trim();
  return primary || null;
}

async function fetchKimiQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaReport | null> {
  // Never release credentials to a user-edited or lookalike provider host.
  if (!isCanonicalKimiCodeBaseUrl(config.baseUrl)) return null;
  const accessToken = await resolveKimiQuotaBearer(config);
  if (!accessToken) return null;
  const response = await fetch(KIMI_CODE_USAGE_URL, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const quota = parseKimiQuotaPayload(await response.json().catch(() => null));
  return quota ? report(provider, "kimi:usages", quota) : null;
}

function isCanonicalOpencodeGoBaseUrl(baseUrl: string | undefined): boolean {
  return normalizedBaseUrl(baseUrl ?? "") === normalizedBaseUrl(OPENCODE_GO_BASE_URL);
}

interface OpencodeGoUsageEstimate {
  /** model -> request count in each window (status 200). */
  fiveHourCounts: Map<string, number>;
  weeklyCounts: Map<string, number>;
  monthlyCounts: Map<string, number>;
  /** key id -> 30-day request count (all traffic attributed to the active key). */
  perKeyMonthlyCounts: Map<string, number>;
}

/**
 * Read the local usage log once and count opencode.go requests per model per window.
 * The console's allocation percent is request-count based (each model has published
 * 5h/week/month request limits on opencode.ai/docs/go), so we compare like with like.
 *
 * Attribution: the pool's ACTIVE key serves every provider-bound request (loopback
 * traffic carries no client key id), so all rows are charged to it. Rows written before
 * a key switch stay with the currently active key — an intentional approximation.
 */
function estimateOpencodeGoUsage(name: string, config: OcxProviderConfig): OpencodeGoUsageEstimate | null {
  if (!isCanonicalOpencodeGoBaseUrl(config.baseUrl)) return null;
  const now = Date.now();
  const fiveHourAgo = now - OPENCODE_GO_FIVE_HOUR_MS;
  const monthAgo = now - OPENCODE_GO_COST_WINDOW_MS;
  const pool = config.apiKeyPool ?? [];
  const activeKey = resolveEnvValue(config.apiKey)?.trim() ?? config.apiKey;
  const activeKeyId = activeKey ? pool.find(entry => entry.key === activeKey)?.id : undefined;

  const estimate: OpencodeGoUsageEstimate = {
    fiveHourCounts: new Map(),
    weeklyCounts: new Map(),
    monthlyCounts: new Map(),
    perKeyMonthlyCounts: new Map(pool.map(entry => [entry.id, 0])),
  };
  for (const entry of readUsageEntries()) {
    if (entry.provider !== name || entry.status !== 200) continue;
    const timestamp = entry.timestamp ?? 0;
    if (!OPENCODE_GO_LIMITS[entry.model]) continue;
    if (timestamp >= fiveHourAgo) {
      estimate.fiveHourCounts.set(entry.model, (estimate.fiveHourCounts.get(entry.model) ?? 0) + 1);
    }
    if (timestamp >= now - OPENCODE_GO_WEEK_MS) {
      estimate.weeklyCounts.set(entry.model, (estimate.weeklyCounts.get(entry.model) ?? 0) + 1);
    }
    if (timestamp >= monthAgo && activeKeyId) {
      estimate.monthlyCounts.set(entry.model, (estimate.monthlyCounts.get(entry.model) ?? 0) + 1);
      estimate.perKeyMonthlyCounts.set(activeKeyId, (estimate.perKeyMonthlyCounts.get(activeKeyId) ?? 0) + 1);
    }
  }
  return estimate;
}

/**
 * One row with three narrow bars (5h / weekly / monthly) for the DOMINANT model —
 * the model with the most 30-day requests — compared against its published request
 * limits, mirroring the console's allocation display.
 */
function fetchOpencodeGoQuota(name: string, config: OcxProviderConfig): ProviderQuotaReport | null {
  const estimate = estimateOpencodeGoUsage(name, config);
  if (!estimate) return null;
  const dominant = [...estimate.monthlyCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (estimate.weeklyCounts.get(b[0]) ?? 0) - (estimate.weeklyCounts.get(a[0]) ?? 0))[0]?.[0];
  if (!dominant) return null;
  const { fiveHour, weekly, monthly } = OPENCODE_GO_LIMITS[dominant]!;
  const now = Date.now();

  const quota: ProviderQuota = {
    customWindows: [{
      label: "할당량",
      percent: 0,
      segments: [
        {
          label: "5h",
          percent: normalizePercent(((estimate.fiveHourCounts.get(dominant) ?? 0) / fiveHour) * 100) ?? 0,
          resetAt: now + OPENCODE_GO_FIVE_HOUR_MS,
        },
        {
          label: "주",
          percent: normalizePercent(((estimate.weeklyCounts.get(dominant) ?? 0) / weekly) * 100) ?? 0,
          resetAt: now + OPENCODE_GO_WEEK_MS,
        },
        {
          label: "월",
          percent: normalizePercent(((estimate.monthlyCounts.get(dominant) ?? 0) / monthly) * 100) ?? 0,
          resetAt: now + OPENCODE_GO_COST_WINDOW_MS,
        },
      ],
    }],
    updatedAt: now,
  };
  return report(name, "opencode-go:docs-estimate", quota);
}

/**
 * Per-key monthly-allocation percent for every connected key of a canonical
 * opencode.go provider, using the dominant model's published monthly request limit.
 */
export function opencodeGoKeyQuotaEstimates(config: OcxConfig, name: string): Record<string, ProviderQuota> | null {
  const provider = config.providers[name];
  if (!provider) return null;
  const estimate = estimateOpencodeGoUsage(name, provider);
  if (!estimate) return null;
  const dominant = [...estimate.monthlyCounts.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!dominant) return null;
  const monthlyLimit = OPENCODE_GO_LIMITS[dominant]!.monthly;
  const now = Date.now();
  const out: Record<string, ProviderQuota> = {};
  for (const [keyId, count] of estimate.perKeyMonthlyCounts) {
    out[keyId] = {
      customWindows: [{
        label: "월간 할당",
        percent: normalizePercent((count / monthlyLimit) * 100) ?? 0,
        resetAt: now + OPENCODE_GO_COST_WINDOW_MS,
      }],
      updatedAt: now,
    };
  }
  return out;
}

/** Cursor included usage via api2.cursor.sh (Bearer from OAuth) — unofficial, may change. */
async function fetchCursorQuota(provider: string): Promise<ProviderQuotaReport | null> {
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken("cursor");
  } catch {
    return null;
  }

  const authHeaders = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "opencodex-quota",
  } as const;

  // Prefer dashboard period usage (Pro/Team/Ultra spend allowance in USD cents).
  // Field names follow Cursor's Connect RPC shape (limit/remaining/includedSpend), not usedCents.
  try {
    const periodRes = await fetch("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (periodRes.ok) {
      const body = asRecord(await periodRes.json().catch(() => null));
      const planUsage = asRecord(body?.planUsage);
      if (planUsage) {
        const resetAt = normalizeResetAt(body?.billingCycleEnd ?? planUsage.billingCycleEnd ?? body?.periodEnd);

        // Primary meter: overall included allowance (Cursor Settings → Usage total %).
        // autoPercentUsed / apiPercentUsed are secondary pools and must not replace the total.
        const limit = toFiniteNumber(planUsage.limit ?? planUsage.limitCents ?? planUsage.totalLimitCents);
        const remaining = toFiniteNumber(planUsage.remaining ?? planUsage.remainingCents);
        const includedSpend = toFiniteNumber(planUsage.includedSpend ?? planUsage.usedCents ?? planUsage.used);
        const totalSpend = toFiniteNumber(planUsage.totalSpend);
        let used: number | undefined;
        if (includedSpend !== undefined) used = includedSpend;
        else if (limit !== undefined && remaining !== undefined) used = Math.max(0, limit - remaining);
        else if (totalSpend !== undefined) used = totalSpend;
        const totalPercent = normalizePercent(planUsage.totalPercentUsed ?? planUsage.percentUsed)
          ?? (limit !== undefined && limit > 0 && used !== undefined
            ? normalizePercent((used / limit) * 100)
            : undefined);

        const autoPercent = normalizePercent(planUsage.autoPercentUsed);
        const apiPercent = normalizePercent(planUsage.apiPercentUsed);
        const customWindows: ProviderQuotaWindow[] = [];
        if (autoPercent !== undefined) {
          customWindows.push({
            label: "First-party models",
            percent: autoPercent,
            ...(resetAt !== undefined ? { resetAt } : {}),
          });
        }
        if (apiPercent !== undefined) {
          customWindows.push({
            label: "API usage",
            percent: apiPercent,
            ...(resetAt !== undefined ? { resetAt } : {}),
          });
        }

        if (totalPercent !== undefined || customWindows.length > 0) {
          const built = report(provider, "cursor:period-usage", {
            ...(totalPercent !== undefined ? {
              monthlyPercent: totalPercent,
              ...(resetAt !== undefined ? { monthlyResetAt: resetAt } : {}),
            } : {}),
            ...(customWindows.length > 0 ? { customWindows } : {}),
            updatedAt: Date.now(),
          });
          if (built) return { ...built, reverseEngineered: true };
        }
      }
    }
  } catch {
    /* fall through */
  }

  // /api/usage/summary — same host, sometimes richer than /auth/usage for Team plans.
  try {
    const summaryRes = await fetch("https://api2.cursor.sh/api/usage/summary", {
      headers: authHeaders,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (summaryRes.ok) {
      const body = asRecord(await summaryRes.json().catch(() => null));
      const individual = asRecord(body?.individualUsage);
      const plan = asRecord(individual?.plan);
      if (plan) {
        const used = toFiniteNumber(plan.used);
        const limit = toFiniteNumber(plan.limit);
        const percent = normalizePercent(plan.totalPercentUsed)
          ?? (used !== undefined && limit !== undefined && limit > 0
            ? normalizePercent((used / limit) * 100)
            : undefined);
        if (percent !== undefined) {
          const built = report(provider, "cursor:usage-summary", {
            monthlyPercent: percent,
            monthlyResetAt: normalizeResetAt(body?.billingCycleEnd),
            updatedAt: Date.now(),
          });
          if (built) return { ...built, reverseEngineered: true };
        }
      }
    }
  } catch {
    /* fall through to /auth/usage */
  }

  const response = await fetch("https://api2.cursor.sh/auth/usage", {
    headers: authHeaders,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = asRecord(await response.json().catch(() => null));
  if (!body) return null;

  // Prefer the gpt-4 bucket (historical "fast requests"); else first model with used+limit.
  let used: number | undefined;
  let limit: number | undefined;
  const gpt4 = asRecord(body["gpt-4"]);
  if (gpt4) {
    used = toFiniteNumber(gpt4.numRequests ?? gpt4.used);
    limit = toFiniteNumber(gpt4.maxRequestUsage ?? gpt4.limit ?? gpt4.maxRequests);
  }
  if (used === undefined || limit === undefined || limit <= 0) {
    for (const [key, value] of Object.entries(body)) {
      if (key === "startOfMonth" || key === "billingCycleStart") continue;
      const bucket = asRecord(value);
      if (!bucket) continue;
      const bucketUsed = toFiniteNumber(bucket.numRequests ?? bucket.used);
      const bucketLimit = toFiniteNumber(bucket.maxRequestUsage ?? bucket.limit ?? bucket.maxRequests);
      if (bucketUsed !== undefined && bucketLimit !== undefined && bucketLimit > 0) {
        used = bucketUsed;
        limit = bucketLimit;
        break;
      }
    }
  }
  if (used === undefined || limit === undefined || limit <= 0) return null;
  const percent = normalizePercent((used / limit) * 100);
  if (percent === undefined) return null;
  const startOfMonth = normalizeResetAt(body.startOfMonth ?? body.billingCycleStart);
  // Next reset = same day next month, computed in UTC to avoid timezone-shifted rollover.
  const monthlyResetAt = startOfMonth !== undefined
    ? (() => {
        const start = new Date(startOfMonth);
        return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate());
      })()
    : undefined;
  const built = report(provider, "cursor:auth-usage", {
    monthlyPercent: percent,
    ...(monthlyResetAt !== undefined ? { monthlyResetAt } : {}),
    updatedAt: Date.now(),
  });
  return built ? { ...built, reverseEngineered: true } : null;
}

function quotaInfoEntries(modelInfo: Record<string, unknown>): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const add = (value: unknown, tier?: string) => {
    const rec = asRecord(value);
    if (!rec) return;
    entries.push(tier ? { ...rec, tier } : rec);
  };
  const addArray = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) add(entry);
  };

  if (Array.isArray(modelInfo.quotaInfo)) addArray(modelInfo.quotaInfo);
  else add(modelInfo.quotaInfo);
  addArray(modelInfo.quotaInfos);

  const byTier = asRecord(modelInfo.quotaInfoByTier);
  if (byTier) {
    for (const [tier, value] of Object.entries(byTier)) {
      if (Array.isArray(value)) {
        for (const entry of value) add(entry, tier);
      } else {
        add(value, tier);
      }
    }
  }
  return entries;
}

function classifyAntigravityFamily(modelId: string, modelInfo: Record<string, unknown>, quotaInfo: Record<string, unknown>): "Gem" | "Cla" | null {
  const displayName = typeof modelInfo.displayName === "string" ? modelInfo.displayName : "";
  const tier = typeof quotaInfo.tier === "string" ? quotaInfo.tier : "";
  const haystack = `${modelId} ${displayName} ${tier}`.toLowerCase();
  if (haystack.includes("gemini")) return "Gem";
  if (haystack.includes("claude") || haystack.includes("opus") || haystack.includes("sonnet") || haystack.includes("gpt-oss") || haystack.includes("gpt_oss")) return "Cla";
  return null;
}

function antigravityUsedPercent(quotaInfo: Record<string, unknown>): number | undefined {
  const remaining = normalizePercent(toFiniteNumber(quotaInfo.remainingFraction) !== undefined
    ? toFiniteNumber(quotaInfo.remainingFraction)! * 100
    : toFiniteNumber(quotaInfo.remainingPercentage) !== undefined
      ? toFiniteNumber(quotaInfo.remainingPercentage)! * 100
      : undefined);
  if (remaining === undefined) return undefined;
  return normalizePercent(100 - remaining);
}

async function fetchAntigravityQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaReport | null> {
  const credential = getCredential("google-antigravity");
  if (!credential?.projectId) return null;
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken("google-antigravity");
  } catch {
    return null;
  }
  const baseUrl = (config.baseUrl || "https://daily-cloudcode-pa.googleapis.com").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": antigravityUserAgent(),
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ project: credential.projectId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = asRecord(await response.json().catch(() => null));
  const models = asRecord(body?.models);
  if (!models) return null;

  const windows = new Map<string, ProviderQuotaWindow>();
  for (const [modelId, rawModelInfo] of Object.entries(models)) {
    const modelInfo = asRecord(rawModelInfo);
    if (!modelInfo) continue;
    for (const quotaInfo of quotaInfoEntries(modelInfo)) {
      const label = classifyAntigravityFamily(modelId, modelInfo, quotaInfo);
      if (!label || windows.has(label)) continue;
      const percent = antigravityUsedPercent(quotaInfo);
      if (percent === undefined) continue;
      windows.set(label, {
        label,
        percent,
        ...(normalizeResetAt(quotaInfo.resetTime) !== undefined ? { resetAt: normalizeResetAt(quotaInfo.resetTime) } : {}),
      });
    }
  }

  const customWindows = ["Gem", "Cla"].flatMap(label => {
    const window = windows.get(label);
    return window ? [window] : [];
  });
  if (customWindows.length === 0) return null;
  return report(provider, "google-antigravity:fetchAvailableModels", {
    customWindows,
    updatedAt: Date.now(),
  });
}

async function maybeFetchProviderQuota(
  name: string,
  provider: OcxProviderConfig,
  config: OcxConfig,
  forceRefresh: boolean,
): Promise<ProviderQuotaReport | null> {
  if (provider.disabled === true) return null;
  try {
    if (isBuiltInChatGptForwardProvider(name, provider)) return fetchChatGptForwardQuota(config, name, provider, forceRefresh);
    if (provider.authMode === "oauth" && name === "xai") return fetchXaiQuota(name);
    if (provider.authMode === "oauth" && name === "anthropic") return fetchAnthropicQuota(name);
    if (provider.authMode === "oauth" && name === "kiro") return fetchKiroQuota(name, forceRefresh);
    if (provider.authMode === "oauth" && name === "cursor") return fetchCursorQuota(name);
    if (provider.authMode === "oauth" && name === "google-antigravity") return fetchAntigravityQuota(name, provider);
    // opencode.go is a key-auth subscription: estimate usage locally from the traffic log.
    if (provider.authMode !== "oauth" && provider.authMode !== "forward"
      && isCanonicalOpencodeGoBaseUrl(provider.baseUrl)) {
      return fetchOpencodeGoQuota(name, provider);
    }
    // Kimi Code `/usages` accepts OAuth or coding-plan API keys, but only on the canonical
    // host and only for real key auth — forward/local modes carry no credential of ours.
    if (provider.authMode === "oauth" && name === "kimi") return fetchKimiQuota(name, provider);
    if (provider.authMode === "key" && isCanonicalKimiCodeBaseUrl(provider.baseUrl)) {
      return fetchKimiQuota(name, provider);
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchProviderQuotaReports(config: OcxConfig, forceRefresh = false): Promise<ProviderQuotaResponse> {
  const key = cacheKey(config);
  const writerGeneration = captureConfigGeneration();
  const now = Date.now();
  // The cache fast path must not extend a preserved last-good row past its 30-minute bound:
  // a row preserved at age 29:59 plus a full 5-minute TTL would otherwise serve until ~35min.
  const cacheFresh = cache && cache.key === key && now - cache.ts < CACHE_TTL_MS
    && cache.response.reports.every(item => now - item.updatedAt < LAST_GOOD_MAX_AGE_MS);
  if (!forceRefresh && cacheFresh) return cache!.response;
  const joinable = inflight.get(key);
  if (!forceRefresh && joinable && joinable.epoch === invalidationEpoch) return joinable.promise;
  // A forced probe takes commit authority: older in-flight probes must not overwrite its result.
  if (forceRefresh) invalidationEpoch += 1;
  const epoch = invalidationEpoch;

  const promise = (async (): Promise<ProviderQuotaResponse> => {
    const previous = cache && cache.key === key ? cache.response.reports : [];
    const fresh = (await Promise.all(
      Object.entries(config.providers).map(([name, provider]) => maybeFetchProviderQuota(name, provider, config, forceRefresh)),
    )).filter((item): item is ProviderQuotaReport => item !== null);

    // Keep bounded last-good rows when a probe fails (e.g. transient upstream flake); never
    // re-stamp their timestamps, and drop rows older than LAST_GOOD_MAX_AGE_MS.
    // Note: the cache key encodes the provider set (name/adapter/authMode/disabled/baseUrl),
    // so previous rows always correspond to currently configured, enabled providers — a
    // disabled or removed provider changes the key and starts from an empty previous set.
    const cutoff = Date.now() - LAST_GOOD_MAX_AGE_MS;
    const byProvider = new Map<string, ProviderQuotaReport>();
    for (const item of previous) {
      if (item.updatedAt >= cutoff) byProvider.set(item.provider, item);
    }
    for (const item of fresh) byProvider.set(item.provider, item);

    const response = { generatedAt: Date.now(), reports: [...byProvider.values()] };
    // Commit only when this probe still holds authority (no clear/force superseded it).
    if (epoch === invalidationEpoch) {
      const reports = response.reports.filter(item => mayCommitProviderQuotaKey(item.provider, writerGeneration));
      cache = { key, ts: Date.now(), response: { ...response, reports } };
    }
    return response;
  })();

  const entry = { epoch, promise };
  inflight.set(key, entry);
  try {
    return await promise;
  } finally {
    if (inflight.get(key) === entry) inflight.delete(key);
  }
}
