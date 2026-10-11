import { describe, expect, test } from "bun:test";
import {
  claudeFirstPartyConfigError,
  isClaudeDesktopMode,
  recordClaudeDesktopMode,
  resolveClaudeDesktopMode,
  shouldAutoApplyDesktopGateway,
} from "../src/claude/desktop-mode";
import type { OcxConfig } from "../src/types";

function config(claudeCode: OcxConfig["claudeCode"] = {}): Pick<OcxConfig, "claudeCode"> {
  return { claudeCode };
}
function profile() {
  return { version: 1 as const, assignments: {}, defaults: {}, appliedFingerprint: "owned", appliedAt: "earlier" };
}

describe("Claude Desktop transport intent", () => {
  test("keeps gateway default and legacy apply marker", () => {
    expect(resolveClaudeDesktopMode(config())).toBe("gateway");
    expect(resolveClaudeDesktopMode(config({ desktopProfile: profile() }), { ownedFirstPartySettings: true })).toBe("gateway");
    expect(resolveClaudeDesktopMode(config(), { ownedGatewaySelected: true })).toBe("gateway");
  });

  test("explicit intent wins without settings inspection or listener availability", () => {
    expect(resolveClaudeDesktopMode(config({ desktopMode: "first-party", desktopProfile: profile() }), { ownedGatewaySelected: true })).toBe("first-party");
    expect(resolveClaudeDesktopMode(config({ desktopMode: "gateway" }), { ownedFirstPartySettings: true })).toBe("gateway");
    expect(resolveClaudeDesktopMode(config(), { ownedFirstPartySettings: true })).toBe("first-party");
    expect(resolveClaudeDesktopMode(config({ cliFirstParty: true }), { ownedFirstPartySettings: true })).toBe("gateway");
  });

  test("mode writes remove only obsolete gateway apply markers", () => {
    const initial = config({ desktopProfile: profile(), cliFirstParty: true, modelMap: { claude: "openai/gpt" } });
    expect(recordClaudeDesktopMode(initial, "first-party")).toBe(true);
    expect(initial.claudeCode).toEqual({ desktopMode: "first-party", cliFirstParty: true, modelMap: { claude: "openai/gpt" }, desktopProfile: { version: 1, assignments: {}, defaults: {} } });
    expect(recordClaudeDesktopMode(initial, "first-party")).toBe(false);
    expect(recordClaudeDesktopMode(initial, "gateway")).toBe(true);
    expect(initial.claudeCode?.cliFirstParty).toBe(true);
  });

  test("catalog reconciliation cannot switch first-party to gateway", () => {
    expect(shouldAutoApplyDesktopGateway(config({ desktopProfile: profile() }))).toBe(true);
    expect(shouldAutoApplyDesktopGateway(config({ desktopProfile: profile(), desktopMode: "first-party" }))).toBe(false);
    expect(shouldAutoApplyDesktopGateway(config({ desktopProfile: profile(), desktopAutoApply: false }))).toBe(false);
    expect(shouldAutoApplyDesktopGateway(config())).toBe(false);
  });

  test("invalid hand edits fail the integration boundary, not credential loading", () => {
    expect(isClaudeDesktopMode("first-party")).toBe(true);
    expect(isClaudeDesktopMode("1p")).toBe(false);
    const invalid = [
      [{ desktopMode: "1p" }, "invalid_desktop_mode"],
      [{ cliFirstParty: "true" }, "invalid_cli_first_party"],
      [{ intercept: [] }, "invalid_intercept"],
      [{ intercept: { enabled: 1 } }, "invalid_intercept_enabled"],
      [{ intercept: { picker: "yes" } }, "invalid_intercept_picker"],
      [{ intercept: { port: 0 } }, "invalid_intercept_port"],
      [{ intercept: { port: 65536 } }, "invalid_intercept_port"],
      [{ intercept: { port: 1.5 } }, "invalid_intercept_port"],
    ] as const;
    for (const [value, reason] of invalid) {
      const input = { claudeCode: value } as unknown as Pick<OcxConfig, "claudeCode">;
      expect(claudeFirstPartyConfigError(input)).toBe(reason);
      expect(shouldAutoApplyDesktopGateway(input)).toBe(false);
    }
    expect(claudeFirstPartyConfigError(config({ intercept: { enabled: false, picker: false, port: 65535 } }))).toBeNull();
  });
});
