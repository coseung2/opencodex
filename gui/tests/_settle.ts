import { act } from "react";

/**
 * Wait up to `timeoutMs` for `assertion` to pass, yielding INSIDE React's
 * `act()` on the test's happy-dom timer domain.
 *
 * The GUI suite drives React through happy-dom. React Scheduler 0.27 captures
 * the global `setImmediate` at module load and prefers it for scheduled
 * renders. A flush that only drains microtasks — or polls on the happy-dom
 * timer domain — never drains bun's `setImmediate` queue, so the render stays
 * un-flushed on a slow runner. Yielding inside `act()` on the same
 * `setImmediate` the scheduler captured lets the scheduled work land before
 * the assertion is retried.
 */
export async function settleAssertion(
  assertion: () => void,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) throw lastError;
      await act(async () => {
        // Drain the scheduler's own queue: microtasks first, then one
        // `setImmediate` turn (the domain React Scheduler captured).
        await new Promise<void>(resolve => setImmediate(resolve));
        await Promise.resolve();
      });
    }
  }
}
