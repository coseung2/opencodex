import { describe, expect, test } from "bun:test";
import { claudeInterceptEnabled, claudeInterceptProxyPort } from "../src/claude/intercept/runtime";

describe("first-party listener policy", () => {
  test("explicit disabled and malformed settings fail closed", () => {
    expect(claudeInterceptEnabled({})).toBe(true);
    expect(claudeInterceptEnabled({ claudeCode: { enabled: false } })).toBe(false);
    expect(claudeInterceptEnabled({ claudeCode: { intercept: { enabled: false } } })).toBe(false);
    expect(claudeInterceptEnabled({ claudeCode: { desktopMode: "invalid" as never } })).toBe(false);
  });
  test("stable configurable port never wraps past valid TCP port", () => {
    expect(claudeInterceptProxyPort({}, 10100)).toBe(10200);
    expect(claudeInterceptProxyPort({ claudeCode: { intercept: { port: 12000 } } }, 10100)).toBe(12000);
    expect(() => claudeInterceptProxyPort({}, 65500)).toThrow("invalid_intercept_port");
    expect(() => claudeInterceptProxyPort({ claudeCode: { intercept: { port: 0 } } }, 10100)).toThrow("invalid_intercept_port");
  });
});
