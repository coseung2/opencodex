import { describe, expect, test } from "bun:test";
import {
  getActiveTurnCount,
  onActiveTurnsIdle,
  trackActiveTurnLease,
  tryAdmitTurn,
} from "../src/server/lifecycle";
import { startMemoryWatchdog } from "../src/server/memory-watchdog";
import { createSseInspector } from "../src/server/relay";

describe("active turn lifecycle lease", () => {
  test("notifies idle observers only after the final admitted turn releases", () => {
    expect(getActiveTurnCount()).toBe(0);
    const first = tryAdmitTurn();
    const second = tryAdmitTurn();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const observedCounts: number[] = [];
    const unsubscribe = onActiveTurnsIdle(() => observedCounts.push(getActiveTurnCount()));
    try {
      first!.release();
      expect(observedCounts).toEqual([]);
      second!.release();
      expect(observedCounts).toEqual([0]);
    } finally {
      first!.release();
      second!.release();
      unsubscribe();
    }
  });

  test("only reclaims after the actual final turn releases and stays latched for later turns", async () => {
    let gcCalls = 0;
    const watchdog = startMemoryWatchdog({
      intervalMs: 1,
      pressureThresholdBytes: 2 * 1024 ** 3,
      platform: "win32",
      sample: () => ({
        at: Date.now(),
        rss: 100 * 1024 ** 2,
        heapUsed: 1,
        heapTotal: 2,
        external: 2 * 1024 ** 3,
        arrayBuffers: 1,
      }),
      gc: () => {
        expect(getActiveTurnCount()).toBe(0);
        gcCalls += 1;
      },
      warn: () => {},
    });
    const admission = tryAdmitTurn();
    expect(admission).not.toBeNull();
    try {
      await Bun.sleep(10);
      expect(gcCalls).toBe(0);
      admission!.release();
      expect(gcCalls).toBe(1);

      const later = tryAdmitTurn();
      expect(later).not.toBeNull();
      later!.release();
      expect(gcCalls).toBe(1);
    } finally {
      admission!.release();
      watchdog.stop();
    }
  });

  test("releases bookkeeping after a protocol terminal without aborting upstream", async () => {
    const baseline = getActiveTurnCount();
    const admission = tryAdmitTurn();
    expect(admission).not.toBeNull();
    const upstream = new AbortController();
    const reasons: string[] = [];
    const turn = trackActiveTurnLease(upstream, admission!, {
      terminalLeaseMs: 10,
      onFinish: reason => reasons.push(reason),
    });

    expect(getActiveTurnCount()).toBe(baseline + 1);
    turn.noteProtocolTerminal();
    await Bun.sleep(25);

    expect(getActiveTurnCount()).toBe(baseline);
    expect(upstream.signal.aborted).toBe(false);
    expect(reasons).toEqual(["terminal_lease_expired"]);
  });

  test("upstream abort releases immediately even when inspection never settles", async () => {
    const baseline = getActiveTurnCount();
    const admission = tryAdmitTurn();
    expect(admission).not.toBeNull();
    const upstream = new AbortController();
    const reasons: string[] = [];
    const turn = trackActiveTurnLease(upstream, admission!, {
      terminalLeaseMs: 10,
      onFinish: reason => reasons.push(reason),
    });

    turn.noteProtocolTerminal();
    upstream.abort("client disconnected");
    turn.finish("inspection_settled");
    await Bun.sleep(20);

    expect(getActiveTurnCount()).toBe(baseline);
    expect(reasons).toEqual(["upstream_abort"]);
  });

  test("inspection settlement cancels the terminal lease idempotently", async () => {
    const baseline = getActiveTurnCount();
    const admission = tryAdmitTurn();
    expect(admission).not.toBeNull();
    const upstream = new AbortController();
    const reasons: string[] = [];
    const turn = trackActiveTurnLease(upstream, admission!, {
      terminalLeaseMs: 10,
      onFinish: reason => reasons.push(reason),
    });

    turn.noteProtocolTerminal();
    turn.finish("inspection_settled");
    turn.finish("inspection_settled");
    await Bun.sleep(20);

    expect(getActiveTurnCount()).toBe(baseline);
    expect(reasons).toEqual(["inspection_settled"]);
  });

  test("repeated terminal-only turns return the registry to baseline", () => {
    const baseline = getActiveTurnCount();
    const reasons: string[] = [];

    for (let index = 0; index < 512; index += 1) {
      const admission = tryAdmitTurn();
      expect(admission).not.toBeNull();
      const upstream = new AbortController();
      const turn = trackActiveTurnLease(upstream, admission!, {
        terminalLeaseMs: 0,
        onFinish: reason => reasons.push(reason),
      });
      turn.noteProtocolTerminal();
      turn.finish("inspection_settled");
      expect(upstream.signal.aborted).toBe(false);
    }

    expect(getActiveTurnCount()).toBe(baseline);
    expect(reasons).toHaveLength(512);
    expect(new Set(reasons)).toEqual(new Set(["terminal_lease_expired"]));
  });
});

test("metadata-only SSE inspection observes a protocol terminal once", () => {
  const observed: string[] = [];
  const inspector = createSseInspector({
    onObservedTerminal: status => observed.push(status),
  });
  const terminal = new TextEncoder().encode(
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  );

  inspector.feed(terminal);
  inspector.feed(terminal);

  expect(inspector.terminalSeen()).toBe(true);
  expect(inspector.reported()).toBe(false);
  expect(observed).toEqual(["completed"]);
  inspector.dispose();
});
