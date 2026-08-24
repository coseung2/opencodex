import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  BoundedSseFrameBuffer,
  MAX_CLIENT_SSE_FRAME_BYTES,
  SseFrameCountLimitError,
  SseFrameTooLargeError,
} from "../src/server/sse-frame-buffer";
import { pumpResponsesSseToWebSocket, type WsData } from "../src/server/ws-bridge";

const enc = new TextEncoder();
const dec = new TextDecoder();

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

describe("client-facing SSE frame bounds", () => {
  test("accepts the exact cap and preserves a split delimiter", () => {
    const framer = new BoundedSseFrameBuffer(8);
    expect(framer.feed(enc.encode("1234"))).toEqual([]);
    expect(framer.feed(enc.encode("5678\n"))).toEqual([]);
    const frames = framer.feed(enc.encode("\n"));
    expect(frames).toHaveLength(1);
    expect(dec.decode(frames[0]!.block)).toBe("12345678");
    expect(dec.decode(frames[0]!.delimiter)).toBe("\n\n");
  });

  test("rejects cap plus one and releases the oversized tail", () => {
    const framer = new BoundedSseFrameBuffer(8);
    expect(() => framer.feed(enc.encode("123456789"))).toThrow(SseFrameTooLargeError);
    expect(framer.finish().byteLength).toBe(0);
  });

  test("preserves a committed terminal before trailing overflow", () => {
    const terminal = enc.encode('data: {"type":"response.completed"}\n\n');
    const oversizedTail = new Uint8Array(65).fill(120);
    const framer = new BoundedSseFrameBuffer(64);
    const frames = framer.feed(concatBytes(terminal, oversizedTail));
    expect(frames).toHaveLength(1);
    expect(dec.decode(frames[0]!.block)).toBe('data: {"type":"response.completed"}');
    expect(framer.finish().byteLength).toBe(0);
  });

  test("delimiter-only input cannot amplify one chunk into unbounded objects", () => {
    const framer = new BoundedSseFrameBuffer(4096);
    expect(() => framer.feed(enc.encode("\n\n".repeat(5)))).toThrow(SseFrameCountLimitError);
    expect(framer.finish().byteLength).toBe(0);
  });

  test("WebSocket pump emits one bounded protocol error and cancels upstream", async () => {
    const sent: string[] = [];
    const terminals: string[] = [];
    let sourceCancelled = false;
    const ws = {
      readyState: 1,
      data: {} as WsData,
      send(message: string) {
        sent.push(message);
        return 1;
      },
    } as unknown as ServerWebSocket<WsData>;
    const oversized = new Uint8Array(MAX_CLIENT_SSE_FRAME_BYTES + 1).fill(120);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
      },
      cancel() {
        sourceCancelled = true;
      },
    });

    await pumpResponsesSseToWebSocket(ws, source, { onTerminal: status => terminals.push(status) });

    expect(terminals).toEqual(["incomplete"]);
    expect(sent).toHaveLength(1);
    const error = JSON.parse(sent[0]!) as { error?: { message?: string } };
    expect(error.error?.message).toBe(`upstream SSE frame exceeded ${MAX_CLIENT_SSE_FRAME_BYTES} bytes`);
    expect(sourceCancelled).toBe(true);
    expect(ws.data.cancel).toBeUndefined();
  });

  test("WebSocket pump commits a terminal before an oversized same-chunk tail", async () => {
    const sent: string[] = [];
    const terminals: string[] = [];
    let sourceCancelled = false;
    const ws = {
      readyState: 1,
      data: {} as WsData,
      send(message: string) {
        sent.push(message);
        return 1;
      },
    } as unknown as ServerWebSocket<WsData>;
    const terminal = enc.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n');
    const oversizedTail = new Uint8Array(MAX_CLIENT_SSE_FRAME_BYTES + 1).fill(120);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(concatBytes(terminal, oversizedTail));
      },
      cancel() {
        sourceCancelled = true;
      },
    });

    await pumpResponsesSseToWebSocket(ws, source, { onTerminal: status => terminals.push(status) });

    expect(terminals).toEqual(["completed"]);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!).type).toBe("response.completed");
    expect(sourceCancelled).toBe(true);
  });
});
