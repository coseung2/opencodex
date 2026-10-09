#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@coseung2/opencodex";
const NOTCH_VERSION = "0.1.1";
const here = dirname(fileURLToPath(import.meta.url));

function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function fail(message) {
  console.error(`ocx-notch: ${message}`);
  process.exit(1);
}

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(`ocx-notch ${NOTCH_VERSION} (bundled with ${PACKAGE_NAME} ${packageVersion()})`);
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: ocx-notch [--help] [--version] [--subagent-catalog] [--provider-quotas]\n\n"
    + "Launch the bundled Windows x64 Notch companion, or print the active OCX delegation catalog as JSON.",
  );
  process.exit(0);
}

if (process.platform !== "win32") {
  fail(
    `unsupported operating system "${process.platform}"; the ocx-notch command `
    + `included with ${PACKAGE_NAME} supports Windows x64 only.`,
  );
}

if (process.arch !== "x64") {
  fail(
    `unsupported architecture "${process.arch}"; the ocx-notch command `
    + `included with ${PACKAGE_NAME} supports Windows x64 only.`,
  );
}

const nativeBinary = join(
  here,
  "..",
  "vendor",
  "ocx-notch",
  "win32-x64",
  "ocx-notch.exe",
);

if (!existsSync(nativeBinary)) {
  fail(
    `native executable is missing at "${nativeBinary}"; reinstall ${PACKAGE_NAME}.`,
  );
}

if (process.argv.includes("--provider-quotas")) {
  if (process.argv.length !== 3) fail("--provider-quotas cannot be combined with other options.");
  const scratch = mkdtempSync(join(tmpdir(), "ocx-notch-quotas-"));
  let status = 0;
  try {
    const output = join(scratch, "quotas.json");
    const result = spawnSync(nativeBinary, ["--provider-quotas-output", output], {
      env: { ...process.env, OCX_PACKAGE_VERSION: packageVersion() },
      encoding: "utf8",
      windowsHide: true,
      timeout: 65_000,
    });
    if (result.error || result.status !== 0) throw new Error("Selected connection quota query failed");
    const quotas = JSON.parse(readFileSync(output, "utf8"));
    if (quotas.schemaVersion !== 1 || !Array.isArray(quotas.reports)) throw new Error("Invalid quota response");
    console.log(JSON.stringify(quotas));
  } catch {
    console.error("ocx-notch: could not read provider quotas on the selected connection");
    status = 1;
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      console.error("ocx-notch: could not remove quota query scratch directory");
      status = 1;
    }
  }
  process.exit(status);
}

if (process.argv.includes("--subagent-catalog")) {
  if (process.argv.length !== 3) fail("--subagent-catalog cannot be combined with other options.");
  const scratch = mkdtempSync(join(tmpdir(), "ocx-notch-catalog-"));
  const output = join(scratch, "catalog.json");
  let status = 0;
  try {
    const result = spawnSync(nativeBinary, ["--subagent-catalog-output", output], {
      env: { ...process.env, OCX_PACKAGE_VERSION: packageVersion() },
      encoding: "utf8",
      windowsHide: true,
      timeout: 35_000,
    });
    if (result.error) throw new Error(`could not query the delegation catalog: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || `catalog query exited with code ${result.status}.`);
    }
    const catalog = JSON.parse(readFileSync(output, "utf8"));
    console.log(JSON.stringify(catalog));
  } catch (error) {
    console.error(`ocx-notch: could not read the delegation catalog: ${error.message}`);
    status = 1;
  } finally {
    // Runs before the process exits, so no scratch directory survives the query.
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.error(`ocx-notch: could not remove the scratch directory ${scratch}: ${error.message}`);
      status = 1;
    }
  }
  process.exit(status);
}

const child = spawn(nativeBinary, process.argv.slice(2), {
  detached: true,
  env: {
    ...process.env,
    OCX_PACKAGE_VERSION: packageVersion(),
  },
  stdio: "ignore",
  windowsHide: true,
});

let settled = false;

child.once("error", error => {
  settled = true;
  console.error(`ocx-notch: failed to launch the native executable: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (settled) return;
  settled = true;
  if (!signal && code === 0) return;
  const reason = signal ? `signal ${signal}` : `exit code ${code}`;
  console.error(
    `ocx-notch: the native executable exited during startup (${reason}). `
    + "See \"%LOCALAPPDATA%\\OCX Notch\\ocx-notch.log\" for details.",
  );
  process.exitCode = code && code !== 0 ? code : 1;
});

child.once("spawn", () => {
  setTimeout(() => {
    if (settled) return;
    settled = true;
    child.removeAllListeners("exit");
    child.unref();
  }, 1500);
});
