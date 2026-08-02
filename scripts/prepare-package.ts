import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stageNotchBinary } from "./notch-package";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function chmodIfExists(path: string, mode: number): void {
  if (!existsSync(path)) return;
  try { chmodSync(path, mode); } catch { /* best-effort for read-only filesystems */ }
}

function chmodTree(path: string): void {
  if (!existsSync(path)) return;
  const st = statSync(path);
  if (st.isDirectory()) {
    chmodIfExists(path, 0o755);
    for (const entry of readdirSync(path)) chmodTree(join(path, entry));
    return;
  }
  chmodIfExists(path, 0o644);
}

const notch = stageNotchBinary(root);

chmodIfExists(join(root, "bin", "ocx.mjs"), 0o755);
chmodIfExists(join(root, "bin", "ocx-notch.mjs"), 0o755);
chmodIfExists(join(root, "bin", "package-main.mjs"), 0o644);
chmodIfExists(notch.path, 0o755);
chmodTree(join(root, "gui", "dist"));

console.error(
  `[package] ocx-notch ${relative(root, notch.path)} ${notch.size} bytes sha256=${notch.sha256}`,
);
