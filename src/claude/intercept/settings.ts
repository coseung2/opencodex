// Adapted from lidge-jun/opencodex d17a9f2239031df31d978f1419f326142c00d88b.
// Settings ownership only; no listener, certificate, catalog or process-env mutation.
import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../../config";
import { claudeConfigDir } from "../auth-detect";
import { hardenSecretPath } from "../../lib/windows-secret-acl";

export const CLAUDE_INTERCEPT_MANAGED_ENV = ["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"] as const;
export type ClaudeInterceptManagedEnv = typeof CLAUDE_INTERCEPT_MANAGED_ENV[number];
export interface ClaudeInterceptEnv { HTTPS_PROXY: string; NODE_EXTRA_CA_CERTS: string }
/** Explicit target required: never implicitly reads the user's home/process environment. */
export type ClaudeSettingsTarget = string | NodeJS.ProcessEnv;
export const CLAUDE_SETTINGS_MAX_BYTES = 1024 * 1024;
export type ClaudeInterceptSettingsState =
  | { kind: "absent" }
  | { kind: "applied"; env: ClaudeInterceptEnv }
  | { kind: "stale"; env: Partial<ClaudeInterceptEnv> }
  | { kind: "foreign"; env: Partial<Record<ClaudeInterceptManagedEnv, string>> }
  | { kind: "unreadable"; path: string };
export type ClaudeInterceptSettingsWrite =
  | { ok: true; changed: boolean; path: string }
  | { ok: false; reason: "unreadable" | "foreign_env" | "concurrent_update" | "write_failed"; path: string };
type Doc = Record<string, unknown>;
type Snapshot = { doc: Doc; raw: string | null; identity?: BigIntStats };
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const record = (value: unknown): value is Doc => !!value && typeof value === "object" && !Array.isArray(value);
export function claudeInterceptSettingsPath(target: ClaudeSettingsTarget): string {
  if (typeof target === "string") {
    if (!target.trim()) throw new Error("Explicit Claude settings target required");
    return join(target, "settings.json");
  }
  if (!target.CLAUDE_CONFIG_DIR?.trim() && !target.HOME?.trim() && !target.USERPROFILE?.trim()) {
    throw new Error("Explicit Claude settings home required");
  }
  return join(claudeConfigDir(target), "settings.json");
}
export function claudeInterceptProxyUrl(port: number, authToken: string): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !authToken) throw new Error("Invalid intercept proxy parameters");
  return `http://opencodex:${encodeURIComponent(authToken)}@127.0.0.1:${port}`;
}
export function buildClaudeInterceptEnv(port: number, caCertPath: string, authToken: string): ClaudeInterceptEnv {
  if (!caCertPath.trim()) throw new Error("Invalid intercept CA path");
  return { HTTPS_PROXY: claudeInterceptProxyUrl(port, authToken), NODE_EXTRA_CA_CERTS: caCertPath };
}
export function isClaudeInterceptProxyUrl(value: unknown): value is string {
  return typeof value === "string" && /^http:\/\/(?:opencodex:[^@/]+@)?127\.0\.0\.1:\d{1,5}\/?$/.test(value);
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.nlink === 1n && b.nlink === 1n;
}
function safeParents(path: string): boolean {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    try { const stat = lstatSync(parent); if (!stat.isDirectory() || stat.isSymbolicLink()) return false; }
    catch (error) { if (!missing(error)) return false; }
    if (dirname(parent) === parent) return true;
  }
}
function readSettings(path: string): Snapshot | null {
  let fd: number | undefined, observed = false;
  try {
    if (!safeParents(path)) return null;
    const before = lstatSync(path, { bigint: true });
    observed = true;
    if (!before.isFile() || before.nlink !== 1n) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!sameFile(before, opened) || !sameFile(opened, lstatSync(path, { bigint: true }))) return null;
    if (opened.size > BigInt(CLAUDE_SETTINGS_MAX_BYTES)) return null;
    const bytes = Buffer.alloc(CLAUDE_SETTINGS_MAX_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const count = readSync(fd, bytes, total, bytes.length - total, null);
      if (!count) break;
      total += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (total > CLAUDE_SETTINGS_MAX_BYTES || !sameFile(opened, after)
      || opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs
      || !sameFile(after, lstatSync(path, { bigint: true })) || !safeParents(path)) return null;
    const raw = bytes.subarray(0, total).toString("utf8");
    const doc: unknown = JSON.parse(raw);
    if (!record(doc) || (Object.hasOwn(doc, "env") && !record(doc.env))) return null;
    return { doc, raw, identity: after };
  } catch (error) { return !observed && missing(error) ? { doc: {}, raw: null } : null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  if (a.raw !== b.raw) return false;
  if (!a.identity || !b.identity) return !a.identity && !b.identity;
  return sameFile(a.identity, b.identity) && a.identity.mtimeNs === b.identity.mtimeNs && a.identity.ctimeNs === b.identity.ctimeNs;
}
function envRecord(doc: Doc): Doc { return record(doc.env) ? doc.env : {}; }
function classify(snapshot: Snapshot, expected: ClaudeInterceptEnv): ClaudeInterceptSettingsState {
  const env = envRecord(snapshot.doc);
  const proxy = env.HTTPS_PROXY, ca = env.NODE_EXTRA_CA_CERTS;
  if (!Object.hasOwn(env, "HTTPS_PROXY") && !Object.hasOwn(env, "NODE_EXTRA_CA_CERTS")) return { kind: "absent" };
  if (proxy === expected.HTTPS_PROXY && ca === expected.NODE_EXTRA_CA_CERTS) return { kind: "applied", env: { ...expected } };
  const owned = ca === expected.NODE_EXTRA_CA_CERTS && (!Object.hasOwn(env, "HTTPS_PROXY") || isClaudeInterceptProxyUrl(proxy));
  return { kind: owned ? "stale" : "foreign", env: {
    ...(typeof proxy === "string" ? { HTTPS_PROXY: proxy } : {}),
    ...(typeof ca === "string" ? { NODE_EXTRA_CA_CERTS: ca } : {}),
  } };
}
/** env values are operational data and may contain credentials; never log this result. */
export function inspectClaudeInterceptSettings(expected: ClaudeInterceptEnv, target: ClaudeSettingsTarget): ClaudeInterceptSettingsState {
  const path = claudeInterceptSettingsPath(target), snapshot = readSettings(path);
  return snapshot ? classify(snapshot, expected) : { kind: "unreadable", path };
}
function mutate(target: ClaudeSettingsTarget, change: (snapshot: Snapshot) => ClaudeInterceptSettingsWrite): ClaudeInterceptSettingsWrite {
  const path = claudeInterceptSettingsPath(target), lock = `${path}.ocx-intercept.lock`;
  let fd: number | undefined, lockIdentity: BigIntStats | undefined;
  try {
    if (!safeParents(path)) return { ok: false, reason: "unreadable", path };
    mkdirSync(dirname(path), { recursive: true });
    try { fd = openSync(lock, "wx", 0o600); }
    catch (error) { return { ok: false, reason: (error as NodeJS.ErrnoException).code === "EEXIST" ? "concurrent_update" : "write_failed", path }; }
    lockIdentity = fstatSync(fd, { bigint: true });
    if (!sameFile(lockIdentity, lstatSync(lock, { bigint: true })) || !safeParents(path)) return { ok: false, reason: "concurrent_update", path };
    const snapshot = readSettings(path);
    if (!snapshot) return { ok: false, reason: "unreadable", path };
    return change(snapshot);
  } catch { return { ok: false, reason: "write_failed", path }; }
  finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* No credentials are stored in the lock. */ }
      try {
        if (lockIdentity && safeParents(lock) && sameFile(lockIdentity, lstatSync(lock, { bigint: true }))) unlinkSync(lock);
      } catch { /* A residual or substituted lock conservatively blocks later writes. */ }
    }
  }
}
function writeChanged(path: string, snapshot: Snapshot): ClaudeInterceptSettingsWrite {
  const content = `${JSON.stringify(snapshot.doc, null, 2)}\n`;
  if (Buffer.byteLength(content) > CLAUDE_SETTINGS_MAX_BYTES) return { ok: false, reason: "unreadable", path };
  // A cooperating writer is serialized by the lock; a newer external edit is never replayed over.
  const current = readSettings(path);
  if (!current || !sameSnapshot(current, snapshot)) return { ok: false, reason: "concurrent_update", path };
  let tempFd: number | undefined, tempIdentity: BigIntStats | undefined;
  const pinnedTemp = (temp: string) => {
    if (tempFd === undefined || !tempIdentity || !safeParents(temp)
      || !sameFile(tempIdentity, fstatSync(tempFd, { bigint: true }))
      || !sameFile(tempIdentity, lstatSync(temp, { bigint: true }))) throw new Error("Settings publication conflict");
  };
  try {
    atomicWriteFile(path, content, {
      write: (temp, value) => {
        // Never open an existing predictable temporary path, including cleanup fallback.
        if (tempFd !== undefined) throw new Error("Settings temporary file already opened");
        tempFd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        tempIdentity = fstatSync(tempFd, { bigint: true });
        pinnedTemp(temp);
        writeFileSync(tempFd, value, "utf8");
      },
      harden: temp => {
        pinnedTemp(temp);
        fchmodSync(tempFd!, 0o600);
        if (process.platform === "win32") hardenSecretPath(temp, { required: true });
        pinnedTemp(temp);
      },
      rename: (temp, destination) => {
        pinnedTemp(temp);
        const latest = readSettings(destination);
        if (!latest || !sameSnapshot(latest, snapshot)) throw new Error("Settings publication conflict");
        // Windows rename requires the descriptor closed. Path identity remains checked.
        closeSync(tempFd!); tempFd = undefined;
        if (!tempIdentity || !sameFile(tempIdentity, lstatSync(temp, { bigint: true })) || !safeParents(destination)) throw new Error("Settings publication conflict");
        renameSync(temp, destination);
      },
      truncate: temp => { pinnedTemp(temp); ftruncateSync(tempFd!, 0); },
      unlink: temp => {
        if (!tempIdentity || !safeParents(temp) || !sameFile(tempIdentity, lstatSync(temp, { bigint: true }))) throw new Error("Settings temporary ownership conflict");
        if (tempFd !== undefined) { closeSync(tempFd); tempFd = undefined; }
        unlinkSync(temp);
      },
    });
  } finally { if (tempFd !== undefined) closeSync(tempFd); }
  return { ok: true, changed: true, path };
}
function apply(expected: ClaudeInterceptEnv, target: ClaudeSettingsTarget, onlyStale: boolean): ClaudeInterceptSettingsWrite {
  const path = claudeInterceptSettingsPath(target);
  return mutate(target, snapshot => {
    const state = classify(snapshot, expected);
    if (state.kind === "foreign") return { ok: false, reason: "foreign_env", path };
    if (state.kind === "applied" || (onlyStale && state.kind !== "stale")) return { ok: true, changed: false, path };
    snapshot.doc.env = { ...envRecord(snapshot.doc), ...expected };
    return writeChanged(path, snapshot);
  });
}
export function applyClaudeInterceptSettings(env: ClaudeInterceptEnv, target: ClaudeSettingsTarget): ClaudeInterceptSettingsWrite {
  return apply(env, target, false);
}
export function migrateClaudeInterceptSettings(env: ClaudeInterceptEnv, target: ClaudeSettingsTarget): ClaudeInterceptSettingsWrite {
  return apply(env, target, true);
}
export function removeClaudeInterceptSettings(ownedCaPath: string, target: ClaudeSettingsTarget): ClaudeInterceptSettingsWrite {
  const path = claudeInterceptSettingsPath(target);
  return mutate(target, snapshot => {
    const env = envRecord(snapshot.doc);
    if (env.NODE_EXTRA_CA_CERTS !== ownedCaPath
      || (Object.hasOwn(env, "HTTPS_PROXY") && !isClaudeInterceptProxyUrl(env.HTTPS_PROXY))) return { ok: true, changed: false, path };
    delete env.NODE_EXTRA_CA_CERTS;
    if (isClaudeInterceptProxyUrl(env.HTTPS_PROXY)) delete env.HTTPS_PROXY;
    if (Object.keys(env).length) snapshot.doc.env = env;
    else delete snapshot.doc.env;
    return writeChanged(path, snapshot);
  });
}
/** Restore managed keys only, and only if BOTH still match this transaction's actual applied target. */
export function captureClaudeInterceptSettingsRollback(expected: ClaudeInterceptEnv | (() => ClaudeInterceptEnv), target: ClaudeSettingsTarget): () => boolean {
  const path = claudeInterceptSettingsPath(target), before = readSettings(path);
  if (!before) return () => false;
  const previous = { ...envRecord(before.doc) };
  let completed = false;
  return () => {
    if (completed) return false;
    try {
      const applied = typeof expected === "function" ? expected() : expected;
      const result = mutate(target, snapshot => {
        const env = envRecord(snapshot.doc);
        if (CLAUDE_INTERCEPT_MANAGED_ENV.some(key => env[key] !== applied[key])) return { ok: false, reason: "concurrent_update", path };
        for (const key of CLAUDE_INTERCEPT_MANAGED_ENV) {
          if (Object.hasOwn(previous, key)) env[key] = previous[key];
          else delete env[key];
        }
        if (Object.keys(env).length) snapshot.doc.env = env;
        else delete snapshot.doc.env;
        return writeChanged(path, snapshot);
      });
      completed = result.ok;
      return result.ok;
    } catch { return false; }
  };
}
