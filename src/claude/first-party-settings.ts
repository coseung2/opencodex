// Ownership/intent subset of lidge-jun/opencodex d17a9f2239031df31d978f1419f326142c00d88b.
// Callers supply prepared env/CA and eligibility; this module never creates credentials or trust.
import {
  applyClaudeInterceptSettings, claudeInterceptSettingsPath, inspectClaudeInterceptSettings,
  isClaudeInterceptProxyUrl, removeClaudeInterceptSettings,
  type ClaudeInterceptEnv, type ClaudeInterceptSettingsState, type ClaudeInterceptSettingsWrite,
  type ClaudeSettingsTarget,
} from "./intercept/settings";
import type { OcxConfig } from "../types";
import { resolveClaudeDesktopMode, type ClaudeDesktopModeObservation } from "./desktop-mode";
export { resolveClaudeDesktopMode, type ClaudeDesktopMode, type ClaudeDesktopModeObservation } from "./desktop-mode";
export type ClaudeFirstPartyClient = "desktop" | "cli";
export interface ClaudeFirstPartyDesired { desktop: boolean; cli: boolean }
/** Structural integration toggle until it is added to OcxConfig. */
export type ClaudeFirstPartyIntentConfig = Pick<OcxConfig, "claudeCode"> & {
  clientIntegrations?: { "claude-desktop"?: boolean };
};
export function cliFirstPartyDesired(config: ClaudeFirstPartyIntentConfig): boolean {
  return config.claudeCode?.cliFirstParty === true;
}
export function desktopFirstPartyDesired(config: ClaudeFirstPartyIntentConfig, observed?: ClaudeDesktopModeObservation): boolean {
  return config.clientIntegrations?.["claude-desktop"] !== false && resolveClaudeDesktopMode(config, observed) === "first-party";
}
export function firstPartyDesired(config: ClaudeFirstPartyIntentConfig, observed?: ClaudeDesktopModeObservation): ClaudeFirstPartyDesired {
  return { desktop: desktopFirstPartyDesired(config, observed), cli: cliFirstPartyDesired(config) };
}
export interface ClaudeFirstPartySettingsOptions {
  target: ClaudeSettingsTarget;
  ownedCaPath: string;
  /** Already prepared by the caller; optional for remove/disabled reconciles. */
  env?: ClaudeInterceptEnv;
  eligible: boolean;
}
export type ClaudeFirstPartyReconcileResult =
  | { ok: true; action: "applied" | "removed" | "unchanged"; changed: boolean; path: string }
  | Extract<ClaudeInterceptSettingsWrite, { ok: false }>
  | { ok: false; reason: "ca_unavailable"; path: string };
/** Shared settings pair remains while EITHER client desires it. Intent persistence is caller-owned. */
export function reconcileClaudeFirstPartySettings(desired: ClaudeFirstPartyDesired, options: ClaudeFirstPartySettingsOptions): ClaudeFirstPartyReconcileResult {
  const path = claudeInterceptSettingsPath(options.target);
  if ((desired.desktop || desired.cli) && !options.eligible) return { ok: true, action: "unchanged", changed: false, path };
  let written: ClaudeInterceptSettingsWrite;
  const retain = desired.desktop || desired.cli;
  if (retain) {
    if (!options.env || options.env.NODE_EXTRA_CA_CERTS !== options.ownedCaPath) return { ok: false, reason: "ca_unavailable", path };
    written = applyClaudeInterceptSettings(options.env, options.target);
  } else written = removeClaudeInterceptSettings(options.ownedCaPath, options.target);
  if (!written.ok) return written;
  return { ...written, action: written.changed ? (retain ? "applied" : "removed") : "unchanged" };
}
export type FirstPartyProxyStatus = "none" | "live" | "stopped" | "disabled" | "broken" | "foreign" | "local" | "unknown";
export interface FirstPartyProxyStatusInput { settings: ClaudeInterceptSettingsState; boundProxyPort: number | null; eligible: boolean }
/** Credential-free status only; never serializes the settings URL/token. */
export function firstPartyProxyStatus({ settings, boundProxyPort, eligible }: FirstPartyProxyStatusInput): FirstPartyProxyStatus {
  if (settings.kind === "unreadable") return "unknown";
  if (settings.kind === "absent") return "none";
  const proxy = settings.env.HTTPS_PROXY;
  if (!isClaudeInterceptProxyUrl(proxy)) return "none";
  if (settings.kind === "foreign") return /^http:\/\/opencodex:[^@/]+@/.test(proxy) ? "foreign" : "local";
  if (boundProxyPort === null) return "stopped";
  let port: number;
  try { port = Number(new URL(proxy).port || 80); } catch { return "broken"; }
  const usable = settings.kind === "applied" && port === boundProxyPort;
  return eligible ? (usable ? "live" : "broken") : (usable ? "disabled" : "broken");
}
export function readFirstPartyProxyStatus(expected: ClaudeInterceptEnv, boundProxyPort: number | null, options: Pick<ClaudeFirstPartySettingsOptions, "target" | "eligible">): FirstPartyProxyStatus {
  return firstPartyProxyStatus({ settings: inspectClaudeInterceptSettings(expected, options.target), boundProxyPort, eligible: options.eligible });
}
