import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

export const WINDOWS_BUN_BATCH_SIZE = 48;
export const WINDOWS_BUN_PARALLELISM = 2;

// Keep fresh-process batching for the bundled 1.4.0 Windows runtime. A measured
// unbatched run remained active past ten minutes and reached ~1.97 GiB private
// memory, while the bounded 48-file path is the established release gate.
export function shouldBatchFullSuite(
  platform: NodeJS.Platform,
  bunVersion: string,
  requestedTests: readonly string[],
): boolean {
  return platform === "win32"
    && /^(?:1\.3\.14|1\.4\.0)(?:$|[-+])/.test(bunVersion)
    && requestedTests.length === 0;
}

export function deterministicTestBatches(
  files: readonly string[],
  batchSize = WINDOWS_BUN_BATCH_SIZE,
): string[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`test batch size must be a positive integer (got ${batchSize})`);
  }
  const sorted = [...files].sort((a, b) => a.localeCompare(b, "en"));
  if (new Set(sorted).size !== sorted.length) {
    throw new Error("test discovery produced duplicate files");
  }
  const batches: string[][] = [];
  for (let offset = 0; offset < sorted.length; offset += batchSize) {
    batches.push(sorted.slice(offset, offset + batchSize));
  }
  return batches;
}

export function discoverTestFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        files.push(relative(root, path).replaceAll("\\", "/"));
      }
    }
  };
  walk(join(root, "tests"));
  return deterministicTestBatches(files, Math.max(1, files.length)).flat();
}

export interface IsolatedTestEnvironment {
  root: string;
  env: Record<string, string | undefined>;
  cleanup(): void;
}

export function createIsolatedTestEnvironment(
  baseEnv: Record<string, string | undefined> = process.env,
): IsolatedTestEnvironment {
  const root = mkdtempSync(join(tmpdir(), "opencodex-test-"));
  const opencodexHome = join(root, ".opencodex");
  const codexHome = join(root, ".codex");
  mkdirSync(opencodexHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  return {
    root,
    env: {
      ...baseEnv,
      // Captured BEFORE HOME is overwritten: once the child starts with a rewritten
      // HOME, `homedir()` returns the sandbox, so this hand-off is the only way the
      // real-home write guard can still know which path to protect.
      // (devlog 260730_codex_rs_upstream_v2_live_handoff/070.)
      OCX_REAL_HOME: baseEnv.OCX_REAL_HOME ?? homedir(),
      HOME: root,
      USERPROFILE: root,
      OPENCODEX_HOME: opencodexHome,
      CODEX_HOME: codexHome,
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Other `bun test` runners already on this machine.
 *
 * Two full suites sharing one CPU do not fail — they crawl. A run that normally
 * finishes in about 210s took 26 minutes against a runner an earlier session had
 * left behind, and neither process said anything, so the slowdown read as a hang
 * in this suite. Bun's own timeouts cannot see the contention, so name it here.
 *
 * `pgrep` is absent on Windows and may exit non-zero for "no matches"; both cases
 * mean "nothing to warn about" rather than an error worth failing a test run over.
 */
function findCompetingTestRunners(selfPid: number): number[] {
  try {
    const found = Bun.spawnSync(["pgrep", "-f", "bun.*test --isolate"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!found.success) return [];
    return new TextDecoder().decode(found.stdout)
      .split("\n")
      .map(line => Number.parseInt(line.trim(), 10))
      .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== selfPid);
  } catch {
    return [];
  }
}

/**
 * Wait until this machine has no other full-suite runner, then proceed.
 *
 * Warning about contention was not enough: the warning scrolls past, the run still
 * starts, and four concurrent suites drove load average to 10 and turned a ~210s
 * suite into a 13-minute one that read as a hang. Agents in parallel worktrees each
 * think they are the only runner, so the serialization has to live here rather than
 * in anyone's discipline.
 *
 * Queue rather than refuse: a failed `bun run test` invites `bun test` directly,
 * which bypasses this file entirely. Waiting is the behavior that survives being
 * worked around. `OCX_TEST_NO_QUEUE=1` opts out for anyone who really wants overlap.
 */
async function waitForExclusiveRun(selfPid: number): Promise<void> {
  if (process.env.OCX_TEST_NO_QUEUE === "1") return;
  const pollMs = 5_000;
  // Long enough for a full suite plus slack; past this, assume the holder is wedged
  // rather than working and let this run start anyway.
  const maxWaitMs = 45 * 60 * 1000;
  const startedAt = Date.now();
  let announced = false;
  for (;;) {
    const competing = findCompetingTestRunners(selfPid);
    if (competing.length === 0) {
      if (announced) {
        console.warn(`[test] the other runner(s) finished after ${Math.round((Date.now() - startedAt) / 1000)}s; starting.`);
      }
      return;
    }
    if (Date.now() - startedAt > maxWaitMs) {
      console.warn(
        `[test] still waiting on pid ${competing.join(", ")} after ${Math.round(maxWaitMs / 60000)} minutes. `
        + "Assuming they are stuck and starting anyway; expect a slow run.",
      );
      return;
    }
    if (!announced) {
      announced = true;
      console.warn(
        `[test] ${competing.length} other bun test runner(s) already running (pid ${competing.join(", ")}). `
        + "Waiting for them to finish so the suites do not fight over the CPU. "
        + "Set OCX_TEST_NO_QUEUE=1 to run concurrently anyway.",
      );
    }
    await Bun.sleep(pollMs);
  }
}

if (import.meta.main) {
  const isolated = createIsolatedTestEnvironment();
  try {
    const requestedTests = process.argv.slice(2);
    await waitForExclusiveRun(process.pid);
    const startedAt = Date.now();
    let exitCode = 1;
    if (shouldBatchFullSuite(process.platform, Bun.version, requestedTests)) {
      const files = discoverTestFiles(process.cwd());
      const batches = deterministicTestBatches(files);
      if (batches.length === 0) throw new Error("no test files discovered under tests/");
      console.warn(
        `[test] Windows Bun ${Bun.version}: running ${files.length} files in ${batches.length} `
        + `fresh batches (max ${WINDOWS_BUN_BATCH_SIZE} files, `
        + `parallel=${WINDOWS_BUN_PARALLELISM}) to bound native runner memory.`,
      );
      exitCode = 0;
      for (const [index, batch] of batches.entries()) {
        console.warn(
          `[test] batch ${index + 1}/${batches.length}: ${batch.length} files `
          + `(${batch[0]} .. ${batch.at(-1)})`,
        );
        const child = Bun.spawnSync(
          [
            process.execPath,
            "test",
            "--isolate",
            `--parallel=${WINDOWS_BUN_PARALLELISM}`,
            ...batch,
          ],
          {
            env: isolated.env,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          },
        );
        if ((child.exitCode ?? 1) !== 0) {
          exitCode = child.exitCode ?? 1;
          console.error(`[test] batch ${index + 1}/${batches.length} failed; stopping.`);
          break;
        }
      }
    } else {
      const child = Bun.spawnSync(
        [process.execPath, "test", "--isolate", ...(requestedTests.length > 0 ? requestedTests : ["./tests/"])],
        {
          env: isolated.env,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      exitCode = child.exitCode ?? 1;
    }
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (requestedTests.length === 0 && elapsedSeconds > 600) {
      console.warn(
        `[test] the suite took ${elapsedSeconds}s; it normally runs in about 210s on an idle machine. `
        + "Check for another test runner, a busy CPU, or a test that started polling something real.",
      );
    }
    process.exitCode = exitCode;
  } finally {
    isolated.cleanup();
  }
}
