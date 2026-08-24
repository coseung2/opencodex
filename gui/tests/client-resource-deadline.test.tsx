import { afterEach, beforeEach, expect, test as bunTest } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests, useClientResource } from "../src/client-resource";

function test(name: string, fn: () => void | Promise<void>): void {
  bunTest(name, fn, { timeout: 15_000 });
}

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const mountedRoots: Root[] = [];

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(
    globals.map((key) => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 10));
    });
  }
}

type Probe = { current: ReturnType<typeof useClientResource<string>> | null };

async function mountResource(options: {
  key: string;
  load: (signal: AbortSignal) => Promise<string>;
  pollMs?: number;
  deadlineMs: number;
}): Promise<Probe> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const probe: Probe = { current: null };

  function Page() {
    probe.current = useClientResource(options.key, options.load, {
      pollMs: options.pollMs,
      deadlineMs: options.deadlineMs,
    });
    return null;
  }

  await act(async () => {
    const root = createRoot(container);
    mountedRoots.push(root);
    root.render(<Page />);
  });
  return probe;
}

test("a signal-dropping request settles failed at the resource deadline", async () => {
  const probe = await mountResource({
    key: `deadline-settle-${Date.now()}`,
    load: () => new Promise<string>(() => {}),
    deadlineMs: 50,
  });

  await waitFor(() => probe.current?.error instanceof Error);
  expect(probe.current?.loading).toBe(false);
  expect(probe.current?.refreshing).toBe(false);
  expect((probe.current?.error as Error).message).toContain("timed out");
});

test("a polling resource retries after a bounded request times out", async () => {
  let attempts = 0;
  const probe = await mountResource({
    key: `deadline-retry-${Date.now()}`,
    load: () => {
      attempts += 1;
      return attempts === 1 ? new Promise<string>(() => {}) : Promise.resolve("recovered");
    },
    pollMs: 35,
    deadlineMs: 45,
  });

  await waitFor(() => probe.current?.data === "recovered");
  expect(attempts).toBeGreaterThanOrEqual(2);
});
