import { afterEach, describe, expect, test } from "bun:test";
import { CodexWarmupError, isCodexWarmupQuotaFailure, warmCodexAccount } from "../src/codex/warmup";

const originalFetch = globalThis.fetch;

function sseResponse(frames: string, status = 200): Response {
  return new Response(frames, { status, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("codex warmup", () => {
  test("posts a minimal gpt-5.4-mini Responses stream request and accepts response.completed", async () => {
    let body: Record<string, unknown> | undefined;
    let auth: string | null = null;
    let account: string | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      auth = headers.get("authorization");
      account = headers.get("chatgpt-account-id");
      return sseResponse('event: response.completed\ndata: {"type":"response.completed"}\n\n');
    }) as typeof fetch;

    await warmCodexAccount({ accessToken: "access-test", chatgptAccountId: "acct-test" });

    expect(auth).toBe("Bearer access-test");
    expect(account).toBe("acct-test");
    expect(body).toMatchObject({
      model: "gpt-5.4-mini",
      instructions: "Reply with OK.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
      store: false,
    });
    expect(body).not.toHaveProperty("max_output_tokens");
  });

  test("rejects streamed failure terminal", async () => {
    globalThis.fetch = (async () => sseResponse('event: response.failed\ndata: {"type":"response.failed"}\n\n')) as typeof fetch;
    await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c" }))
      .rejects.toMatchObject({ name: "CodexWarmupError", code: "stream_failed" });
  });

  test("rejects streamed incomplete and error terminals", async () => {
    globalThis.fetch = (async () => sseResponse('event: response.incomplete\ndata: {"type":"response.incomplete"}\n\n')) as typeof fetch;
    await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c" }))
      .rejects.toMatchObject({ name: "CodexWarmupError", code: "stream_incomplete" });

    globalThis.fetch = (async () => sseResponse('event: error\ndata: {"type":"error"}\n\n')) as typeof fetch;
    await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c" }))
      .rejects.toMatchObject({ name: "CodexWarmupError", code: "stream_error" });
  });

  test("rejects malformed SSE JSON", async () => {
    globalThis.fetch = (async () => sseResponse("event: response.completed\ndata: {not-json}\n\n")) as typeof fetch;
    await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c" }))
      .rejects.toMatchObject({ name: "CodexWarmupError", code: "invalid_sse" });
  });

  test("rejects EOF before success terminal", async () => {
    globalThis.fetch = (async () => sseResponse('event: response.created\ndata: {"type":"response.created"}\n\n')) as typeof fetch;
    await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c" }))
      .rejects.toMatchObject({ name: "CodexWarmupError", code: "no_terminal" });
  });

  test("rejects HTTP auth/session errors without exposing token material", async () => {
    globalThis.fetch = (async () => new Response("sensitive-access-token revoked", { status: 401 })) as typeof fetch;
    try {
      await warmCodexAccount({ accessToken: "sensitive-access-token", chatgptAccountId: "sensitive-account-id" });
      throw new Error("expected warmup to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexWarmupError);
      expect((err as CodexWarmupError).code).toBe("http_status");
      expect((err as CodexWarmupError).status).toBe(401);
      expect((err as Error).message).not.toContain("sensitive-access-token");
      expect((err as Error).message).not.toContain("sensitive-account-id");
      expect((err as Error).message).not.toContain("revoked");
    }
  });

  test("classifies quota rejection from structured status and never from 401 detail alone", () => {
    expect(isCodexWarmupQuotaFailure(new CodexWarmupError("http_status", "rejected", {
      status: 429,
    }))).toBe(true);
    expect(isCodexWarmupQuotaFailure(new CodexWarmupError("http_status", "rejected", {
      status: 403,
      quotaLike: true,
    }))).toBe(true);
    expect(isCodexWarmupQuotaFailure(new CodexWarmupError("http_status", "rejected", {
      status: 401,
      quotaLike: true,
    }))).toBe(false);
  });

  test("classifies a bounded structured 403 quota body without retaining its text", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ detail: "usage quota exhausted" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

    try {
      await warmCodexAccount({ accessToken: "a", chatgptAccountId: "c" });
      throw new Error("expected warmup to reject");
    } catch (error) {
      expect(isCodexWarmupQuotaFailure(error)).toBe(true);
      expect(JSON.stringify(error)).not.toContain("usage quota exhausted");
    }
  });

  test("rejects an oversized unterminated SSE stream", async () => {
    let cancelled = false;
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(256 * 1024).fill(65);
        for (let index = 0; index < 5; index += 1) controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = (async () => new Response(oversizedBody, { status: 200 })) as typeof fetch;

    await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c" }))
      .rejects.toMatchObject({ name: "CodexWarmupError", code: "stream_too_large" });
    expect(cancelled).toBe(true);
  });

  test("aborts a silent SSE body at the warmup deadline", async () => {
    let cancelled = false;
    const silentBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    globalThis.fetch = (async () => new Response(silentBody, { status: 200 })) as typeof fetch;

    const startedAt = performance.now();
    await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c", timeoutMs: 20 }))
      .rejects.toMatchObject({ name: "CodexWarmupError", code: "transport" });
    expect(cancelled).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test("classifies invalid timeout options as transport failures", async () => {
    for (const timeoutMs of [-1, 0x8000_0000]) {
      await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c", timeoutMs }))
        .rejects.toMatchObject({ name: "CodexWarmupError", code: "transport" });
    }
  });
});
