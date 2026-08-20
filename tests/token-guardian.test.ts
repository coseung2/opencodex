import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "../src/oauth/store";
import { getConfigPath } from "../src/config";
import {
  markCodexAccountQuotaValidationPending,
  markCodexAccountValidated,
  readCodexAccountRecord,
  saveCodexAccountCredential,
} from "../src/codex/account-store";
import {
  __resetGuardianState,
  guardianSweep,
  requestCodexQuotaWarmupRetry,
  startTokenGuardian,
} from "../src/oauth/token-guardian";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { isAccountNeedsReauth } from "../src/codex/account-runtime-state";

const origHome = process.env.HOME;
const origOcxHome = process.env.OPENCODEX_HOME;
const origCodexHome = process.env.CODEX_HOME;
const origFetch = globalThis.fetch;
const WARMUP_INPUT = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
let tmp: string;

// kimi refresh is a single token POST (no OAuth discovery hop), so a blanket 200 mock exercises the
// real getValidAccessToken → refreshKimiToken → saveCredential path cleanly.
function kimiProvider(refreshPolicy?: OcxProviderConfig["refreshPolicy"]): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl: "https://api.moonshot.ai/v1", authMode: "oauth", ...(refreshPolicy ? { refreshPolicy } : {}) };
}

function writeConfig(partial: Partial<OcxConfig>): void {
  const providers = partial.providers ?? { kimi: kimiProvider() };
  const defaultProvider = partial.defaultProvider ?? Object.keys(providers)[0] ?? "kimi";
  const cfg: OcxConfig = { port: 10100, ...partial, providers, defaultProvider };
  writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2));
}

beforeEach(() => {
  tmp = join(tmpdir(), `token-guardian-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  process.env.HOME = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "ocx");
  process.env.CODEX_HOME = join(tmp, "codex");
  mkdirSync(join(tmp, "ocx"), { recursive: true });
  mkdirSync(join(tmp, "codex"), { recursive: true });
  __resetGuardianState();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = origOcxHome;
  if (origCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = origCodexHome;
  globalThis.fetch = origFetch;
  rmSync(tmp, { recursive: true, force: true });
});

function mockFetchOk(body: object): { count: () => number } {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { count: () => calls };
}

function mockWarmupFetch(): { calls: () => number; body: () => Record<string, unknown> | undefined } {
  let calls = 0;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    if (String(input) === "https://chatgpt.com/backend-api/codex/responses") {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify(OK_TOKEN), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls: () => calls, body: () => requestBody };
}

const OK_TOKEN = { access_token: "a2", refresh_token: "r2", expires_in: 3600 };

describe("token guardian", () => {
  test("disabled by default → no refresh, no fetch", async () => {
    const mock = mockFetchOk(OK_TOKEN);
    writeConfig({}); // no tokenGuardian
    await saveCredential("kimi", { access: "a", refresh: "r", expires: Date.now() + 1000 });
    const res = await guardianSweep(Date.now());
    expect(res.enabled).toBe(false);
    expect(res.refreshed).toEqual([]);
    expect(mock.count()).toBe(0);
  });

  test("proactive provider with soon-expiring token is refreshed", async () => {
    const mock = mockFetchOk(OK_TOKEN);
    writeConfig({
      tokenGuardian: { enabled: true, tickSeconds: 60, leadSeconds: 60 },
      providers: { kimi: kimiProvider("proactive") },
    });
    await saveCredential("kimi", { access: "a", refresh: "r", expires: Date.now() + 5_000 });
    const res = await guardianSweep(Date.now());
    expect(res.enabled).toBe(true);
    // Multiauth keys are oauth:<provider>:<accountId>
    expect(res.refreshed.some(k => k.startsWith("oauth:kimi:"))).toBe(true);
    expect(mock.count()).toBeGreaterThan(0);
  });

  test("lazy-only policy is left untouched even when enabled", async () => {
    const mock = mockFetchOk(OK_TOKEN);
    writeConfig({
      tokenGuardian: { enabled: true, tickSeconds: 60, leadSeconds: 60 },
      providers: { kimi: kimiProvider("lazy-only") },
    });
    await saveCredential("kimi", { access: "a", refresh: "r", expires: Date.now() + 5_000 });
    const res = await guardianSweep(Date.now());
    expect(res.refreshed).toEqual([]);
    expect(mock.count()).toBe(0);
  });

  test("token far from expiry is not refreshed", async () => {
    const mock = mockFetchOk(OK_TOKEN);
    writeConfig({
      tokenGuardian: { enabled: true, tickSeconds: 60, leadSeconds: 60 },
      providers: { kimi: kimiProvider("proactive") },
    });
    await saveCredential("kimi", { access: "a", refresh: "r", expires: Date.now() + 3600_000 }); // beyond 120s horizon
    const res = await guardianSweep(Date.now());
    expect(res.refreshed).toEqual([]);
    expect(mock.count()).toBe(0);
  });

  test("anthropic default policy is disabled → never refreshed even when enabled", async () => {
    const mock = mockFetchOk(OK_TOKEN);
    writeConfig({
      tokenGuardian: { enabled: true, tickSeconds: 60, leadSeconds: 60 },
      // no explicit refreshPolicy → falls back to the built-in "disabled" default for anthropic
      providers: { anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" } },
    });
    await saveCredential("anthropic", { access: "a", refresh: "r", expires: Date.now() + 5_000 });
    const res = await guardianSweep(Date.now());
    expect(res.refreshed).toEqual([]);
    expect(mock.count()).toBe(0);
  });

  test("codex pool refreshed only when canonical openai policy is proactive", async () => {
    const mock = mockFetchOk(OK_TOKEN);
    writeConfig({
      tokenGuardian: { enabled: true, tickSeconds: 60, leadSeconds: 60 },
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool", refreshPolicy: "proactive" } },
    });
    saveCodexAccountCredential("acct-1", {
      accessToken: "old", refreshToken: "rt", expiresAt: Date.now() + 5_000, chatgptAccountId: "cg-1",
    });
    const res = await guardianSweep(Date.now());
    expect(res.refreshed).toContain("codex:acct-1");
    expect(mock.count()).toBeGreaterThan(0);
  });

  test("codex pool warmup is opt-in even when validation is stale", async () => {
    const mock = mockWarmupFetch();
    writeConfig({
      tokenGuardian: { enabled: true, tickSeconds: 60, leadSeconds: 60 },
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool", refreshPolicy: "proactive" } },
    });
    saveCodexAccountCredential("acct-stale", {
      accessToken: "old", refreshToken: "rt", expiresAt: Date.now() + 3600_000, chatgptAccountId: "cg-1",
    });
    const res = await guardianSweep(Date.now());
    expect(res.warmed).toEqual([]);
    expect(mock.calls()).toBe(0);
  });

  test("codex pool warmup validates stale far-from-expiry accounts when explicitly enabled", async () => {
    const mock = mockWarmupFetch();
    writeConfig({
      tokenGuardian: {
        enabled: true,
        tickSeconds: 60,
        leadSeconds: 60,
        codexWarmupEnabled: true,
        codexWarmupMaxAgeSeconds: 60,
      },
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool", refreshPolicy: "proactive" } },
    });
    saveCodexAccountCredential("acct-warm", {
      accessToken: "old", refreshToken: "rt", expiresAt: Date.now() + 3600_000, chatgptAccountId: "cg-1",
    });
    markCodexAccountValidated("acct-warm", Date.now() - 120_000);

    const res = await guardianSweep(Date.now());

    expect(res.refreshed).toEqual([]);
    expect(res.warmed).toContain("codex:acct-warm");
    expect(mock.body()).toMatchObject({ model: "gpt-5.4-mini", input: WARMUP_INPUT, stream: true, store: false });
    expect(readCodexAccountRecord("acct-warm")?.lastCodexValidationStatus).toBe("ok");
    expect(readCodexAccountRecord("acct-warm")?.lastCodexValidatedAt).toBeGreaterThan(Date.now() - 30_000);
  });

  test("quota-deferred registration retries after reset without Token Guardian opt-in", async () => {
    const now = Date.now();
    const resetAt = now + 60_000;
    writeConfig({
      codexAccounts: [{ id: "acct-quota-pending", email: "pending@example.test", plan: "pro", isMain: false }],
      pausedCodexAccountIds: ["acct-quota-pending"],
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" } },
    });
    saveCodexAccountCredential("acct-quota-pending", {
      accessToken: "old", refreshToken: "rt", expiresAt: now + 3600_000, chatgptAccountId: "cg-pending",
    });
    markCodexAccountQuotaValidationPending("acct-quota-pending", "http_status:429", resetAt);
    const mock = mockWarmupFetch();

    const beforeReset = await guardianSweep(resetAt - 1);
    expect(beforeReset.enabled).toBe(false);
    expect(beforeReset.warmed).toEqual([]);
    expect(mock.calls()).toBe(0);
    expect(readCodexAccountRecord("acct-quota-pending")?.lastCodexValidationStatus).toBe("quota_pending");

    const afterReset = await guardianSweep(resetAt);

    expect(afterReset.enabled).toBe(false);
    expect(afterReset.warmed).toEqual(["codex:acct-quota-pending"]);
    expect(mock.calls()).toBe(1);
    expect(readCodexAccountRecord("acct-quota-pending")?.lastCodexValidationStatus).toBe("ok");
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted.pausedCodexAccountIds ?? []).not.toContain("acct-quota-pending");
  });

  test("background loop schedules the pending reset and registration can wake an older timer", () => {
    const now = Date.now();
    const resetAt = now + 60_000;
    writeConfig({
      codexAccounts: [{ id: "acct-scheduled", email: "scheduled@example.test", plan: "pro", isMain: false }],
      pausedCodexAccountIds: ["acct-scheduled"],
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" } },
    });
    saveCodexAccountCredential("acct-scheduled", {
      accessToken: "old", refreshToken: "rt", expiresAt: now + 3600_000, chatgptAccountId: "cg-scheduled",
    });
    markCodexAccountQuotaValidationPending("acct-scheduled", "http_status:429", resetAt);

    const delays: number[] = [];
    let firstTimer: ReturnType<typeof setTimeout> | undefined;
    let clearedTimer: ReturnType<typeof setTimeout> | undefined;
    const originalDateNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((_: TimerHandler, delay?: number) => {
      const timer = { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      delays.push(delay ?? 0);
      firstTimer ??= timer;
      return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
      clearedTimer = timer;
    }) as typeof clearTimeout;

    let handle: ReturnType<typeof startTokenGuardian> | undefined;
    try {
      Date.now = () => now;
      handle = startTokenGuardian();
      expect(delays[0]).toBe(resetAt - now);

      requestCodexQuotaWarmupRetry();
      expect(delays.at(-1)).toBe(0);
      expect(clearedTimer).toBe(firstTimer);
    } finally {
      handle?.stop();
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("background loop uses the regular interval when pending work is not routable", () => {
    const now = Date.now();
    writeConfig({
      tokenGuardian: { enabled: true, tickSeconds: 60, jitterSeconds: 0 },
      codexAccounts: [{ id: "acct-direct-pending", email: "pending@example.test", plan: "pro", isMain: false }],
      pausedCodexAccountIds: ["acct-direct-pending"],
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" } },
    });
    saveCodexAccountCredential("acct-direct-pending", {
      accessToken: "old", refreshToken: "rt", expiresAt: now + 3600_000, chatgptAccountId: "cg-direct",
    });
    markCodexAccountQuotaValidationPending("acct-direct-pending", "http_status:429", now - 1);

    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((_: TimerHandler, delay?: number) => {
      delays.push(delay ?? 0);
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

    let handle: ReturnType<typeof startTokenGuardian> | undefined;
    try {
      handle = startTokenGuardian();
      expect(delays[0]).toBe(60_000);
    } finally {
      handle?.stop();
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("terminal quota retry failure requires reauthentication without losing pause ownership", async () => {
    const now = Date.now();
    writeConfig({
      codexAccounts: [{ id: "acct-terminal", email: "terminal@example.test", plan: "pro", isMain: false }],
      pausedCodexAccountIds: ["acct-terminal"],
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" } },
    });
    saveCodexAccountCredential("acct-terminal", {
      accessToken: "old", refreshToken: "rt", expiresAt: now + 3600_000, chatgptAccountId: "cg-terminal",
    });
    markCodexAccountQuotaValidationPending("acct-terminal", "http_status:429", now - 1);
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;

    const result = await guardianSweep(now);

    expect(result.failed).toContain("codex:acct-terminal");
    expect(isAccountNeedsReauth("acct-terminal")).toBe(true);
    expect(readCodexAccountRecord("acct-terminal")).toMatchObject({
      lastCodexValidationStatus: "failed",
      codexQuotaPauseOwned: true,
    });
    expect(readCodexAccountRecord("acct-terminal")).not.toHaveProperty("codexQuotaRetryAt");
  });

  test("direct mode warms main only and never enumerates the added-account store", async () => {
    const accountStore = join(tmp, "ocx", "codex-accounts.json");
    writeFileSync(accountStore, "invalid-added-store");
    writeFileSync(join(tmp, "codex", "auth.json"), JSON.stringify({
      tokens: { access_token: "main-access", account_id: "main-chatgpt-id" },
    }));
    const mock = mockWarmupFetch();
    writeConfig({
      tokenGuardian: {
        enabled: true,
        tickSeconds: 60,
        leadSeconds: 60,
        codexWarmupEnabled: true,
      },
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct", refreshPolicy: "proactive" } },
    });

    const res = await guardianSweep(Date.now());

    expect(res.warmed).toEqual(["codex:__main__"]);
    expect(mock.calls()).toBe(1);
    expect(readFileSync(accountStore, "utf8")).toBe("invalid-added-store");
  });
});
