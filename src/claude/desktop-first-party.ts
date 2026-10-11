import type { OcxConfig } from "../types";
import { claudeConfigDir } from "./auth-detect";
import { claudeFirstPartyConfigError, recordClaudeDesktopMode } from "./desktop-mode";
import { releaseDesktopGateway, type GatewayReleaseOptions } from "./desktop-gateway-release";
import {
  applyClaudeInterceptSettings,
  captureClaudeInterceptSettingsRollback,
  type ClaudeInterceptEnv,
  type ClaudeSettingsTarget,
} from "./intercept/settings";

export interface DesktopFirstPartyPrepared {
  env: ClaudeInterceptEnv;
  proxyPort: number;
}
export interface DesktopFirstPartyApplyDeps {
  target?: ClaudeSettingsTarget;
  gateway?: GatewayReleaseOptions;
  /** Starts the owned listener, but never writes user settings or trusts a CA. */
  prepare: () => Promise<DesktopFirstPartyPrepared>;
  /** Persist after external writes succeed; false requests rollback. */
  persist: (config: OcxConfig) => boolean;
}
export type DesktopFirstPartyApplyResult =
  | { ok: true; changed: boolean; restartRequired: true; proxyPort: number; mode: "first-party" }
  | { ok: false; reason: string; rollbackComplete: boolean };

/** Explicit apply only. No caller may infer consent from a remote catalog refresh. */
export async function applyDesktopFirstParty(config: OcxConfig, deps: DesktopFirstPartyApplyDeps): Promise<DesktopFirstPartyApplyResult> {
  const error = claudeFirstPartyConfigError(config);
  if (error) return { ok: false, reason: error, rollbackComplete: true };
  if (config.claudeCode?.enabled === false || config.claudeCode?.intercept?.enabled === false) {
    return { ok: false, reason: "intercept_disabled", rollbackComplete: true };
  }
  let prepared: DesktopFirstPartyPrepared;
  try { prepared = await deps.prepare(); }
  catch { return { ok: false, reason: "intercept_unavailable", rollbackComplete: true }; }
  const target = deps.target ?? claudeConfigDir(process.env);
  const restoreSettings = captureClaudeInterceptSettingsRollback(prepared.env, target);
  const applied = applyClaudeInterceptSettings(prepared.env, target);
  if (!applied.ok) return { ok: false, reason: applied.reason, rollbackComplete: true };
  const released = releaseDesktopGateway({ appliedFingerprint: config.claudeCode?.desktopProfile?.appliedFingerprint, ...deps.gateway });
  if (!released.ok) {
    return { ok: false, reason: released.reason, rollbackComplete: !applied.changed || restoreSettings() };
  }
  const before = structuredClone(config.claudeCode);
  recordClaudeDesktopMode(config, "first-party");
  let persisted = false;
  try { persisted = deps.persist(config); } catch { /* Only bounded error codes leave this boundary. */ }
  if (!persisted) {
    config.claudeCode = before;
    const gatewayRestored = released.rollback();
    const settingsRestored = !applied.changed || restoreSettings();
    return { ok: false, reason: "mode_persist_failed", rollbackComplete: gatewayRestored && settingsRestored };
  }
  return { ok: true, changed: applied.changed || released.changed, restartRequired: true, proxyPort: prepared.proxyPort, mode: "first-party" };
}

