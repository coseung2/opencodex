import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountQuota, updateAccountQuota } from "../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../src/codex/routing";
import { beginRequestAttempt, type RequestLogContext } from "../src/server/request-log";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;

function poolConfig(): OcxConfig {
  return {
    defaultProvider: "openai",
    activeCodexAccountId: "pool-a",
    autoSwitchThreshold: 0,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: [
      { id: "pool-a", email: "a@example.test", logLabel: "paaaaaa", isMain: false },
      { id: "pool-b", email: "b@example.test", logLabel: "pbbbbbb", isMain: false },
    ],
  } as OcxConfig;
}

function saveCredential(id: string): void {
  saveCodexAccountCredential(id, {
    accessToken: `${id}-access-token`,
    refreshToken: `${id}-refresh-token`,
    expiresAt: Date.now() + 300_000,
    chatgptAccountId: `${id}-chatgpt`,
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
});

describe("Responses Codex serving-account attribution", () => {
  test("quota failover commits the account that serves the response", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-serving-account-"));
    const previousHome = process.env.OPENCODEX_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = home;
    try {
      saveCredential("pool-a");
      saveCredential("pool-b");
      updateAccountQuota("pool-a", 10);
      updateAccountQuota("pool-b", 20);
      const servedAccounts: string[] = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const accountId = headers.get("chatgpt-account-id") ?? "";
        servedAccounts.push(accountId);
        if (accountId === "pool-a-chatgpt") {
          return Response.json({ error: { message: "quota exhausted" } }, { status: 429 });
        }
        return Response.json({
          id: "response-from-b",
          status: "completed",
          output: [],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        });
      }) as typeof fetch;

      const logCtx: RequestLogContext = {
        model: "gpt-5.6-sol",
        provider: "openai",
        activeAttempt: beginRequestAttempt(1, "openai", "gpt-5.6-sol", "openai-responses"),
      };
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: false }),
      });
      const response = await handleResponses(req, poolConfig(), logCtx);

      expect(response.status).toBe(200);
      expect(servedAccounts).toEqual(["pool-a-chatgpt", "pool-b-chatgpt"]);
      expect(logCtx.accountLogLabel).toBe("pbbbbbb");
      expect(logCtx.activeAttempt).toMatchObject({
        provider: "openai-pbbbbbb",
        accountLogLabel: "pbbbbbb",
        sendCount: 2,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });
});
