#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
    "Usage: ocx-notch [--help] [--version]\n\n"
    + "Launch the bundled Windows x64 Notch companion. The desktop application accepts no CLI options.",
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

const child = spawn(nativeBinary, process.argv.slice(2), {
  detached: true,
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
