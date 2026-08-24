import { afterEach, beforeEach, expect, test as bunTest } from "bun:test";
import { Window } from "happy-dom";
import { startVisibilityPoll } from "../src/visibility-poll";

function test(name: string, fn: () => void | Promise<void>): void {
  bunTest(name, fn, { timeout: 15_000 });
}

const globals = ["document", "window", "navigator"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map((key) => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(testWindow.document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  testWindow.document.dispatchEvent(new testWindow.Event("visibilitychange"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("hidden holds no poll cadence and fires no callback", async () => {
  let calls = 0;
  const stop = startVisibilityPoll(() => { calls += 1; }, 30);
  await sleep(75);
  const beforeHide = calls;
  expect(beforeHide).toBeGreaterThan(0);

  setVisibility("hidden");
  await sleep(120);
  expect(calls).toBe(beforeHide);
  stop();
});

test("visible again makes up once and resumes the cadence", async () => {
  let calls = 0;
  const stop = startVisibilityPoll(() => { calls += 1; }, 40);
  await sleep(50);
  setVisibility("hidden");
  await sleep(60);
  const atHide = calls;

  setVisibility("visible");
  await sleep(10);
  expect(calls).toBe(atHide + 1);
  await sleep(90);
  expect(calls).toBeGreaterThan(atHide + 1);
  stop();
});

test("mounting while hidden waits for visibility before any callback", async () => {
  setVisibility("hidden");
  let calls = 0;
  const stop = startVisibilityPoll(() => { calls += 1; }, 30);
  await sleep(100);
  expect(calls).toBe(0);

  setVisibility("visible");
  await sleep(10);
  expect(calls).toBe(1);
  stop();
});

test("pauseWhenHidden false is an explicit off-screen opt-out", async () => {
  let calls = 0;
  const stop = startVisibilityPoll(
    () => { calls += 1; },
    30,
    { pauseWhenHidden: false },
  );
  await sleep(40);
  setVisibility("hidden");
  const atHide = calls;
  await sleep(100);
  expect(calls).toBeGreaterThan(atHide);
  stop();
});
