import type { Window } from "happy-dom";
import { act } from "react";

/**
 * Wait up to `timeoutMs` for `assertion` to pass, yielding INSIDE React's
 * `act()` on the test's happy-dom timer domain.
 *
 * The GUI suite drives React through happy-dom. An async state update (for
 * example a fetch-mock rejection) is scheduled by React's scheduler, which in
 * this environment dispatches through the happy-dom event loop. A flush that
 * only drains the global microtask queue — or a poll running OUTSIDE act on
 * bun's global timers — can leave that scheduled render un-flushed on a loaded
 * runner. Polling inside act, yielding on the happy-dom timer each round, lets
 * the scheduled work actually land before the assertion is retried.
 */
export async function settleAssertion(
  assertion: () => void,
  testWindow: Window,
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
        await Promise.resolve();
        await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10));
        await Promise.resolve();
      });
    }
  }
}
