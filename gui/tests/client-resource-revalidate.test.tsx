import { afterEach, beforeEach, expect, test as bunTest } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests, useClientResource } from "../src/client-resource";
import { classifyDataSurface } from "../src/data-surface";

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

async function mountSeed(options: {
  key: string;
  load: () => Promise<string>;
  cachedAt: number | null;
}): Promise<Probe> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const probe: Probe = { current: null };

  function Page() {
    probe.current = useClientResource(options.key, options.load, {
      initialData: "seeded",
      initialDataCachedAt: options.cachedAt,
      staleAfterMs: 60_000,
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

test("a fresh revisit seed skips the redundant fetch", async () => {
  let fetches = 0;
  const probe = await mountSeed({
    key: `revalidate-fresh-${Date.now()}`,
    load: async () => { fetches += 1; return "live"; },
    cachedAt: Date.now() - 100,
  });

  expect(probe.current?.data).toBe("seeded");
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 80));
  });
  expect(fetches).toBe(0);
});

test("a stale revisit seed revalidates quietly with cached data visible", async () => {
  let release: ((value: string) => void) | null = null;
  const probe = await mountSeed({
    key: `revalidate-stale-${Date.now()}`,
    load: () => new Promise<string>((resolve) => { release = resolve; }),
    cachedAt: Date.now() - 120_000,
  });

  await waitFor(() => probe.current?.refreshing === true);
  const state = classifyDataSurface(probe.current!, () => false, true);
  expect(state.kind).toBe("loading-with-stale-data");
  expect(state.showSkeleton).toBe(false);
  expect(state.data).toBe("seeded");

  await act(async () => release?.("live"));
  await waitFor(() => probe.current?.data === "live");
});
