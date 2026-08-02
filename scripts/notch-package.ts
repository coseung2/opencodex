import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const NOTCH_SOURCE_RELATIVE = join(
  "packages",
  "ocx-notch",
  "target",
  "release",
  "ocx-notch.exe",
);
export const NOTCH_PACKAGE_RELATIVE = join(
  "vendor",
  "ocx-notch",
  "win32-x64",
  "ocx-notch.exe",
);

export type StagedNotchBinary = {
  path: string;
  sha256: string;
  size: number;
  copiedFromBuild: boolean;
};

export function sha256File(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function assertWindowsExecutable(path: string): number {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 32 * 1024) {
    throw new Error(
      `ocx-notch package asset is not a plausible release executable: ${path}`,
    );
  }
  const fd = openSync(path, "r");
  try {
    const signature = Buffer.alloc(2);
    const bytesRead = readSync(fd, signature, 0, signature.byteLength, 0);
    if (bytesRead !== 2 || signature.toString("ascii") !== "MZ") {
      throw new Error(`ocx-notch package asset is not a Windows PE executable: ${path}`);
    }
  } finally {
    closeSync(fd);
  }
  return stat.size;
}

/**
 * Stage the release-built Windows x64 Notch executable into the root package.
 *
 * A local Windows build is copied from Cargo's deterministic release path. CI
 * and release jobs may instead download the exact same artifact directly to
 * the destination before this function runs. Missing or malformed assets fail
 * closed so npm can never publish a launcher without its native executable.
 */
export function stageNotchBinary(root: string): StagedNotchBinary {
  const source = join(root, NOTCH_SOURCE_RELATIVE);
  const destination = join(root, NOTCH_PACKAGE_RELATIVE);
  let copiedFromBuild = false;

  if (existsSync(source)) {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    copiedFromBuild = true;
  }

  if (!existsSync(destination)) {
    throw new Error(
      `missing ocx-notch release executable; run "bun run build:notch" on Windows x64 `
      + `or place the CI artifact at ${NOTCH_PACKAGE_RELATIVE}`,
    );
  }

  const size = assertWindowsExecutable(destination);
  return {
    path: destination,
    sha256: sha256File(destination),
    size,
    copiedFromBuild,
  };
}
