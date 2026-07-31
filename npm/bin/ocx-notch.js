#!/usr/bin/env node

'use strict';

const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');

function fail(message) {
  console.error(`ocx-notch: ${message}`);
  process.exit(1);
}

if (process.platform !== 'win32') {
  fail(`unsupported operating system "${process.platform}"; @coseung2/ocx-notch supports Windows x64 only.`);
}

if (process.arch !== 'x64') {
  fail(`unsupported architecture "${process.arch}"; @coseung2/ocx-notch supports Windows x64 only.`);
}

const nativeBinary = join(__dirname, '..', 'vendor', 'win32-x64', 'ocx-notch.exe');

if (!existsSync(nativeBinary)) {
  fail(`native executable is missing at "${nativeBinary}"; reinstall @coseung2/ocx-notch.`);
}

const child = spawn(nativeBinary, process.argv.slice(2), {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});

child.once('error', (error) => {
  console.error(`ocx-notch: failed to launch the native executable: ${error.message}`);
  process.exitCode = 1;
});

child.unref();
