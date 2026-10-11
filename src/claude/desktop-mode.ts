import type { OcxClaudeCodeConfig, OcxConfig } from "../types";

// Ported from lidge-jun/opencodex d17a9f22; gateway remains the downstream default.
export const CLAUDE_DESKTOP_MODES = ["gateway", "first-party"] as const;
export type ClaudeDesktopMode = typeof CLAUDE_DESKTOP_MODES[number];
export const DEFAULT_CLAUDE_DESKTOP_MODE: ClaudeDesktopMode = "gateway";

export function isClaudeDesktopMode(value: unknown): value is ClaudeDesktopMode {
  return value === "gateway" || value === "first-party";
}

export interface ClaudeDesktopModeObservation {
  ownedGatewaySelected?: boolean;
  ownedFirstPartySettings?: boolean;
}

export function resolveClaudeDesktopMode(
  config: Pick<OcxConfig, "claudeCode">,
  observed: ClaudeDesktopModeObservation = {},
): ClaudeDesktopMode {
  const explicit = config.claudeCode?.desktopMode;
  if (isClaudeDesktopMode(explicit)) return explicit;
  if (observed.ownedGatewaySelected || config.claudeCode?.desktopProfile?.appliedFingerprint) return "gateway";
  // A shared env installed for CLI alone is not Desktop first-party intent.
  if (config.claudeCode?.cliFirstParty !== true && observed.ownedFirstPartySettings) return "first-party";
  return DEFAULT_CLAUDE_DESKTOP_MODE;
}

export function recordClaudeDesktopMode(config: Pick<OcxConfig, "claudeCode">, mode: ClaudeDesktopMode): boolean {
  if (!isClaudeDesktopMode(mode)) throw new Error("Invalid Claude Desktop transport mode");
  const claude = config.claudeCode ?? {};
  const profile = claude.desktopProfile;
  const dropMarker = mode === "first-party" && profile !== undefined
    && (profile.appliedFingerprint !== undefined || profile.appliedAt !== undefined);
  if (claude.desktopMode === mode && !dropMarker) return false;
  const next: OcxClaudeCodeConfig = { ...claude, desktopMode: mode };
  if (dropMarker) {
    const { appliedFingerprint: _fingerprint, appliedAt: _at, ...retained } = profile;
    next.desktopProfile = retained;
  }
  config.claudeCode = next;
  return true;
}

/** Validate at the integration boundary, without triggering config loader repair or deleting credentials. */
export function claudeFirstPartyConfigError(config: Pick<OcxConfig, "claudeCode">): string | null {
  const claude = config.claudeCode;
  if (!claude) return null;
  if (claude.desktopMode !== undefined && !isClaudeDesktopMode(claude.desktopMode)) return "invalid_desktop_mode";
  if (claude.cliFirstParty !== undefined && typeof claude.cliFirstParty !== "boolean") return "invalid_cli_first_party";
  const intercept = claude.intercept;
  if (intercept === undefined) return null;
  if (!intercept || typeof intercept !== "object" || Array.isArray(intercept)) return "invalid_intercept";
  if (intercept.enabled !== undefined && typeof intercept.enabled !== "boolean") return "invalid_intercept_enabled";
  if (intercept.picker !== undefined && typeof intercept.picker !== "boolean") return "invalid_intercept_picker";
  if (intercept.port !== undefined && (!Number.isInteger(intercept.port) || intercept.port < 1 || intercept.port > 65535)) return "invalid_intercept_port";
  return null;
}

/** Provider/catalog reconciliation must never replace an explicitly selected first-party install. */
export function shouldAutoApplyDesktopGateway(config: Pick<OcxConfig, "claudeCode">): boolean {
  if (claudeFirstPartyConfigError(config)) return false;
  return resolveClaudeDesktopMode(config) === "gateway"
    && config.claudeCode?.desktopAutoApply !== false
    && config.claudeCode?.desktopProfile !== undefined;
}
