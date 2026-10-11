import { closeSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { claudeConfigDir } from "./auth-detect";
import { hardenSecretPath } from "../lib/windows-secret-acl";

/** Shared Desktop settings/profile transaction lease; crash release never depends on a stale PID. */
export async function withDesktopLifecycle<T>(work: () => Promise<T>, target = claudeConfigDir(process.env)): Promise<T> {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const directory = lstatSync(target, { bigint: true });
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("desktop_lifecycle_unsafe");
  const path = join(target, ".ocx-desktop-lifecycle.sqlite");
  let fd: number | undefined;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("desktop_lifecycle_unavailable"); }
  if (fd !== undefined) {
    try {
      const entry = fstatSync(fd, { bigint: true });
      if (!entry.isFile() || entry.nlink !== 1n) throw new Error("desktop_lifecycle_unsafe");
      hardenSecretPath(path, { required: true });
    } finally { closeSync(fd); }
  }
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isFile() || entry.nlink !== 1n) throw new Error("desktop_lifecycle_unsafe");
  const db = new Database(path);
  let locked = false;
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    locked = true;
    const current = lstatSync(path, { bigint: true });
    if (current.dev !== entry.dev || current.ino !== entry.ino) throw new Error("desktop_lifecycle_unsafe");
    return await work();
  } catch (error) {
    if (!locked) throw new Error("desktop_lifecycle_busy");
    throw error;
  } finally {
    try { if (locked) db.exec("ROLLBACK"); } finally { db.close(); }
  }
}
