import type { OcxConfig } from "../types";

/**
 * Per-provider OAuth account pause state, mirroring the Codex account pool's
 * `pausedCodexAccountIds` so manually paused rows survive restarts.
 *
 * Pause is an administrative exclusion: a paused account cannot be activated and
 * is skipped when a provider's active selection is promoted. Credentials are
 * never touched by pause/resume.
 */
export function isOauthAccountPaused(config: OcxConfig, provider: string, accountId: string): boolean {
  return config.pausedOauthAccountIds?.[provider]?.includes(accountId) ?? false;
}

/** Persist the account's pool eligibility without changing credentials or runtime health. */
export function setOauthAccountPaused(config: OcxConfig, provider: string, accountId: string, paused: boolean): void {
  const byProvider = { ...(config.pausedOauthAccountIds ?? {}) };
  const ids = new Set(byProvider[provider] ?? []);
  if (paused) ids.add(accountId);
  else ids.delete(accountId);

  if (ids.size > 0) byProvider[provider] = [...ids];
  else delete byProvider[provider];

  if (Object.keys(byProvider).length > 0) config.pausedOauthAccountIds = byProvider;
  else delete config.pausedOauthAccountIds;
}

export function forgetOauthAccountPause(config: OcxConfig, provider: string, accountId: string): void {
  setOauthAccountPaused(config, provider, accountId, false);
}
