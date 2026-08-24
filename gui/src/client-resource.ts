import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createBoundedFetch } from "./bounded-fetch";

export type ResourceSnapshot<T> = {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /**
   * A request is in flight. Unlike `loading`, this never means "replace the content":
   * a quiet poll over cached data raises only this, so a slow revalidation stays visible
   * without blanking the surface.
   */
  refreshing: boolean;
  /** Set once a fetch resolved successfully for this key. Survives later failures. */
  hasSucceeded: boolean;
  /** False when the latest settled attempt failed, so stale-but-shown differs from healthy. */
  lastAttemptOk: boolean;
};

type Store<T> = {
  snapshot: ResourceSnapshot<T>;
  listeners: Set<() => void>;
  /** listener → requested poll interval (undefined = no poll from that subscriber) */
  pollByListener: Map<() => void, number | undefined>;
  /**
   * listener → whether that subscriber's poll may be skipped while the document is hidden.
   *
   * Per subscriber rather than per store: a fixed key can be shared by consumers with
   * different needs, and one opt-out must not be lost because a peer subscribed later.
   */
  pauseWhenHiddenByListener: Map<() => void, boolean>;
  /** listener → fetcher owned by that subscriber */
  fetcherByListener: Map<() => void, (signal: AbortSignal) => Promise<T>>;
  /** listener → per-attempt deadline owned by that subscriber (undefined = default) */
  deadlineByListener: Map<() => void, number | undefined>;
  subscriberCount: number;
  /** Currently scheduled poll interval; avoids resetting the countdown on churn. */
  pollIntervalMs: number | undefined;
  inflight: AbortController | null;
  /** Subscriber that started the current in-flight request (if any). */
  inflightOwner: (() => void) | null;
  generation: number;
  /**
   * Set when `setClientResourceData` publishes while nobody is subscribed (session-cache
   * seed). The first subscribe must quiet-revalidate; otherwise mount never fetches and
   * seeded rows stay indefinitely stale with `lastAttemptOk: true`.
   */
  seedNeedsRevalidate: boolean;
  /** Epoch time of the latest successful settle, used by opt-in revisit freshness. */
  lastSettledAt: number | undefined;
};

/**
 * Module cache keyed by string. Call sites must not reuse the same key for
 * different resource types (no runtime check — keys are an API contract).
 */
const stores = new Map<string, Store<unknown>>();

/** Fork-standard deadline for ordinary management reads; documented-slow endpoints override it. */
const DEFAULT_REQUEST_DEADLINE_MS = 15_000;

const EMPTY_SNAPSHOT: ResourceSnapshot<never> = {
  data: undefined,
  error: undefined,
  loading: false,
  refreshing: false,
  hasSucceeded: false,
  lastAttemptOk: false,
};

function getStore<T>(key: string): Store<T> {
  let store = stores.get(key) as Store<T> | undefined;
  if (!store) {
    store = {
      snapshot: {
        data: undefined,
        error: undefined,
        loading: false,
        refreshing: false,
        hasSucceeded: false,
        lastAttemptOk: false,
      },
      listeners: new Set(),
      pollByListener: new Map(),
      pauseWhenHiddenByListener: new Map(),
      fetcherByListener: new Map(),
      deadlineByListener: new Map(),
      subscriberCount: 0,
      pollIntervalMs: undefined,
      inflight: null,
      inflightOwner: null,
      generation: 0,
      seedNeedsRevalidate: false,
      lastSettledAt: undefined,
    };
    stores.set(key, store);
  }
  return store;
}

function emit<T>(store: Store<T>) {
  for (const listener of store.listeners) listener();
}

type PollBucket = {
  timer: ReturnType<typeof setInterval> | null;
  stores: Set<Store<unknown>>;
};

/** One scheduler per distinct cadence, shared by every resource at that cadence. */
const pollBuckets = new Map<number, PollBucket>();

function anyOptOut<T>(store: Store<T>): boolean {
  for (const [listener, ms] of store.pollByListener) {
    if (
      typeof ms === "number"
      && ms > 0
      && store.pauseWhenHiddenByListener.get(listener) === false
    ) {
      return true;
    }
  }
  return false;
}

function bucketShouldRun(bucket: PollBucket): boolean {
  if (bucket.stores.size === 0) return false;
  if (!documentIsHidden()) return true;
  for (const store of bucket.stores) {
    if (anyOptOut(store)) return true;
  }
  return false;
}

function runBucketTick(bucket: PollBucket): void {
  for (const store of bucket.stores) {
    const entry = pickPollEntry(store);
    if (!entry) continue;
    void runFetch(store, entry.fetcher, {
      replaceInflight: false,
      owner: entry.owner,
      deadlineMs: entry.deadlineMs,
    });
  }
}

function syncBucketTimer(intervalMs: number, bucket: PollBucket): void {
  const shouldRun = bucketShouldRun(bucket);
  if (shouldRun && bucket.timer === null) {
    bucket.timer = setInterval(() => runBucketTick(bucket), intervalMs);
  } else if (!shouldRun && bucket.timer !== null) {
    clearInterval(bucket.timer);
    bucket.timer = null;
  }
  if (bucket.stores.size === 0) pollBuckets.delete(intervalMs);
}

function syncAllBuckets(): void {
  for (const [intervalMs, bucket] of [...pollBuckets]) {
    syncBucketTimer(intervalMs, bucket);
  }
}

function leavePollBucket<T>(store: Store<T>): void {
  const current = store.pollIntervalMs;
  if (current === undefined) return;
  const bucket = pollBuckets.get(current);
  store.pollIntervalMs = undefined;
  if (!bucket) return;
  bucket.stores.delete(store as Store<unknown>);
  syncBucketTimer(current, bucket);
}

function joinPollBucket<T>(store: Store<T>, intervalMs: number): void {
  let bucket = pollBuckets.get(intervalMs);
  if (!bucket) {
    bucket = { timer: null, stores: new Set() };
    pollBuckets.set(intervalMs, bucket);
  }
  bucket.stores.add(store as Store<unknown>);
  store.pollIntervalMs = intervalMs;
  syncBucketTimer(intervalMs, bucket);
}

/** True when the document is currently hidden. Safe on non-browser runtimes. */
function documentIsHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Pick a subscriber whose poll may run right now.
 *
 * While the document is hidden only subscribers that opted out of pausing are eligible:
 * a background tab has no one reading the paint, but a restart-reconnect poll still has
 * to notice the server coming back. When nothing opted out, the tick is skipped entirely.
 */
function pickPollEntry<T>(
  store: Store<T>,
): {
  owner: () => void;
  fetcher: (signal: AbortSignal) => Promise<T>;
  deadlineMs: number | undefined;
} | null {
  if (!documentIsHidden()) return pickFetcherEntry(store);
  for (const [listener, ms] of store.pollByListener) {
    if (typeof ms !== "number" || ms <= 0) continue;
    if (store.pauseWhenHiddenByListener.get(listener) === false) {
      const fetcher = store.fetcherByListener.get(listener);
      if (fetcher) {
        return { owner: listener, fetcher, deadlineMs: store.deadlineByListener.get(listener) };
      }
    }
  }
  return null;
}

/** Prefer a polling subscriber's fetcher; otherwise any remaining subscriber. */
function pickFetcherEntry<T>(
  store: Store<T>,
): {
  owner: () => void;
  fetcher: (signal: AbortSignal) => Promise<T>;
  deadlineMs: number | undefined;
} | null {
  for (const [listener, ms] of store.pollByListener) {
    if (typeof ms === "number" && ms > 0) {
      const fetcher = store.fetcherByListener.get(listener);
      if (fetcher) {
        return { owner: listener, fetcher, deadlineMs: store.deadlineByListener.get(listener) };
      }
    }
  }
  for (const [listener, fetcher] of store.fetcherByListener) {
    return { owner: listener, fetcher, deadlineMs: store.deadlineByListener.get(listener) };
  }
  return null;
}

/** Honor the most aggressive (smallest positive) poll interval among subscribers. */
function recomputePoll<T>(store: Store<T>) {
  let pollMs: number | undefined;
  for (const ms of store.pollByListener.values()) {
    if (typeof ms === "number" && ms > 0) {
      pollMs = pollMs === undefined ? ms : Math.min(pollMs, ms);
    }
  }
  if (pollMs === undefined) {
    leavePollBucket(store);
    removeVisibilityListener();
    return;
  }
  if (pollMs === store.pollIntervalMs) {
    const bucket = pollBuckets.get(pollMs);
    if (bucket) syncBucketTimer(pollMs, bucket);
    ensureVisibilityListener();
    return;
  }
  leavePollBucket(store);
  joinPollBucket(store, pollMs);
  ensureVisibilityListener();
}

/**
 * One shared listener re-evaluates every scheduler bucket and makes up missed ticks.
 *
 * `replaceInflight: false` keeps this from cancelling work a visible-again mount just
 * started; if something is already loading, that request is the fresh answer.
 */
let moduleVisibilityListener: (() => void) | null = null;

function ensureVisibilityListener() {
  if (typeof document === "undefined" || moduleVisibilityListener) return;
  const onVisibility = () => {
    syncAllBuckets();
    if (documentIsHidden()) return;
    for (const bucket of pollBuckets.values()) {
      for (const store of bucket.stores) {
        const entry = pickFetcherEntry(store);
        if (!entry) continue;
        void runFetch(store, entry.fetcher, {
          replaceInflight: false,
          owner: entry.owner,
          deadlineMs: entry.deadlineMs,
        });
      }
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  moduleVisibilityListener = onVisibility;
}

function removeVisibilityListener() {
  if (!moduleVisibilityListener || pollBuckets.size > 0) return;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", moduleVisibilityListener);
  }
  moduleVisibilityListener = null;
}

async function runFetch<T>(
  store: Store<T>,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options?: {
    replaceInflight?: boolean;
    owner?: (() => void) | null;
    forceLoading?: boolean;
    deadlineMs?: number;
  },
) {
  const replaceInflight = options?.replaceInflight !== false;
  if (store.inflight && !replaceInflight) return;

  if (replaceInflight) store.inflight?.abort();
  const deadlineMs = options?.deadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS;
  const bounded = createBoundedFetch(deadlineMs);
  const controller = bounded.controller;
  store.inflight = controller;
  store.inflightOwner = options?.owner ?? null;
  const gen = ++store.generation;

  // Falsy cached values stay visible during polls; forceLoading is for identity changes (deps).
  // `refreshing` always rises so a slow revalidation is observable without blanking content.
  const shouldShowLoading = store.snapshot.data === undefined || options?.forceLoading === true;
  store.snapshot = {
    ...store.snapshot,
    loading: shouldShowLoading ? true : store.snapshot.loading,
    refreshing: true,
  };
  emit(store);

  try {
    const data = await Promise.race([
      fetcher(bounded.signal),
      new Promise<never>((_resolve, reject) => {
        bounded.signal.addEventListener(
          "abort",
          () => reject(new Error(`resource request timed out after ${deadlineMs}ms`)),
          { once: true },
        );
      }),
    ]);
    if (gen !== store.generation || bounded.signal.aborted) return;
    // Cleared on settle (not at subscribe) so StrictMode's aborted first mount still revalidates.
    store.seedNeedsRevalidate = false;
    store.lastSettledAt = Date.now();
    store.snapshot = {
      data,
      error: undefined,
      loading: false,
      refreshing: false,
      hasSucceeded: true,
      lastAttemptOk: true,
    };
  } catch (error) {
    // Every owner abort increments generation synchronously. An abort that keeps this
    // generation is therefore the bounded-fetch deadline and must settle as failure.
    if (gen !== store.generation) return;
    store.seedNeedsRevalidate = false;
    store.snapshot = {
      ...store.snapshot,
      // Normalize so a loader that rejects with `undefined` still reads as a failure.
      error: error === undefined ? new Error("resource load failed") : error,
      loading: false,
      refreshing: false,
      lastAttemptOk: false,
    };
  } finally {
    bounded.clear();
    if (store.inflight === controller) {
      store.inflight = null;
      store.inflightOwner = null;
    }
    emit(store);
  }
}

function abortInflightOwnedBy<T>(store: Store<T>, owner: () => void): boolean {
  if (store.inflightOwner !== owner) return false;
  store.inflight?.abort();
  store.inflight = null;
  store.inflightOwner = null;
  store.generation++;
  // The aborted request will never reach its own settle path, so clear its progress marker here.
  if (store.snapshot.refreshing) {
    store.snapshot = { ...store.snapshot, refreshing: false };
    emit(store);
  }
  return true;
}

/**
 * Drop the module cache only after a macrotask so React's subscribe teardown +
 * resubscribe (pollMs / enabled / key churn) can reattach in the same turn
 * without wiping cached data.
 */
function scheduleStoreEviction(key: string, store: Store<unknown>) {
  leavePollBucket(store);
  // The visibility listener exists to wake a poll; with no poll left there is nothing to
  // wake, and leaving it attached would leak one handler per evicted store.
  removeVisibilityListener();
  setTimeout(() => {
    if (store.subscriberCount !== 0) return;
    if (stores.get(key) !== store) return;
    store.generation++;
    store.inflight?.abort();
    store.inflight = null;
    store.inflightOwner = null;
    stores.delete(key);
  }, 0);
}

type ListenerRegistration<T> = {
  fetcher: (signal: AbortSignal) => Promise<T>;
  pollMs?: number;
  pauseWhenHidden?: boolean;
  deadlineMs?: number;
  staleAfterMs?: number;
};

function subscribeResource<T>(
  key: string,
  onStoreChange: () => void,
  registration: ListenerRegistration<T>,
) {
  const { fetcher, pollMs, pauseWhenHidden = true, deadlineMs, staleAfterMs } = registration;
  const store = getStore<T>(key);
  store.listeners.add(onStoreChange);
  store.pollByListener.set(onStoreChange, pollMs);
  store.pauseWhenHiddenByListener.set(onStoreChange, pauseWhenHidden);
  store.fetcherByListener.set(onStoreChange, fetcher);
  store.deadlineByListener.set(onStoreChange, deadlineMs);
  store.subscriberCount++;

  // Cold start, or a pre-subscribe seed that still needs a network check. Keep
  // cached data across transient 0→1 resubscribe gaps when neither applies.
  if (store.subscriberCount === 1) {
    const stale = typeof staleAfterMs === "number"
      && store.lastSettledAt !== undefined
      && Date.now() - store.lastSettledAt > staleAfterMs;
    if (store.snapshot.data === undefined || store.seedNeedsRevalidate || stale) {
      void runFetch(store, fetcher, {
        replaceInflight: true,
        owner: onStoreChange,
        deadlineMs,
      });
    }
  }
  recomputePoll(store);

  return () => {
    store.listeners.delete(onStoreChange);
    store.pollByListener.delete(onStoreChange);
    store.pauseWhenHiddenByListener.delete(onStoreChange);
    store.fetcherByListener.delete(onStoreChange);
    store.deadlineByListener.delete(onStoreChange);
    store.subscriberCount--;
    // Drop this subscriber's in-flight work so a late resolve cannot stomp shared data.
    const abortedOwned = abortInflightOwnedBy(store, onStoreChange);
    if (store.subscriberCount === 0) {
      scheduleStoreEviction(key, store);
      return;
    }
    // Replace aborted work immediately so the shared snapshot cannot stay stuck loading.
    if (abortedOwned) {
      const entry = pickFetcherEntry(store);
      if (entry) {
        void runFetch(store, entry.fetcher, {
          replaceInflight: true,
          owner: entry.owner,
          deadlineMs: entry.deadlineMs,
        });
      }
    }
    recomputePoll(store);
  };
}

/** Module-level fetch cache with useSyncExternalStore subscriptions (no fetch in useEffect). */
export interface ClientResourceOptions<T = unknown> {
  pollMs?: number;
  enabled?: boolean;
  /**
   * Whether this subscriber's poll may be skipped while the document is hidden.
   * Defaults to true. Set false for polls whose whole purpose is to notice something
   * happening off-screen — a restarting server, for instance.
   */
  pauseWhenHidden?: boolean;
  /**
   * Optional seed applied once before the first subscribe (session-cache revisit).
   * Lives in the store — not a render-time ref — so React Compiler / react-hooks/refs
   * stay quiet while the mount fetch still quiet-revalidates via `seedNeedsRevalidate`.
   */
  initialData?: T;
  /** Per-attempt deadline override. Defaults to 15 seconds. */
  deadlineMs?: number;
  /** Revalidate on subscribe only after successful data exceeds this age. */
  staleAfterMs?: number;
  /** Timestamp attached to initialData; null/undefined means unknown and therefore stale. */
  initialDataCachedAt?: number | null;
}

/** Seed an empty, unsubscribed store. No-ops when data already exists or someone is listening. */
function seedClientResourceIfEmpty<T>(
  key: string,
  data: T,
  cachedAt?: number | null,
  staleAfterMs?: number,
): void {
  const store = getStore<T>(key);
  if (store.subscriberCount !== 0 || store.snapshot.data !== undefined) return;
  setClientResourceData(key, data);
  if (
    typeof staleAfterMs === "number"
    && typeof cachedAt === "number"
    && Date.now() - cachedAt < staleAfterMs
  ) {
    store.seedNeedsRevalidate = false;
    store.lastSettledAt = cachedAt;
  }
}

export function useClientResource<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options?: ClientResourceOptions<T>,
): ResourceSnapshot<T> & { refresh: (opts?: { forceLoading?: boolean }) => void } {
  const enabled = options?.enabled !== false;
  const pollMs = options?.pollMs;
  // Default true: a background tab has nobody reading the paint. Opt out for polls that
  // must keep running while hidden, such as waiting for a restarted server to answer.
  const pauseWhenHidden = options?.pauseWhenHidden !== false;
  const deadlineMs = options?.deadlineMs;
  const staleAfterMs = options?.staleAfterMs;
  if (enabled && options?.initialData !== undefined) {
    seedClientResourceIfEmpty(
      key,
      options.initialData,
      options.initialDataCachedAt,
      staleAfterMs,
    );
  }
  const fetcherRef = useRef(fetcher);
  // Sync latest fetcher every commit. No dep array on purpose: inline fetchers are
  // reallocated every render; listing them would re-subscribe forever.
  useLayoutEffect(() => {
    fetcherRef.current = fetcher;
  });

  const stableFetcher = useCallback(
    (signal: AbortSignal) => fetcherRef.current(signal),
    [],
  );

  const listenerRef = useRef<(() => void) | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!enabled) return () => {};
      listenerRef.current = onStoreChange;
      return subscribeResource(key, onStoreChange, {
        fetcher: stableFetcher,
        pollMs,
        pauseWhenHidden,
        deadlineMs,
        staleAfterMs,
      });
    },
    [key, stableFetcher, pollMs, enabled, pauseWhenHidden, deadlineMs, staleAfterMs],
  );

  const getSnapshot = useCallback((): ResourceSnapshot<T> => {
    if (!enabled) return EMPTY_SNAPSHOT;
    return getStore<T>(key).snapshot;
  }, [key, enabled]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refresh = useCallback((opts?: { forceLoading?: boolean }) => {
    if (!enabled) return;
    const store = getStore<T>(key);
    void runFetch(store, stableFetcher, {
      replaceInflight: true,
      owner: listenerRef.current,
      forceLoading: opts?.forceLoading,
      deadlineMs: listenerRef.current
        ? store.deadlineByListener.get(listenerRef.current)
        : deadlineMs,
    });
  }, [key, stableFetcher, enabled, deadlineMs]);

  return { ...snapshot, refresh };
}

function depsChanged(prev: readonly unknown[] | null, next: readonly unknown[]): boolean {
  if (prev === null) return false;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

/**
 * Like `useClientResource`, but refetches when `deps` change (element-wise
 * `Object.is`), even if the cache `key` stays the same. Callers may allocate a
 * fresh deps array each render — identity of the array is ignored.
 * Deps changes force `loading: true` while retaining previous data until the
 * new response arrives (unlike quiet poll refreshes).
 */
export function useKeyedClientResource<T>(
  key: string,
  deps: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>,
  options?: ClientResourceOptions<T>,
): ResourceSnapshot<T> & { refresh: (opts?: { forceLoading?: boolean }) => void } {
  const resource = useClientResource(key, load, options);
  const prevDepsRef = useRef<readonly unknown[] | null>(null);
  const prevKeyRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const prev = prevDepsRef.current;
    const prevKey = prevKeyRef.current;
    prevDepsRef.current = deps;
    prevKeyRef.current = key;
    if (!depsChanged(prev, deps)) return;
    // When the key moved with the deps, subscribing to the new key already started a cold fetch.
    // Revalidating here as well would double every request on a keyed identity change.
    if (prevKey !== null && prevKey !== key) return;
    resource.refresh({ forceLoading: true });
  });

  return resource;
}

/** Publish data for a key and invalidate any in-flight fetch so it cannot stomp this write. */
export function setClientResourceData<T>(key: string, data: T) {
  const store = getStore<T>(key);
  store.inflight?.abort();
  store.inflight = null;
  store.inflightOwner = null;
  store.generation++;
  store.snapshot = {
    data,
    error: undefined,
    loading: false,
    refreshing: false,
    hasSucceeded: true,
    lastAttemptOk: true,
  };
  // Only pre-subscribe seeds need a follow-up fetch. Live publishers (mutation
  // results) already hold the fresh value and must not schedule a redundant GET.
  store.seedNeedsRevalidate = store.subscriberCount === 0;
  store.lastSettledAt = Date.now();
  emit(store);
}

/** Test-only: drop every module cache entry so suite order cannot skip cold-start fetches. */
export function clearClientResourceStoresForTests(): void {
  for (const store of stores.values()) {
    leavePollBucket(store);
    removeVisibilityListener();
    store.generation++;
    store.inflight?.abort();
    store.inflight = null;
    store.inflightOwner = null;
  }
  stores.clear();
  for (const [intervalMs, bucket] of [...pollBuckets]) {
    if (bucket.timer !== null) clearInterval(bucket.timer);
    pollBuckets.delete(intervalMs);
  }
  if (moduleVisibilityListener && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", moduleVisibilityListener);
  }
  moduleVisibilityListener = null;
}

/** Test-only evidence that a key currently owns an armed shared scheduler. */
export function hasPollTimerForTests(key: string): boolean {
  const store = stores.get(key);
  if (!store || store.pollIntervalMs === undefined) return false;
  const bucket = pollBuckets.get(store.pollIntervalMs);
  return bucket ? bucket.timer !== null && bucket.stores.has(store) : false;
}

/** Test-only count of distinct interval-equivalent scheduler buckets. */
export function pollBucketCountForTests(): number {
  return pollBuckets.size;
}
