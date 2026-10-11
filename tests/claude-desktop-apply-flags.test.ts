import { describe, expect, test } from "bun:test";
import { isDesktopApplyInvocation, parseDesktopApplyTarget } from "../src/claude/desktop-apply-flags";

describe("Desktop transport flags", () => {
  test("legacy gateway flags and empty default retain their behavior", () => {
    expect(parseDesktopApplyTarget([])).toEqual({ target: { transport: "gateway", mode: "static" } });
    expect(parseDesktopApplyTarget(["apply", "--hybrid"])).toEqual({ target: { transport: "gateway", mode: "hybrid" } });
    expect(parseDesktopApplyTarget(["--discovery-only"])).toEqual({ target: { transport: "gateway", mode: "discovery" } });
  });
  test("plain apply retains first-party once chosen", () => {
    expect(parseDesktopApplyTarget(["apply"], { claudeCode: { desktopMode: "first-party" } })).toEqual({ target: { transport: "first-party" } });
    expect(parseDesktopApplyTarget(["apply", "--gateway"], { claudeCode: { desktopMode: "first-party" } })).toEqual({ target: { transport: "gateway", mode: "static" } });
  });
  test("contradictions reject without echoing raw arguments", () => {
    expect(parseDesktopApplyTarget(["--first-party", "--gateway"])).toEqual({ error: "conflicting_desktop_transports" });
    expect(parseDesktopApplyTarget(["--first-party", "--static"])).toEqual({ error: "conflicting_desktop_transports" });
    expect(parseDesktopApplyTarget(["--hybrid", "--static"])).toEqual({ error: "conflicting_gateway_modes" });
    expect(JSON.stringify(parseDesktopApplyTarget(["apply", "fixture-secret"]))).not.toContain("fixture-secret");
  });
  test("only real apply invocations consume transport flags", () => {
    expect(isDesktopApplyInvocation(["--first-party"])).toBe(true);
    expect(isDesktopApplyInvocation(["apply"])).toBe(true);
    expect(isDesktopApplyInvocation([])).toBe(true);
    expect(isDesktopApplyInvocation(["import", "path", "--apply"])).toBe(false);
    expect(isDesktopApplyInvocation(["show", "--first-party"])).toBe(false);
  });
});
