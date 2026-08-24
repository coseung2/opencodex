import type { OcxConfig } from "../types";
import { isValidCodexAccountId, MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { DEFAULT_ACCOUNT_PRIORITY, normalizeAccountPriority } from "./pool-rotation";

/** Account ids that may carry persisted selection order. */
export function isCodexAccountPriorityKey(key: unknown): key is string {
  return key === MAIN_CODEX_ACCOUNT_ID || isValidCodexAccountId(key);
}

export function getCodexAccountPriority(config: OcxConfig, accountId: string): number {
  return codexAccountPriorityLookup(config)(accountId);
}

/** Store default priority as absence so unconfigured pools retain their old behavior. */
export function setCodexAccountPriority(config: OcxConfig, accountId: string, priority: number): void {
  const entries = new Map(Object.entries(config.codexAccountPriorities ?? {}));
  if (priority === DEFAULT_ACCOUNT_PRIORITY) entries.delete(accountId);
  else entries.set(accountId, priority);
  if (entries.size > 0) config.codexAccountPriorities = Object.fromEntries(entries);
  else delete config.codexAccountPriorities;
}

export function forgetCodexAccountPriority(config: OcxConfig, accountId: string): void {
  setCodexAccountPriority(config, accountId, DEFAULT_ACCOUNT_PRIORITY);
}

/** Stable lookup for one routing pass. */
export function codexAccountPriorityLookup(config: OcxConfig): (accountId: string) => number {
  const priorities = config.codexAccountPriorities;
  if (!priorities) return () => DEFAULT_ACCOUNT_PRIORITY;
  return accountId => Object.hasOwn(priorities, accountId)
    ? normalizeAccountPriority(priorities[accountId])
    : DEFAULT_ACCOUNT_PRIORITY;
}

export function pinnedCodexAccountId(config: OcxConfig): string | undefined {
  return config.activeCodexAccountPinned;
}

export function setCodexAccountPin(config: OcxConfig, accountId: string): void {
  config.activeCodexAccountPinned = accountId;
}

/** Release the pin, optionally only when it belongs to one account. */
export function clearCodexAccountPin(config: OcxConfig, accountId?: string): void {
  if (accountId === undefined || config.activeCodexAccountPinned === accountId) {
    delete config.activeCodexAccountPinned;
  }
}
