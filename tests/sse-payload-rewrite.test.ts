/**
 * Single-pass composition of client-facing SSE payload rewrites (#588 follow-up).
 */
import { describe, expect, test } from "bun:test";
import { createImageGenCallRestoreRewrite } from "../src/server/responses-image-gen-repair";
import { createResponsesItemIdPayloadRewrite } from "../src/server/responses-item-id-repair";
import {
  composeSsePayloadRewrites,
  relaySseWithPayloadRewrite,
  type SsePayloadRewrite,
} from "../src/server/sse-payload-rewrite";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import { relaySseWithFailedTail } from "../src/server/relay";

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(chunk);
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("SSE payload rewrite composition", () => {
  test("reads fragmented events until a complete block is available before upstream EOF", async () => {
    const encoder = new TextEncoder();
    const fragments = ['data: {"type":', '"response.output_text.delta",', '"delta":"hello"}', '\n', '\n'];
    let reads = 0;
    let sourceCancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads < fragments.length) controller.enqueue(encoder.encode(fragments[reads++]!));
        // Keep the upstream open: a complete event must reach Codex before EOF.
      },
      cancel() { sourceCancelled = true; },
    });
    const budget = createTestTranslatorBudget();
    const reader = relaySseWithPayloadRewrite(source, payload => payload.replace("hello", "world"), budget).getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("fragmented SSE event stalled")), 1_000);
        }),
      ]);
      expect(result.done).toBe(false);
      expect(new TextDecoder().decode(result.value)).toBe('data: {"type":"response.output_text.delta","delta":"world"}\n\n');
      expect(reads).toBe(fragments.length);
    } finally {
      clearTimeout(timer);
      await reader.cancel();
      expect(sourceCancelled).toBe(true);
      expect(budget.snapshot().currentBytes).toBe(0);
      budget.dispose();
    }
  });

  test("applies image-gen restore and item-id repair in one relay pass", async () => {
    const upstream = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_0","role":"assistant"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"image_gen__imagegen","arguments":"{}"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","id":"msg_0","role":"assistant"},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"image_gen__imagegen","arguments":"{}"}]}}\n\n',
    ].join("");

    let imageGenCalls = 0;
    let itemIdCalls = 0;
    const imageGen = createImageGenCallRestoreRewrite(
      new Map([["image_gen__imagegen", { namespace: "image_gen", name: "imagegen" }]]),
    )!;
    const itemId = createResponsesItemIdPayloadRewrite({
      message: ["msg_0"],
      repairMissingTerminalIds: true,
    });

    const composed = composeSsePayloadRewrites(
      (payload) => {
        imageGenCalls += 1;
        return imageGen(payload);
      },
      (payload) => {
        itemIdCalls += 1;
        return itemId(payload);
      },
    );

    const budget = createTestTranslatorBudget();
    const out = await readAll(relaySseWithPayloadRewrite(streamFromText(upstream), composed, budget));
    budget.dispose();
    expect(imageGenCalls).toBe(3);
    expect(itemIdCalls).toBe(3);
    expect(imageGenCalls).toBe(itemIdCalls);

    const events = out
      .trim()
      .split(/\r?\n\r?\n/)
      .map(block => block.split(/\r?\n/).find(line => line.startsWith("data:"))?.slice(5).trim())
      .filter((payload): payload is string => !!payload)
      .map(payload => JSON.parse(payload) as Record<string, unknown>);

    const messageAdded = events[0].item as Record<string, unknown>;
    expect(messageAdded.id).toMatch(/^msg_ocx_[0-9a-f]+_0$/);

    const functionAdded = events[1].item as Record<string, unknown>;
    expect(functionAdded).toMatchObject({
      name: "imagegen",
      namespace: "image_gen",
      call_id: "call_1",
    });

    const completed = events[2].response as { output: Record<string, unknown>[] };
    expect(completed.output[0].id).toBe(messageAdded.id);
    expect(completed.output[1]).toMatchObject({
      name: "imagegen",
      namespace: "image_gen",
    });
  });

  test("compose with no rewrites is identity", () => {
    expect(composeSsePayloadRewrites()('{"a":1}')).toBe('{"a":1}');
  });

  test("cancellation during a pending read never invokes the disposed rewrite", async () => {
    const source = new ReadableStream<Uint8Array>({ pull() {} });
    let calls = 0;
    let disposals = 0;
    const rewrite = ((payload: string) => { calls += 1; return payload; }) as SsePayloadRewrite;
    rewrite.dispose = () => { disposals += 1; };
    const budget = createTestTranslatorBudget();
    const reader = relaySseWithPayloadRewrite(source, rewrite, budget).getReader();
    const pending = reader.read();
    await Promise.resolve();
    await reader.cancel();
    expect((await pending).done).toBe(true);
    expect(calls).toBe(0);
    expect(disposals).toBe(1);
    expect(budget.snapshot().currentBytes).toBe(0);
    budget.dispose();
  });

  test("rewrite failures reach the client without waiting for the inspection tee", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {}\n\n')); },
    });
    const [client, inspection] = source.tee();
    const budget = createTestTranslatorBudget();
    const reader = relaySseWithPayloadRewrite(client, () => { throw new Error("rewrite failed"); }, budget).getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(Promise.race([
        reader.read(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("tee cancellation stalled")), 1_000); }),
      ])).rejects.toThrow("rewrite failed");
    } finally {
      clearTimeout(timer);
      await inspection.cancel();
      expect(budget.snapshot().currentBytes).toBe(0);
      budget.dispose();
    }
  });

  test("relay disposes stateful payload rewrites exactly once at EOF", async () => {
    let disposals = 0;
    const rewrite = ((payload: string) => payload) as SsePayloadRewrite;
    rewrite.dispose = () => { disposals += 1; };
    const budget = createTestTranslatorBudget();
    await readAll(relaySseWithPayloadRewrite(streamFromText("data: [DONE]\n\n"), rewrite, budget));
    expect(disposals).toBe(1);
    budget.dispose();
  });

  test("unterminated rewrite accumulation closes through a typed failed tail", async () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 64 });
    const upstream = new AbortController();
    const rewritten = relaySseWithPayloadRewrite(
      streamFromText(`data: ${"x".repeat(80)}`),
      payload => payload,
      budget,
    );

    const out = await readAll(relaySseWithFailedTail(rewritten, upstream));
    expect(out).toContain('"code":"translation_buffer_limit"');
    expect(out).toEndWith("data: [DONE]\n\n");
    expect(upstream.signal.aborted).toBe(true);
    expect(budget.snapshot().currentBytes).toBe(0);
    budget.dispose();
  });
});
