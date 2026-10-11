import { parseDesktop3pModeArgs, type Desktop3pConfigMode } from "./desktop-3p";
import { resolveClaudeDesktopMode, type ClaudeDesktopMode } from "./desktop-mode";
import type { OcxConfig } from "../types";

const APPLY_FLAGS = new Set(["--first-party", "--gateway", "--static", "--hybrid", "--discovery-only"]);
export type DesktopApplyTarget = { transport: "first-party" } | { transport: "gateway"; mode: Desktop3pConfigMode };

export function isDesktopApplyInvocation(argv: readonly string[]): boolean {
  return argv.length === 0 || argv[0] === "apply" || APPLY_FLAGS.has(argv[0] ?? "");
}

/** Diagnostics never echo arbitrary arguments: they may contain a credential. */
export function parseDesktopApplyTarget(
  argv: readonly string[],
  config: Pick<OcxConfig, "claudeCode"> = {},
  current: ClaudeDesktopMode = resolveClaudeDesktopMode(config),
): { target: DesktopApplyTarget } | { error: string } {
  const flags = argv[0] === "apply" ? argv.slice(1) : argv;
  if (flags.some(flag => !APPLY_FLAGS.has(flag))) return { error: "unsupported_desktop_apply_argument" };
  const firstParty = flags.includes("--first-party");
  const shape = flags.filter(flag => ["--static", "--hybrid", "--discovery-only"].includes(flag));
  const gateway = flags.includes("--gateway") || shape.length > 0;
  if (firstParty && gateway) return { error: "conflicting_desktop_transports" };
  const parsedShape = parseDesktop3pModeArgs(shape);
  if ("error" in parsedShape) return { error: "conflicting_gateway_modes" };
  const transport = firstParty ? "first-party" : gateway ? "gateway" : current;
  return { target: transport === "first-party" ? { transport } : { transport, mode: parsedShape.mode } };
}
