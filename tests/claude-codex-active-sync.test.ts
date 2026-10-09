import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountNeedsReauth } from "../src/codex/account-runtime-state";
import { resolveCodexAuthContext } from "../src/codex/auth-context";
import { handleCodexAuthAPI } from "../src/codex/auth-api";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../src/codex/quota";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getEffectiveActiveCodexAccountId,
  previewCodexAccountForRequest,
  recordCodexUpstreamOutcome,
  resetCodexRoutingForManualSelection,
  resolveCodexAccountForThreadDetailed,
} from "../src/codex/routing";
import { buildClaudeReplayConfig } from "../src/server/claude-messages";
import type { OcxConfig } from "../src/types";

let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {},
    codexAccounts: [{ id: "a", isMain: false }, { id: "b", isMain: false }],
    activeCodexAccountId: "a",
    activeCodexAccountPinned: "a",
    autoSwitchThreshold: 100,
    accountPoolStrategy: "quota",
    upstreamFailoverThreshold: 3,
    fastMode: true,
    webSearchSidecar: { backend: "anthropic", model: "global-search" },
    visionSidecar: { backend: "anthropic", model: "global-vision" },
    claudeCode: {
      webSearchSidecar: { backend: "openai", model: "claude-search" },
      visionSidecar: { backend: "openai", model: "claude-vision" },
    },
  };
}

function quota(id: string, percent: number): void {
  setAccountQuotaFromParsed(id, {
    fiveHourPercent: percent,
    fiveHourResetAt: Math.floor(Date.now() / 1000) + 3600,
    weeklyPercent: 40,
  });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-claude-active-test-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  for (const id of ["a", "b"]) {
    clearAccountNeedsReauth(id);
    saveCodexAccountCredential(id, {
      accessToken: `test-access-${id}`,
      refreshToken: `test-refresh-${id}`,
      expiresAt: Date.now() + 300_000,
      chatgptAccountId: `test-account-${id}`,
    });
  }
});

afterEach(() => {
  clearAccountQuota();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(home, { recursive: true, force: true });
});

describe("Claude replay Codex active state", () => {
  test("quota switch updates management and disk without persisting Claude overrides", async () => {
    const shared = config();
    quota("a", 100);
    quota("b", 20);
    const replay = buildClaudeReplayConfig(shared, "default");
    expect(replay.fastMode).toBeUndefined();
    expect(replay.webSearchSidecar?.model).toBe("claude-search");
    expect(resolveCodexAccountForThreadDetailed("thread", replay, Date.now(), "shared"))
      .toEqual({ status: "selected", accountId: "b" });
    expect(shared.activeCodexAccountId).toBe("b");
    expect(shared.activeCodexAccountPinned).toBeUndefined();
    expect(getEffectiveActiveCodexAccountId(shared)).toBe("b");
    const url = new URL("http://localhost/api/codex-auth/active");
    const response = await handleCodexAuthAPI(new Request(url), url, shared);
    expect(await response!.json()).toMatchObject({ activeCodexAccountId: "b", pinned: false });
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(saved.activeCodexAccountId).toBe("b");
    expect(saved.activeCodexAccountPinned).toBeUndefined();
    expect(saved.fastMode).toBe(true);
    expect(saved.webSearchSidecar.model).toBe("global-search");
    expect(saved.visionSidecar.model).toBe("global-vision");
    expect(shared.webSearchSidecar?.model).toBe("global-search");
  });

  test("existing replay and nested replay honor a later manual selection", () => {
    const shared = config();
    quota("a", 10);
    quota("b", 20);
    const replay = buildClaudeReplayConfig(shared);
    const nested = buildClaudeReplayConfig(replay);
    resolveCodexAccountForThreadDetailed("thread", replay, Date.now(), "shared");
    shared.activeCodexAccountId = "b";
    shared.activeCodexAccountPinned = "b";
    resetCodexRoutingForManualSelection("b");
    expect(previewCodexAccountForRequest("thread", nested, Date.now(), "shared")).toBe("b");
    expect(resolveCodexAccountForThreadDetailed("thread", replay, Date.now(), "shared"))
      .toEqual({ status: "selected", accountId: "b" });
    expect(getEffectiveActiveCodexAccountId(nested)).toBe("b");
  });

  test("quota failure promotes the shared active and preserves global options", () => {
    const shared = config();
    quota("a", 10);
    quota("b", 20);
    const replay = buildClaudeReplayConfig(shared, "default");
    recordCodexUpstreamOutcome(replay, "a", 429, { modelId: "gpt-6-astra", promoteAccountId: "b" });
    expect(getEffectiveActiveCodexAccountId(shared)).toBe("b");
    expect(shared.activeCodexAccountId).toBe("b");
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(saved.fastMode).toBe(true);
    expect(saved.webSearchSidecar.model).toBe("global-search");
  });

  test("Direct and fixed-account auth do not rotate shared active", async () => {
    const shared = config();
    quota("a", 100);
    quota("b", 20);
    const replay = buildClaudeReplayConfig(shared);
    expect(await resolveCodexAuthContext(new Headers({ authorization: "Bearer test-caller" }), replay, "direct"))
      .toEqual({ kind: "main", accountId: null });
    const fixed = await resolveCodexAuthContext(new Headers(), replay, "pool", { accountId: "b", modelId: "gpt-6-astra" });
    expect(fixed).toMatchObject({ kind: "pool", accountId: "b", fixedAccount: true });
    expect(shared.activeCodexAccountId).toBe("a");
    expect(shared.activeCodexAccountPinned).toBe("a");
  });

  for (const strategy of ["round-robin", "fill-first"] as const) {
    test(`${strategy} observes a manual selection through an existing replay`, () => {
      const shared = config();
      quota("a", 10);
      quota("b", 20);
      const replay = buildClaudeReplayConfig(shared);
      shared.accountPoolStrategy = strategy;
      shared.activeCodexAccountId = "b";
      shared.activeCodexAccountPinned = "b";
      resetCodexRoutingForManualSelection("b");
      expect(resolveCodexAccountForThreadDetailed("thread", replay, Date.now(), "shared"))
        .toEqual({ status: "selected", accountId: "b" });
      expect(getEffectiveActiveCodexAccountId(shared)).toBe("b");
    });
  }

  test("manual selection does not bypass an actual account cooldown", async () => {
    const shared = config();
    quota("a", 10);
    quota("b", 20);
    const replay = buildClaudeReplayConfig(shared);
    recordCodexUpstreamOutcome(replay, "b", 429, { retryAfter: "60", fixedAccount: true });
    shared.activeCodexAccountId = "b";
    shared.activeCodexAccountPinned = "b";
    resetCodexRoutingForManualSelection("b");
    await expect(resolveCodexAuthContext(new Headers(), replay, "pool", { accountId: "b", modelId: "gpt-6-astra" }))
      .rejects.toThrow("cooling down");
  });

  test("independent Spark selection does not change shared active", () => {
    const shared = config();
    quota("a", 100);
    quota("b", 20);
    const replay = buildClaudeReplayConfig(shared);
    resolveCodexAccountForThreadDetailed("thread", replay, Date.now(), "spark");
    expect(shared.activeCodexAccountId).toBe("a");
    expect(shared.activeCodexAccountPinned).toBe("a");
    expect(getEffectiveActiveCodexAccountId(shared)).toBe("a");
  });
});
