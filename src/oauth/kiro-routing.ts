import { createHash } from "node:crypto";
import { isOauthAccountPaused } from "./account-pause";
import { getAccountSet, markAccountNeedsReauth, setActiveAccount } from "./store";
import { getValidAccessTokenSnapshotForAccount, type OAuthAccessSnapshot } from "./index";
import { fallbackCodexAccountLogLabel } from "../codex/account-label";
import { notePoolRotationFailure, POOL_KEY_KIRO } from "../codex/pool-rotation";
import { retainedUtf8Bytes } from "../lib/admission";
import { sweepExpiredOnWrite } from "../lib/state-store-sweeper";
import type { OcxConfig } from "../types";

const PROVIDER = "kiro";
const DEFAULT_COOLDOWN_SECONDS = 60;
const MAX_COOLDOWN_MS = 15 * 60_000;
const AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
const MAX_AFFINITY_ENTRIES = 2_000;
const MAX_AFFINITY_COMPONENT_BYTES = 512;
const DEFAULT_MAX_FAILOVERS_PER_REQUEST = 3;

interface AccountHealth { cooldownUntil: number; cooldownSource: "retry-after" | "default" }
interface AffinityEntry { accountId: string; lastUsedAt: number }

const upstreamHealth = new Map<string, AccountHealth>();
const sessionAffinity = new Map<string, AffinityEntry>();

export function isKiroAccountPoolEnabled(config: OcxConfig): boolean {
  return config.kiroAccountPool?.enabled === true;
}

export function kiroPoolMaxFailoversPerRequest(config: OcxConfig): number {
  const value = config.kiroAccountPool?.maxFailoversPerRequest;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 20
    ? value
    : DEFAULT_MAX_FAILOVERS_PER_REQUEST;
}

export function kiroPoolDefaultCooldownMs(config: OcxConfig): number {
  const value = config.kiroAccountPool?.defaultCooldownSeconds;
  const seconds = typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 900
    ? value
    : DEFAULT_COOLDOWN_SECONDS;
  return seconds * 1_000;
}

function normalizeComponent(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  return normalized && retainedUtf8Bytes(normalized) <= MAX_AFFINITY_COMPONENT_BYTES ? normalized : "";
}

function parseRetryAfterMs(value: string | null | undefined, now: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(Math.max(Math.ceil(seconds * 1000), 1), MAX_COOLDOWN_MS);
  }
  const delay = Date.parse(text) - now;
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, MAX_COOLDOWN_MS) : undefined;
}

export function getKiroAccountHealthSnapshot(accountId: string, now = Date.now()): AccountHealth | null {
  const health = upstreamHealth.get(accountId);
  if (!health) return null;
  if (health.cooldownUntil <= now) {
    upstreamHealth.delete(accountId);
    return null;
  }
  return { ...health };
}

export function clearKiroAccountCooldown(accountId: string): boolean {
  return upstreamHealth.delete(accountId);
}

export function sweepExpiredKiroRoutingHealth(now = Date.now()): number {
  let removed = 0;
  for (const [accountId, health] of upstreamHealth) {
    if (health.cooldownUntil > now) continue;
    upstreamHealth.delete(accountId);
    removed += 1;
  }
  return removed;
}

export function clearKiroAccountPoolState(): void {
  upstreamHealth.clear();
  sessionAffinity.clear();
}

function pruneAffinity(now: number): void {
  for (const [key, entry] of sessionAffinity) {
    if (now - entry.lastUsedAt > AFFINITY_IDLE_TTL_MS) sessionAffinity.delete(key);
  }
  if (sessionAffinity.size <= MAX_AFFINITY_ENTRIES) return;
  const oldest = [...sessionAffinity.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  for (let index = 0; index < sessionAffinity.size - MAX_AFFINITY_ENTRIES; index++) sessionAffinity.delete(oldest[index]![0]);
}

function eligibleAccounts(config: OcxConfig, now: number): string[] {
  const set = getAccountSet(PROVIDER);
  if (!set) return [];
  return set.accounts
    .filter(account => account.needsReauth !== true
      && !isOauthAccountPaused(config, PROVIDER, account.id)
      && getKiroAccountHealthSnapshot(account.id, now) === null)
    .map(account => account.id);
}

export function resolveKiroAccountForSession(
  sessionKey: string | null | undefined,
  config: OcxConfig,
  now = Date.now(),
): string | null {
  const set = getAccountSet(PROVIDER);
  if (!set?.accounts.length) return null;
  if (!isKiroAccountPoolEnabled(config)) return set.activeAccountId;
  pruneAffinity(now);
  const eligible = eligibleAccounts(config, now);
  const key = normalizeComponent(sessionKey);
  const affined = key ? sessionAffinity.get(key) : undefined;
  let selected = affined && eligible.includes(affined.accountId)
    ? affined.accountId
    : eligible.includes(set.activeAccountId)
      ? set.activeAccountId
      : eligible[0] ?? null;
  if (key && selected) sessionAffinity.set(key, { accountId: selected, lastUsedAt: now });
  return selected;
}

function clearAffinityForAccount(accountId: string): void {
  for (const [key, entry] of sessionAffinity) if (entry.accountId === accountId) sessionAffinity.delete(key);
}

function nextEligible(config: OcxConfig, failedAccountId: string, now: number): string | null {
  const set = getAccountSet(PROVIDER);
  const eligible = eligibleAccounts(config, now).filter(id => id !== failedAccountId);
  if (!set || eligible.length === 0) return null;
  const order = set.accounts.map(account => account.id);
  const start = order.indexOf(failedAccountId);
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(Math.max(start, 0) + step) % order.length]!;
    if (eligible.includes(candidate)) return candidate;
  }
  return eligible[0] ?? null;
}

export function rotateKiroAccountOn429(
  config: OcxConfig,
  failedAccountId: string,
  retryAfter: string | null | undefined,
  sessionKey?: string | null,
  now = Date.now(),
): string | null {
  if (!isKiroAccountPoolEnabled(config)) return null;
  const parsed = parseRetryAfterMs(retryAfter, now);
  upstreamHealth.set(failedAccountId, {
    cooldownUntil: now + (parsed ?? kiroPoolDefaultCooldownMs(config)),
    cooldownSource: parsed ? "retry-after" : "default",
  });
  sweepExpiredOnWrite(now);
  clearAffinityForAccount(failedAccountId);
  notePoolRotationFailure(POOL_KEY_KIRO, failedAccountId);
  const next = nextEligible(config, failedAccountId, now);
  const key = normalizeComponent(sessionKey);
  if (next && key) sessionAffinity.set(key, { accountId: next, lastUsedAt: now });
  return next;
}

export async function rotateKiroAccountOnAuthenticationFailure(
  config: OcxConfig,
  failedAccountId: string,
  sessionKey?: string | null,
): Promise<string | null> {
  if (!isKiroAccountPoolEnabled(config)) return null;
  await markAccountNeedsReauth(PROVIDER, failedAccountId, true);
  clearAffinityForAccount(failedAccountId);
  const next = nextEligible(config, failedAccountId, Date.now());
  const key = normalizeComponent(sessionKey);
  if (next && key) sessionAffinity.set(key, { accountId: next, lastUsedAt: Date.now() });
  return next;
}

export async function getKiroPoolAccessSnapshot(accountId: string): Promise<OAuthAccessSnapshot> {
  return getValidAccessTokenSnapshotForAccount(PROVIDER, accountId);
}

export function promoteKiroActiveAccount(accountId: string): void {
  void setActiveAccount(PROVIDER, accountId).catch(() => {});
}

export function resetKiroRoutingForManualSelection(_accountId: string): void {
  sessionAffinity.clear();
}

export function formatKiroProviderForLog(accountId: string | null | undefined): string {
  return accountId ? `kiro-${fallbackCodexAccountLogLabel(accountId)}` : PROVIDER;
}

export function kiroSessionKeyFromParts(parts: Array<string | null | undefined>): string | null {
  const value = parts.find(part => part?.trim())?.trim() ?? "";
  if (!value) return null;
  return value.length <= 128 ? value : createHash("sha256").update(value).digest("hex");
}
