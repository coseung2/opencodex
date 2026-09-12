import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { saveCredential } from "../src/oauth/store";
import { XAI_GROK_CLI_BASE_URL, XAI_GROK_CLIENT_VERSION } from "../src/providers/xai-transport";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const RESPONSES_ENDPOINT = `${XAI_GROK_CLI_BASE_URL}/responses`;
const encoder = new TextEncoder();

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-xai-responses-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-xai-responses-"));
  process.env.OPENCODEX_HOME = testDir;
  saveCredential("xai", {
    access: "stream-access",
    refresh: "stream-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "xai-stream-account",
    source: "oauth",
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function config(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "xai",
    fastMode: true,
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "oauth",
        models: ["grok-4.6"],
      },
    },
  } as OcxConfig;
}

function sse(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

describe("xAI OAuth native Responses streaming", () => {
  test("relays the first Grok delta before upstream completion and strips OpenAI-only controls", async () => {
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>(resolve => { releaseCompletion = resolve; });
    let completionReleased = false;
    let outboundBody: Record<string, unknown> | undefined;
    let outboundHeaders: Headers | undefined;
    let upstreamCalls = 0;

    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== RESPONSES_ENDPOINT) return originalFetch(input, init);
      upstreamCalls += 1;
      outboundHeaders = new Headers(init?.headers);
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sse({
            type: "response.created",
            sequence_number: 0,
            response: { id: "resp_xai_stream", object: "response", status: "in_progress", model: "grok-4.6", output: [] },
          }));
          controller.enqueue(sse({
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: { id: "msg_xai_stream", type: "message", status: "in_progress", role: "assistant", content: [] },
          }));
          controller.enqueue(sse({
            type: "response.output_text.delta",
            sequence_number: 2,
            item_id: "msg_xai_stream",
            output_index: 0,
            content_index: 0,
            delta: "first",
          }));
          void completionGate.then(() => {
            completionReleased = true;
            const message = {
              id: "msg_xai_stream",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "first second", annotations: [] }],
            };
            controller.enqueue(sse({ type: "response.output_item.done", sequence_number: 3, output_index: 0, item: message }));
            controller.enqueue(sse({
              type: "response.completed",
              sequence_number: 4,
              response: {
                id: "resp_xai_stream", object: "response", status: "completed", model: "grok-4.6",
                output: [message], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
              },
            }));
            controller.close();
          });
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    saveConfig(config());
    const server = startServer(0);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "xai/grok-4.6",
          input: "hello",
          stream: true,
          store: false,
          service_tier: "priority",
          text: { verbosity: "high" },
          reasoning: { effort: "xhigh", summary: "auto" },
        }),
      });
      expect(response.status).toBe(200);
      reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";
      await Promise.race([
        (async () => {
          while (!received.includes("response.output_text.delta")) {
            const chunk = await reader!.read();
            if (chunk.done) throw new Error("stream ended before the first xAI delta");
            received += decoder.decode(chunk.value, { stream: true });
          }
        })(),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("the first xAI delta was not relayed before completion")),
          1_500,
        )),
      ]);

      expect(received).toContain("first");
      expect(completionReleased).toBe(false);
      expect(upstreamCalls).toBe(1);
      expect(outboundBody?.model).toBe("grok-4.6");
      expect(outboundBody?.input).toBe("hello");
      expect(outboundBody?.stream).toBe(true);
      expect(outboundBody?.service_tier).toBeUndefined();
      expect((outboundBody?.text as Record<string, unknown> | undefined)?.verbosity).toBeUndefined();
      expect(outboundBody?.reasoning).toMatchObject({ effort: "xhigh" });
      expect(outboundBody?.messages).toBeUndefined();
      expect(outboundHeaders?.get("authorization")).toBe("Bearer stream-access");
      expect(outboundHeaders?.get("x-grok-client-identifier")).toBe("opencodex");
      expect(outboundHeaders?.get("x-grok-client-version")).toBe(XAI_GROK_CLIENT_VERSION);

      releaseCompletion();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).toContain("response.completed");
    } finally {
      releaseCompletion();
      await reader?.cancel().catch(() => {});
      await server.stop(true);
    }
  }, 10_000);

  test("Grok-tagged Responses reconstruct a sparse terminal snapshot and required annotations", async () => {
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== RESPONSES_ENDPOINT) return originalFetch(input, init);
      const frames = [
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_sparse", status: "in_progress", role: "assistant", content: [] } },
        { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg_sparse", part: { type: "output_text", text: "" } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_sparse", delta: "answer" },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_sparse", status: "completed", role: "assistant", content: [{ type: "output_text", text: "answer" }] } },
        { type: "response.completed", response: { id: "resp_sparse", status: "completed", model: "grok-4.6", output: [] } },
      ];
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    saveConfig(config());
    const server = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencodex-grok": "1" },
        body: JSON.stringify({ model: "xai/grok-4.6", input: "hello", stream: true, store: false }),
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      const payloads = text.split(/\r?\n/)
        .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
      const partAdded = payloads.find(frame => frame.type === "response.content_part.added")!;
      expect(partAdded.part).toMatchObject({ type: "output_text", annotations: [] });
      const completed = payloads.find(frame => frame.type === "response.completed")!;
      const snapshot = completed.response as { output: Array<Record<string, unknown>> };
      expect(snapshot.output).toHaveLength(1);
      expect(snapshot.output[0]).toMatchObject({
        type: "message",
        id: "msg_sparse",
        content: [{ type: "output_text", text: "answer", annotations: [] }],
      });
    } finally {
      await server.stop(true);
    }
  });

  test("flattens namespace tools for Grok and restores namespaced function calls to Codex", async () => {
    let outboundBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== RESPONSES_ENDPOINT) return originalFetch(input, init);
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const item = {
        type: "function_call",
        id: "fc_read",
        call_id: "call_read",
        name: "mcp__workspace__read_file",
        arguments: JSON.stringify({ path: "README.md" }),
        status: "completed",
      };
      const frames = [
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_namespace", status: "completed", model: "grok-4.6", output: [item] } },
      ];
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    saveConfig(config());
    const server = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "xai/grok-4.6",
          input: "read the file",
          stream: true,
          store: false,
          tools: [{
            type: "namespace",
            name: "mcp__workspace",
            tools: [{
              type: "function",
              name: "read_file",
              description: "Read a file",
              parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            }],
          }],
        }),
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      const outboundTools = outboundBody?.tools as Array<Record<string, unknown>>;
      expect(outboundTools).toEqual([expect.objectContaining({
        type: "function",
        name: "mcp__workspace__read_file",
      })]);
      expect(outboundTools.some(tool => tool.type === "namespace")).toBe(false);
      expect(text).toContain('"namespace":"mcp__workspace"');
      expect(text).toContain('"name":"read_file"');
      expect(text).not.toContain('"name":"mcp__workspace__read_file"');
    } finally {
      await server.stop(true);
    }
  });

  test("a selected Grok tool whose schema cannot be represented fails locally as a 400", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === RESPONSES_ENDPOINT) upstreamCalls += 1;
      return originalFetch(input, init);
    }) as typeof fetch;

    saveConfig(config());
    const server = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "xai/grok-4.6",
          input: "use unsafe",
          stream: true,
          tools: [{ type: "function", name: "unsafe", description: "cannot lower", parameters: { oneOf: [{ type: "string" }] } }],
          tool_choice: { type: "function", name: "unsafe" },
        }),
      });
      const json = await response.json() as { error?: { type?: string; message?: string } };
      expect(response.status).toBe(400);
      expect(json.error?.type).toBe("invalid_request_error");
      expect(json.error?.message).toContain("cannot be represented");
      expect(upstreamCalls).toBe(0);
    } finally {
      await server.stop(true);
    }
  });
});
