/** Shared visibility-aware scheduler for raw dashboard pollers. */

export type VisibilityPollOptions = {
  /** Hidden tabs own no timer by default. */
  pauseWhenHidden?: boolean;
  /** Fire once during setup. Defaults to false. */
  immediate?: boolean;
};

function hiddenNow(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function scheduleInterval(
  callback: () => void,
  intervalMs: number,
): ReturnType<typeof setInterval> {
  if (typeof window !== "undefined" && typeof window.setInterval === "function") {
    return window.setInterval(callback, intervalMs) as unknown as ReturnType<typeof setInterval>;
  }
  return setInterval(callback, intervalMs);
}

function cancelInterval(timer: ReturnType<typeof setInterval>): void {
  if (typeof window !== "undefined" && typeof window.clearInterval === "function") {
    window.clearInterval(timer as unknown as number);
    return;
  }
  clearInterval(timer);
}

/**
 * Start a cadence that is fully disarmed while hidden, then make up one tick on return.
 * The callback guard keeps a synchronous exception from preventing the cadence re-arm.
 */
export function startVisibilityPoll(
  callback: () => void,
  intervalMs: number,
  options?: VisibilityPollOptions,
): () => void {
  const pauseWhenHidden = options?.pauseWhenHidden !== false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const tick = () => {
    try {
      callback();
    } catch (error) {
      console.error("[visibility-poll]", error);
    }
  };
  const arm = () => {
    if (timer !== null || stopped) return;
    timer = scheduleInterval(tick, intervalMs);
  };
  const disarm = () => {
    if (timer === null) return;
    cancelInterval(timer);
    timer = null;
  };
  const onVisibility = () => {
    if (!pauseWhenHidden) return;
    if (hiddenNow()) {
      disarm();
      return;
    }
    tick();
    arm();
  };

  if (!(pauseWhenHidden && hiddenNow())) arm();
  if (pauseWhenHidden && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
  if (options?.immediate) tick();

  return () => {
    stopped = true;
    disarm();
    if (pauseWhenHidden && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}
