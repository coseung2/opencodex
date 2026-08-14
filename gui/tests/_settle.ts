/**
 * Wait up to `timeoutMs` for `assertion` to pass.
 *
 * The GUI suite drives React through happy-dom with `act()` and short flush
 * yields (`Promise.resolve()` / a single `setTimeout(0)` round). On a loaded CI
 * runner the event loop can delay the async state update past those yields, so
 * a one-shot assertion right after the flush is flaky even though the behavior
 * is correct. Polling until the expected DOM/state lands keeps the assertion
 * exact while removing the runner-speed dependency.
 */
export async function settleAssertion(assertion: () => void, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) throw lastError;
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  }
}
