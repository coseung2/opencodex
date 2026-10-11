import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstPartyDesired, firstPartyProxyStatus, readFirstPartyProxyStatus, reconcileClaudeFirstPartySettings, resolveClaudeDesktopMode } from "../src/claude/first-party-settings";
import { buildClaudeInterceptEnv } from "../src/claude/intercept/settings";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() { const dir = mkdtempSync(join(tmpdir(), "ocx-first-party-fixture-")); dirs.push(dir); return dir; }
const ownedCaPath = "/fixture/ocx/ca.pem", env = buildClaudeInterceptEnv(8846, ownedCaPath, "fixture-token");
test("Desktop mode stays gateway by default and CLI intent remains independent", () => {
  expect(firstPartyDesired({})).toEqual({ desktop: false, cli: false });
  expect(firstPartyDesired({ claudeCode: { cliFirstParty: true } }, { ownedFirstPartySettings: true })).toEqual({ desktop: false, cli: true });
  expect(firstPartyDesired({ claudeCode: { desktopMode: "first-party" } })).toEqual({ desktop: true, cli: false });
  expect(firstPartyDesired({ claudeCode: { cliFirstParty: true, desktopMode: "first-party" }, clientIntegrations: { "claude-desktop": false } })).toEqual({ desktop: false, cli: true });
  expect(resolveClaudeDesktopMode({}, { ownedFirstPartySettings: true })).toBe("first-party");
  expect(resolveClaudeDesktopMode({}, { ownedFirstPartySettings: true, ownedGatewaySelected: true })).toBe("gateway");
  expect(resolveClaudeDesktopMode({ claudeCode: { desktopProfile: { appliedFingerprint: "fixture" } } }, { ownedFirstPartySettings: true })).toBe("gateway");
  expect(resolveClaudeDesktopMode({ claudeCode: { desktopMode: "first-party" } }, { ownedGatewaySelected: true })).toBe("first-party");
});
test("shared env survives either client's departure and is removed only when both are off", () => {
  const target = fixture(), options = { target, env, ownedCaPath, eligible: true };
  expect(reconcileClaudeFirstPartySettings({ desktop: true, cli: false }, options)).toMatchObject({ ok: true, action: "applied" });
  expect(reconcileClaudeFirstPartySettings({ desktop: false, cli: true }, options)).toMatchObject({ ok: true, action: "unchanged" });
  expect(JSON.parse(readFileSync(join(target, "settings.json"), "utf8"))).toEqual({ env });
  expect(reconcileClaudeFirstPartySettings({ desktop: true, cli: false }, options)).toMatchObject({ ok: true, action: "unchanged" });
  expect(reconcileClaudeFirstPartySettings({ desktop: false, cli: false }, options)).toMatchObject({ ok: true, action: "removed" });
  expect(JSON.parse(readFileSync(join(target, "settings.json"), "utf8"))).toEqual({});
});
test("disabled reconcile does not enable settings; missing or mismatched prepared CA is refused", () => {
  const target = fixture(), desired = { desktop: false, cli: true };
  expect(reconcileClaudeFirstPartySettings(desired, { target, ownedCaPath, eligible: false })).toMatchObject({ ok: true, action: "unchanged" });
  expect(existsSync(join(target, "settings.json"))).toBe(false);
  expect(reconcileClaudeFirstPartySettings(desired, { target, ownedCaPath, eligible: true })).toMatchObject({ ok: false, reason: "ca_unavailable" });
  expect(reconcileClaudeFirstPartySettings(desired, { target, ownedCaPath: "/fixture/other.pem", env, eligible: true })).toMatchObject({ ok: false, reason: "ca_unavailable" });
  expect(existsSync(join(target, "settings.json"))).toBe(false);
});
test("proxy status reports bound listener, eligibility, foreign anchors, stale ports without credentials", () => {
  const settings = { kind: "applied" as const, env };
  expect(firstPartyProxyStatus({ settings, boundProxyPort: 8846, eligible: true })).toBe("live");
  expect(firstPartyProxyStatus({ settings, boundProxyPort: null, eligible: true })).toBe("stopped");
  expect(firstPartyProxyStatus({ settings, boundProxyPort: 8846, eligible: false })).toBe("disabled");
  expect(firstPartyProxyStatus({ settings, boundProxyPort: 9000, eligible: true })).toBe("broken");
  expect(firstPartyProxyStatus({ settings: { kind: "stale", env }, boundProxyPort: 8846, eligible: true })).toBe("broken");
  expect(firstPartyProxyStatus({ settings: { kind: "foreign", env }, boundProxyPort: 8846, eligible: true })).toBe("foreign");
  expect(firstPartyProxyStatus({ settings: { kind: "foreign", env: { HTTPS_PROXY: "http://127.0.0.1:8846" } }, boundProxyPort: null, eligible: true })).toBe("local");
  expect(firstPartyProxyStatus({ settings: { kind: "unreadable", path: "/fixture/settings.json" }, boundProxyPort: null, eligible: true })).toBe("unknown");
  const target = fixture();
  expect(readFirstPartyProxyStatus(env, null, { target, eligible: true })).toBe("none");
  expect(existsSync(join(target, "settings.json"))).toBe(false);
});
