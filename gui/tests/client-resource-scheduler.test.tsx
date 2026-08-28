import { afterEach, beforeEach, expect, test as bunTest } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import {
  clearClientResourceStoresForTests,
  hasPollTimerForTests,
  pollBucketCountForTests,
  useClientResource,
} from "../src/client-resource";

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

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  });
  clearClientResourceStoresForTests();
  await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
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

async function setVisibility(state: "visible" | "hidden"): Promise<void> {
  Object.defineProperty(testWindow.document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  await act(async () => {
    testWindow.document.dispatchEvent(new testWindow.Event("visibilitychange"));
    await Promise.resolve();
  });
}

test("interval-equivalent resources share one scheduler bucket", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const stamp = Date.now();
  const calls = { a: 0, b: 0, c: 0 };

  function Page() {
    useClientResource(`sched-a-${stamp}`, async () => { calls.a += 1; return "a"; }, { pollMs: 35 });
    useClientResource(`sched-b-${stamp}`, async () => { calls.b += 1; return "b"; }, { pollMs: 35 });
    useClientResource(`sched-c-${stamp}`, async () => { calls.c += 1; return "c"; }, { pollMs: 35 });
    return null;
  }

  await act(async () => {
    const root = createRoot(container);
    mountedRoots.push(root);
    root.render(<Page />);
  });
  await waitFor(() => calls.a > 0 && calls.b > 0 && calls.c > 0);
  expect(pollBucketCountForTests()).toBe(1);

  const before = { ...calls };
  await waitFor(() => calls.a > before.a && calls.b > before.b && calls.c > before.c);
});

test("hidden resources own no timer and fire no requests until the make-up tick", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const key = `sched-hidden-${Date.now()}`;
  let calls = 0;

  function Page() {
    useClientResource(key, async () => { calls += 1; return calls; }, { pollMs: 30 });
    return null;
  }

  await act(async () => {
    const root = createRoot(container);
    mountedRoots.push(root);
    root.render(<Page />);
  });
  await waitFor(() => calls > 0);
  expect(hasPollTimerForTests(key)).toBe(true);

  await setVisibility("hidden");
  expect(hasPollTimerForTests(key)).toBe(false);
  const atHide = calls;
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 120));
  });
  expect(calls).toBe(atHide);

  await setVisibility("visible");
  await waitFor(() => hasPollTimerForTests(key) && calls > atHide);
});
