import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createIsolatedTestEnvironment,
  deterministicTestBatches,
  FULL_SUITE_TEST_TIMEOUT_MS,
  discoverTestFiles,
  shouldBatchFullSuite,
  WINDOWS_BUN_BATCH_SIZE,
  WINDOWS_BUN_PARALLELISM,
} from "../scripts/test";

describe("test runner isolation", () => {
  test("redirects user homes to a disposable root", () => {
    const isolated = createIsolatedTestEnvironment({ PATH: "/test/bin", HOME: "/real/home" });
    try {
      expect(isolated.env).toMatchObject({
        PATH: "/test/bin",
        HOME: isolated.root,
        USERPROFILE: isolated.root,
        OPENCODEX_HOME: join(isolated.root, ".opencodex"),
        CODEX_HOME: join(isolated.root, ".codex"),
      });
      expect(existsSync(isolated.env.OPENCODEX_HOME!)).toBe(true);
      expect(existsSync(isolated.env.CODEX_HOME!)).toBe(true);
    } finally {
      isolated.cleanup();
    }
    expect(existsSync(isolated.root)).toBe(false);
  });
});

describe("Windows Bun full-suite batching", () => {
  test("full-suite cases have headroom above Bun's 5 second default", () => {
    expect(FULL_SUITE_TEST_TIMEOUT_MS).toBe(15_000);
  });

  test("covers the legacy and bundled Windows runtimes only for a full suite", () => {
    expect(shouldBatchFullSuite("win32", "1.3.14", [])).toBe(true);
    expect(shouldBatchFullSuite("win32", "1.3.14+canary.1", [])).toBe(true);
    expect(shouldBatchFullSuite("win32", "1.4.0", [])).toBe(true);
    expect(shouldBatchFullSuite("win32", "1.4.0+34cbb9a40", [])).toBe(true);
    expect(shouldBatchFullSuite("win32", "1.4.1", [])).toBe(false);
    expect(shouldBatchFullSuite("linux", "1.3.14", [])).toBe(false);
    expect(shouldBatchFullSuite("win32", "1.3.14", ["tests/test-runner.test.ts"])).toBe(false);
  });

  test("sorts every file exactly once into bounded deterministic batches", () => {
    const batches = deterministicTestBatches(["tests/c.test.ts", "tests/a.test.ts", "tests/b.test.ts"], 2);
    expect(batches).toEqual([
      ["tests/a.test.ts", "tests/b.test.ts"],
      ["tests/c.test.ts"],
    ]);
    expect(() => deterministicTestBatches(["tests/a.test.ts", "tests/a.test.ts"], 2))
      .toThrow("duplicate files");
    expect(() => deterministicTestBatches(["tests/a.test.ts"], 0))
      .toThrow("positive integer");
  });

  test("discovers the repository suite without omissions or duplicates", () => {
    const files = discoverTestFiles(process.cwd());
    expect(files).toContain("tests/test-runner.test.ts");
    expect(files).toContain("tests/e2e-style/phase100-native-parity.test.ts");
    expect(files).toEqual([...files].sort((a, b) => a.localeCompare(b, "en")));
    expect(new Set(files).size).toBe(files.length);
    const batches = deterministicTestBatches(files);
    expect(batches.flat()).toEqual(files);
    expect(batches.every(batch => batch.length <= WINDOWS_BUN_BATCH_SIZE)).toBe(true);
    expect(WINDOWS_BUN_PARALLELISM).toBe(2);
  });
});
