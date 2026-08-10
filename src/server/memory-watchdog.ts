/**
 * Memory watchdog (#314 WP3 / #509) — observability plus a bounded Windows
 * native-memory reclamation attempt for the Bun fetch-buffer retention shape.
 *
 * Samples process.memoryUsage() on an unref'd interval into a bounded ring and
 * logs ONE rate-limited warning when observed memory crosses the threshold. On
 * Windows, a supported Bun.gc(true) is attempted once per pressure episode,
 * only after observed memory reaches the reclamation threshold and the active
 * turn registry is idle. The active instance is a module-level singleton so
 * the management API can expose the snapshot without threading server state
 * through route contexts.
 *
 * Privacy: samples are scalar numbers only; the warn line never interpolates
 * paths, hostnames, or tokens.
 */

import { getActiveTurnCount, onActiveTurnsIdle } from "./lifecycle";

export type MemorySampleBase = {
  /** Epoch ms. */
  at: number;
  /** Resident set size in bytes. */
  rss: number;
  /** JS heap used in bytes (process.memoryUsage().heapUsed). */
  heapUsed: number;
  /** JS heap total in bytes. */
  heapTotal: number;
  /** External/native memory tracked by process.memoryUsage(). */
  external: number;
  /** ArrayBuffer memory tracked by process.memoryUsage(). */
  arrayBuffers: number;
};

export type MemorySample = MemorySampleBase & {
  /** Largest observed memory counter used for thresholding. */
  observedBytes: number;
  /** Counter that produced observedBytes. */
  observedMetric: MemoryMetric;
};

export type MemoryMetric = "rss" | "external" | "arrayBuffers";

export type MemoryWatchdogState = {
  samples: MemorySample[];
  warnThresholdBytes: number;
  lastWarnAt: number | null;
  observedBytes: number;
  observedMetric: MemoryMetric;
};

export type MemoryWatchdog = {
  stop(): void;
  snapshot(): MemoryWatchdogState;
};

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_WARN_THRESHOLD_BYTES = 4 * 1024 ** 3; // 4 GiB
const DEFAULT_RECLAIM_THRESHOLD_BYTES = 2 * 1024 ** 3; // 2 GiB, based on Windows reproduction
const DEFAULT_RING_SIZE = 360; // ≈6h at 60s
const WARN_INTERVAL_MS = 30 * 60_000;
const DOCS_URL = "https://opencodex.me/troubleshooting/windows-memory/";

let active: MemoryWatchdog | null = null;

export function observedMemoryCounter(sample: Pick<MemorySampleBase, "rss" | "external" | "arrayBuffers">): {
  observedBytes: number;
  observedMetric: MemoryMetric;
} {
  const values: Array<{ metric: MemoryMetric; bytes: number }> = [
    { metric: "rss", bytes: sample.rss },
    { metric: "external", bytes: sample.external },
    { metric: "arrayBuffers", bytes: sample.arrayBuffers },
  ];
  const best = values.reduce((current, next) => next.bytes > current.bytes ? next : current, values[0]);
  return { observedBytes: best.bytes, observedMetric: best.metric };
}

export type MemoryReclamationPolicyInput = {
  observedBytes: number;
  pressureThresholdBytes: number;
  activeTurns: number;
  platform: NodeJS.Platform;
  gcSupported: boolean;
  pressureLatched: boolean;
};

/** Pure policy gate for the pressure-triggered, idle-only reclamation path. */
export function shouldAttemptMemoryReclamation(input: MemoryReclamationPolicyInput): boolean {
  return input.platform === "win32"
    && input.gcSupported
    && input.activeTurns === 0
    && input.observedBytes >= input.pressureThresholdBytes
    && !input.pressureLatched;
}

/** The running watchdog, if any — read by /api/system/memory. */
export function getActiveMemoryWatchdog(): MemoryWatchdog | null {
  return active;
}

function defaultSample(now: () => number): MemorySample {
  const usage = process.memoryUsage();
  const base = {
    at: now(),
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
  return { ...base, ...observedMemoryCounter(base) };
}

function normalizeSample(sample: MemorySampleBase): MemorySample {
  return { ...sample, ...observedMemoryCounter(sample) };
}

function defaultGarbageCollector(platform: NodeJS.Platform): (() => void) | null {
  if (platform !== "win32") return null;
  if (typeof Bun === "undefined" || typeof Bun.gc !== "function") return null;
  return () => Bun.gc(true);
}

/**
 * Start (or replace) the process-wide memory watchdog. Idempotent: a previous
 * active instance is stopped first, so repeated startServer() calls in tests
 * never accumulate intervals. The timer is unref'd; stop() is exposed for
 * tests and clears the singleton.
 */
export function startMemoryWatchdog(opts?: {
  intervalMs?: number;
  warnThresholdBytes?: number;
  pressureThresholdBytes?: number;
  ringSize?: number;
  now?: () => number;
  sample?: () => MemorySampleBase;
  warn?: (msg: string) => void;
  platform?: NodeJS.Platform;
  activeTurnCount?: () => number;
  gc?: (() => void) | null;
}): MemoryWatchdog {
  active?.stop();
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const warnThresholdBytes = opts?.warnThresholdBytes ?? DEFAULT_WARN_THRESHOLD_BYTES;
  const pressureThresholdBytes = opts?.pressureThresholdBytes ?? DEFAULT_RECLAIM_THRESHOLD_BYTES;
  const ringSize = opts?.ringSize ?? DEFAULT_RING_SIZE;
  const now = opts?.now ?? Date.now;
  const sample = opts?.sample ?? (() => defaultSample(now));
  const warn = opts?.warn ?? ((msg: string) => console.warn(msg));
  const platform = opts?.platform ?? process.platform;
  const activeTurnCount = opts?.activeTurnCount ?? getActiveTurnCount;
  const collectGarbage = opts !== undefined && "gc" in opts
    ? opts.gc ?? null
    : defaultGarbageCollector(platform);

  const samples: MemorySample[] = [];
  let lastWarnAt: number | null = null;
  let observedBytes = 0;
  let observedMetric: MemoryMetric = "rss";
  let pressureLatched = false;

  const reclaimIfIdle = (): void => {
    if (!shouldAttemptMemoryReclamation({
      observedBytes,
      pressureThresholdBytes,
      activeTurns: activeTurnCount(),
      platform,
      gcSupported: collectGarbage !== null,
      pressureLatched,
    })) return;
    // Latch before calling Bun.gc so a sustained high sample cannot turn into
    // a GC on every timer tick or every later turn completion.
    pressureLatched = true;
    try {
      collectGarbage?.();
    } catch {
      // Reclamation is a best-effort runtime hint. A collector failure must not
      // escape the watchdog timer and terminate the proxy.
    }
  };
  const removeIdleListener = platform === "win32" && collectGarbage !== null
    ? onActiveTurnsIdle(reclaimIfIdle)
    : () => {};

  const tick = () => {
    let s: MemorySample;
    try {
      s = normalizeSample(sample());
    } catch {
      return; // sampling must never break the server
    }
    samples.push(s);
    if (samples.length > ringSize) samples.splice(0, samples.length - ringSize);
    observedBytes = s.observedBytes;
    observedMetric = s.observedMetric;
    if (observedBytes < pressureThresholdBytes) pressureLatched = false;
    reclaimIfIdle();
    if (s.observedBytes >= warnThresholdBytes && (lastWarnAt === null || now() - lastWarnAt >= WARN_INTERVAL_MS)) {
      lastWarnAt = now();
      const observedMb = Math.round(s.observedBytes / (1024 * 1024));
      const thresholdMb = Math.round(warnThresholdBytes / (1024 * 1024));
      warn(`⚠️  opencodex observed memory ${observedMb}MB (${s.observedMetric}) exceeds the ${thresholdMb}MB watch threshold. On Windows this is usually the upstream Bun runtime memory issue — see ${DOCS_URL}`);
    }
  };

  const timer = setInterval(tick, intervalMs);
  (timer as { unref?: () => void }).unref?.();

  const instance: MemoryWatchdog = {
    stop() {
      clearInterval(timer);
      removeIdleListener();
      if (active === instance) active = null;
    },
    snapshot() {
      return { samples: [...samples], warnThresholdBytes, lastWarnAt, observedBytes, observedMetric };
    },
  };
  active = instance;
  return instance;
}
