import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFileAsync } from "../src/config";
import { ResponseSnapshotWriter, responseSnapshotDebounceMs } from "../src/responses/snapshot-policy";
import {
  clearResponseStateMemoryForTests,
  expandPreviousResponseInput,
  flushResponseState,
  rememberResponseState,
  responseSnapshotMetricsForTests,
} from "../src/responses/state";

const priorHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-snapshot-amplification-"));
  process.env.OPENCODEX_HOME = home;
  clearResponseStateMemoryForTests();
});

afterEach(() => {
  clearResponseStateMemoryForTests();
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});

function writer(): ResponseSnapshotWriter {
  return new ResponseSnapshotWriter(async (path, payload) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dirname(path), 0o700);
    await atomicWriteFileAsync(path, payload);
  });
}

function remember(id: string, input: string): void {
  rememberResponseState(
    { model: "kiro/test", input, store: false },
    { id, status: "completed", output: [{ type: "message", role: "assistant", content: "done" }] },
    undefined,
    { force: true },
  );
}

describe("snapshot write policy", () => {
  test("identical flushes validate disk but perform only one atomic replacement", async () => {
    const memo = writer();
    const path = join(home, "state.json");
    const payload = JSON.stringify({ value: "stable" });
    for (let n = 0; n < 4; n++) await memo.persist(path, payload);
    expect(memo.metrics()).toMatchObject({ writes: 1, unchangedSkips: 3, bytesWritten: Buffer.byteLength(payload) });
    expect(readFileSync(path, "utf8")).toBe(payload);
  });

  test("same-size external edits and deletion are repaired rather than skipped", async () => {
    const memo = writer();
    const path = join(home, "state.json");
    await memo.persist(path, "first");
    writeFileSync(path, "other");
    await memo.persist(path, "first");
    expect(readFileSync(path, "utf8")).toBe("first");
    unlinkSync(path);
    await memo.persist(path, "first");
    expect(readFileSync(path, "utf8")).toBe("first");
    expect(memo.metrics()).toMatchObject({ writes: 3, unchangedSkips: 0 });
  });

  test("a different home never inherits a cached unchanged verdict", async () => {
    const memo = writer();
    const first = join(home, "one", "state.json");
    const second = join(home, "two", "state.json");
    await memo.persist(first, "same");
    await memo.persist(second, "same");
    expect(readFileSync(first, "utf8")).toBe("same");
    expect(readFileSync(second, "utf8")).toBe("same");
    expect(memo.metrics()).toMatchObject({ writes: 2, unchangedSkips: 0 });
  });

  test.skipIf(process.platform === "win32")("a symlink leaf is replaced even when its target has matching bytes", async () => {
    const memo = writer();
    const path = join(home, "state.json");
    const target = join(home, "other.json");
    await memo.persist(path, "same");
    writeFileSync(target, "same", { mode: 0o600 });
    unlinkSync(path);
    symlinkSync(target, path);
    await memo.persist(path, "same");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(memo.metrics().writes).toBe(2);
    expect(readFileSync(target, "utf8")).toBe("same");
  });

  test.skipIf(process.platform === "win32")("a retargeted parent is a miss even with an identical snapshot", async () => {
    const memo = writer();
    const one = join(home, "one");
    const two = join(home, "two");
    mkdirSync(one, { mode: 0o700 });
    mkdirSync(two, { mode: 0o700 });
    const link = join(home, "current");
    symlinkSync(one, link);
    const path = join(link, "state.json");
    await memo.persist(path, "same");
    writeFileSync(join(two, "state.json"), "same", { mode: 0o600 });
    unlinkSync(link);
    symlinkSync(two, link);
    await memo.persist(path, "same");
    expect(memo.metrics()).toMatchObject({ writes: 2, unchangedSkips: 0 });
  });

  test.skipIf(process.platform === "win32")("skipping cannot preserve relaxed file or directory permissions", async () => {
    const memo = writer();
    const directory = join(home, "state");
    const path = join(directory, "snapshot.json");
    await memo.persist(path, "same");
    chmodSync(path, 0o644);
    await memo.persist(path, "same");
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    chmodSync(directory, 0o755);
    await memo.persist(path, "same");
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(memo.metrics().writes).toBe(3);
  });

  test("failed persistence never publishes a new fingerprint", async () => {
    let fail = false;
    const memo = new ResponseSnapshotWriter(async (path, payload) => {
      if (fail) throw new Error("synthetic write failure");
      await atomicWriteFileAsync(path, payload);
    });
    const path = join(home, "state.json");
    await memo.persist(path, "old");
    fail = true;
    await expect(memo.persist(path, "new")).rejects.toThrow("synthetic write failure");
    expect(memo.metrics().writes).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("old");
    fail = false;
    await memo.persist(path, "new");
    expect(memo.metrics().writes).toBe(2);
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  test("debounce is based on UTF-8 bytes and has an explicit upper bound", async () => {
    expect(responseSnapshotDebounceMs(0)).toBe(2_000);
    expect(responseSnapshotDebounceMs(1024 * 1024)).toBe(2_000);
    expect(responseSnapshotDebounceMs(2 * 1024 * 1024)).toBe(4_000);
    expect(responseSnapshotDebounceMs(24 * 1024 * 1024)).toBe(30_000);
    expect(responseSnapshotDebounceMs(Number.NaN)).toBe(2_000);
    const memo = writer();
    const payload = "한".repeat(400_000);
    await memo.persist(join(home, "state.json"), payload);
    expect(memo.metrics().lastSnapshotBytes).toBe(1_200_000);
    expect(memo.metrics().debounceMs).toBeGreaterThan(2_000);
    memo.reset();
    expect(memo.metrics()).toMatchObject({ writes: 0, unchangedSkips: 0, lastSnapshotBytes: 0, debounceMs: 2_000 });
  });
});

describe("real response-state persistence", () => {
  test("unpersistable entries do not rewrite an unchanged selected snapshot", async () => {
    remember("small", "kept");
    await flushResponseState();
    const path = join(home, "responses-state.json");
    const before = readFileSync(path, "utf8");
    // Still resident below the RAM cap, but exceeds the separate per-entry snapshot bound.
    remember("large", "x".repeat(2 * 1024 * 1024));
    await flushResponseState();
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(responseSnapshotMetricsForTests()).toMatchObject({ writes: 1, unchangedSkips: 1 });
  });

  test("an identical selected snapshot is written to a newly selected home", async () => {
    remember("small", "kept");
    await flushResponseState();
    const next = join(home, "next-home");
    process.env.OPENCODEX_HOME = next;
    remember("large", "x".repeat(2 * 1024 * 1024));
    await flushResponseState();
    expect(JSON.parse(readFileSync(join(next, "responses-state.json"), "utf8")).states[0][0]).toBe("small");
    expect(responseSnapshotMetricsForTests().writes).toBe(2);
  });

  test("size-scaled debounce does not defer an explicit flush or lose restart replay", async () => {
    for (let n = 0; n < 3; n++) remember(`large-${n}`, "x".repeat(600_000));
    await flushResponseState();
    expect(responseSnapshotMetricsForTests().debounceMs).toBeGreaterThan(2_000);
    clearResponseStateMemoryForTests();
    const expanded = expandPreviousResponseInput({ previous_response_id: "large-2", input: "next" }) as { input: unknown[] };
    expect(expanded.input[0]).toEqual({ role: "user", content: "x".repeat(600_000) });
    expect(expanded.input.at(-1)).toEqual({ role: "user", content: "next" });
  });
});
