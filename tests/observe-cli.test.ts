import { afterEach, beforeEach, expect, test } from "bun:test";
import { handleObserveCommand } from "../src/cli/observe";

const originalLog = console.log;
let output: string[];

beforeEach(() => {
  output = [];
  console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  process.exitCode = 0;
});

function depsFor(body: unknown) {
  return {
    baseUrl: "http://127.0.0.1:1",
    fetchImpl: (async () => Response.json(body)) as typeof fetch,
  };
}

test("observe logs plain text prints server-provided output tok/s instead of duration", async () => {
  const rows = [
    {
      timestamp: "2026-08-30T00:00:00.000Z",
      provider: "anthropic",
      model: "claude-test",
      status: 200,
      durationMs: 9876,
      displayMetrics: { tokPerSecond: { kind: "value", value: 12.5, estimated: false } },
    },
    {
      timestamp: "2026-08-30T00:00:01.000Z",
      provider: "custom-provider",
      model: "custom-model",
      status: 200,
      durationMs: 1234,
      displayMetrics: { tokPerSecond: { kind: "value", value: 8, estimated: true } },
    },
    {
      timestamp: "2026-08-30T00:00:02.000Z",
      provider: "openai",
      model: "gpt-test",
      status: 200,
      durationMs: 500,
      displayMetrics: { tokPerSecond: { kind: "unavailable", reason: "output_missing" } },
    },
  ];

  expect(await handleObserveCommand(["logs"], depsFor(rows))).toBe(0);
  expect(output).toEqual([
    "2026-08-30T00:00:00.000Z  200  anthropic/claude-test  12.5 tok/s",
    "2026-08-30T00:00:01.000Z  200  custom-provider/custom-model  ~8 tok/s",
    "2026-08-30T00:00:02.000Z  200  openai/gpt-test  — tok/s",
  ]);
  expect(output.join("\n")).not.toContain("ms");
});

test("observe logs JSON and JSONL output remain unchanged", async () => {
  const rows = [{
    timestamp: "2026-08-30T00:00:00.000Z",
    provider: "openai",
    model: "gpt-test",
    status: 200,
    durationMs: 250,
    displayMetrics: { tokPerSecond: { kind: "value", value: 40, estimated: false } },
  }];

  expect(await handleObserveCommand(["logs", "--json"], depsFor(rows))).toBe(0);
  expect(output).toEqual([JSON.stringify(rows, null, 2)]);

  output.length = 0;
  expect(await handleObserveCommand(["logs", "--jsonl"], depsFor(rows))).toBe(0);
  expect(output).toEqual([JSON.stringify(rows[0])]);
});
