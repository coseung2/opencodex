import { describe, expect, test } from "bun:test";
import {
  forgetOauthAccountPause,
  isOauthAccountPaused,
  setOauthAccountPaused,
} from "../src/oauth/account-pause";
import type { OcxConfig } from "../src/types";

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {},
  };
}

describe("OAuth account pause state", () => {
  test("set/resume persists per-provider id lists without touching other providers", () => {
    const c = config();

    setOauthAccountPaused(c, "kiro", "acct-1", true);
    expect(isOauthAccountPaused(c, "kiro", "acct-1")).toBe(true);
    expect(isOauthAccountPaused(c, "kiro", "acct-2")).toBe(false);
    expect(isOauthAccountPaused(c, "anthropic", "acct-1")).toBe(false);

    setOauthAccountPaused(c, "kiro", "acct-2", true);
    expect(c.pausedOauthAccountIds?.kiro).toEqual(["acct-1", "acct-2"]);

    forgetOauthAccountPause(c, "kiro", "acct-1");
    expect(isOauthAccountPaused(c, "kiro", "acct-1")).toBe(false);
    expect(c.pausedOauthAccountIds?.kiro).toEqual(["acct-2"]);

    forgetOauthAccountPause(c, "kiro", "acct-2");
    expect(c.pausedOauthAccountIds).toBeUndefined();
  });

  test("pause idempotent and resume of unknown id is a no-op", () => {
    const c = config();
    setOauthAccountPaused(c, "kiro", "acct-1", true);
    setOauthAccountPaused(c, "kiro", "acct-1", true);
    expect(c.pausedOauthAccountIds?.kiro).toEqual(["acct-1"]);

    forgetOauthAccountPause(c, "kiro", "nope");
    expect(isOauthAccountPaused(c, "kiro", "acct-1")).toBe(true);
  });
});
