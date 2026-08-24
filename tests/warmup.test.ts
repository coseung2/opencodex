import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CodexWarmupError, codexWarmupFailureReason, warmCodexAccount } from "../src/codex/warmup";

const originalFetch = globalThis.fetch;

function sseResponse(frame = 'data: {"type":"response.completed"}\n\n'): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("codex warmup improvements", () => {
  test("codexWarmupFailureReason exposes only the structured status", () => {
    const err = new CodexWarmupError("http_status", "Codex warmup was rejected", {
      status: 400,
    });

    expect(codexWarmupFailureReason(err)).toBe("http_status:400");
  });

  test("warmCodexAccount does not retain structured upstream error text", async () => {
    const privateDetail = "model gpt-5.4-mini is unavailable";
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ error: { message: privateDetail } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await warmCodexAccount({ accessToken: "access-test", chatgptAccountId: "acct-test" });
      throw new Error("expected warmup to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexWarmupError);
      expect((err as CodexWarmupError).code).toBe("http_status");
      expect((err as CodexWarmupError).status).toBe(401);
      expect(codexWarmupFailureReason(err)).toBe("http_status:401");
      expect(JSON.stringify(err)).not.toContain(privateDetail);
      expect((err as Error).message).not.toContain(privateDetail);
    }
  });

  test("warmCodexAccount retries FALLBACK_MODELS when the default model returns 400", async () => {
    const parsedBodies: Record<string, unknown>[] = [];
    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      parsedBodies.push(body);

      if (body.model === "gpt-5.4-mini") {
        return new Response(JSON.stringify({ detail: "unknown model" }), { status: 400 });
      }

      if (body.model === "gpt-5.5") return sseResponse();
      return new Response("unexpected model", { status: 500 });
    });
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    try {
      await warmCodexAccount({ accessToken: "access-test", chatgptAccountId: "acct-test" });
    } finally {
      fetchSpy.mockRestore();
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(parsedBodies.map(body => body.model)).toEqual(["gpt-5.4-mini", "gpt-5.5"]);
  });
});
