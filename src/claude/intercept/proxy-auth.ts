import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, unlinkSync, writeFileSync, type BigIntStats,
} from "node:fs";
import { join } from "node:path";
import { forgetEphemeralSecretPath, hardenSecretDir, hardenSecretPath, windowsSecretAclApplies } from "../../lib/windows-secret-acl";
import { assertLocalCaWindowsAcl, localCaWindowsPrincipal } from "./local-ca-windows";

const TOKEN_FILE = "proxy-token";
const TOKEN_LENGTH = 43; // 32 random bytes encoded as unpadded base64url.
const TOKEN_MAX_BYTES = TOKEN_LENGTH + 2; // Optional LF or CRLF, never arbitrary whitespace.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

export function claudeInterceptProxyTokenPath(configDir: string): string {
  return join(configDir, "claude-intercept", TOKEN_FILE);
}

function invalidCredential(): Error {
  return new Error("Claude intercept credential is not a safe, valid owner-controlled file");
}

function assertOwnedNode(stat: BigIntStats, directory = false): void {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n)) throw invalidCredential();
  if (!windowsSecretAclApplies()) {
    if (typeof process.geteuid !== "function" || stat.uid !== BigInt(process.geteuid())) throw invalidCredential();
    const forbidden = directory ? 0o077 : 0o077;
    if ((Number(stat.mode) & forbidden) !== 0) throw invalidCredential();
  }
  if (stat.ino === 0n) throw invalidCredential();
}

function assertSameNode(path: string, expected: BigIntStats, directory = false): BigIntStats {
  const current = lstatSync(path, { bigint: true });
  assertOwnedNode(current, directory);
  if (current.dev !== expected.dev || current.ino !== expected.ino) throw invalidCredential();
  return current;
}

/** Read only through the validated descriptor, with a fixed maximum allocation and no links. */
function readPinnedToken(configDir: string, harden: boolean): string {
  const dir = join(configDir, "claude-intercept");
  const directory = lstatSync(dir, { bigint: true });
  assertOwnedNode(directory, true);
  if (windowsSecretAclApplies()) assertLocalCaWindowsAcl(dir, "private");
  const path = claudeInterceptProxyTokenPath(configDir);
  const entry = lstatSync(path, { bigint: true });
  assertOwnedNode(entry);
  if (windowsSecretAclApplies()) assertLocalCaWindowsAcl(path, "private");
  if (entry.size < BigInt(TOKEN_LENGTH) || entry.size > BigInt(TOKEN_MAX_BYTES)) throw invalidCredential();
  // NONBLOCK prevents a raced-in FIFO from blocking before fstat can reject it.
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    assertOwnedNode(opened);
    if (opened.dev !== entry.dev || opened.ino !== entry.ino
      || opened.size < BigInt(TOKEN_LENGTH) || opened.size > BigInt(TOKEN_MAX_BYTES)) throw invalidCredential();
    const bytes = Buffer.alloc(TOKEN_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const contents = bytes.subarray(0, length).toString("utf8");
    const token = contents.slice(0, TOKEN_LENGTH);
    const ending = contents.slice(TOKEN_LENGTH);
    if (token.length !== TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)
      || !["", "\n", "\r\n"].includes(ending)) throw invalidCredential();
    const afterRead = fstatSync(fd, { bigint: true });
    if (BigInt(length) !== afterRead.size || afterRead.mtimeNs !== opened.mtimeNs || afterRead.ctimeNs !== opened.ctimeNs) throw invalidCredential();
    assertSameNode(path, opened);
    assertSameNode(dir, directory, true);
    if (windowsSecretAclApplies()) {
      assertLocalCaWindowsAcl(path, "private");
      assertLocalCaWindowsAcl(dir, "private");
    }
    if (harden) {
      if (windowsSecretAclApplies()) hardenSecretPath(path, { required: true, principal: localCaWindowsPrincipal() });
      else fchmodSync(fd, 0o600); // Never chmod a followed/replaced pathname.
      assertSameNode(path, opened);
      assertSameNode(dir, directory, true);
    }
    return token;
  } finally {
    closeSync(fd);
  }
}

/** The current usable credential, or null. Inspection and CONNECT admission never create one. */
export function readClaudeInterceptProxyToken(configDir: string): string | null {
  try {
    return readPinnedToken(configDir, false);
  } catch {
    return null;
  }
}

function ensurePrivateDirectory(configDir: string): BigIntStats {
  const dir = join(configDir, "claude-intercept");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const entry = lstatSync(dir, { bigint: true });
  assertOwnedNode(entry, true);
  if (windowsSecretAclApplies()) {
    hardenSecretDir(dir, { required: true, principal: localCaWindowsPrincipal() });
  } else {
    const fd = openSync(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW);
    try {
      const opened = fstatSync(fd, { bigint: true });
      assertOwnedNode(opened, true);
      if (entry.dev !== opened.dev || entry.ino !== opened.ino) throw invalidCredential();
      fchmodSync(fd, 0o700);
    } finally {
      closeSync(fd);
    }
  }
  assertSameNode(dir, entry, true);
  return entry;
}

/** Create once without replacing a winner, invalid file, symlink, or other existing entry. */
export function ensureClaudeInterceptProxyToken(configDir: string): string {
  const dir = join(configDir, "claude-intercept");
  const directory = ensurePrivateDirectory(configDir);
  try {
    return readPinnedToken(configDir, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  assertSameNode(dir, directory, true);
  const path = claudeInterceptProxyTokenPath(configDir);
  const token = randomBytes(32).toString("base64url");
  const temp = join(dir, `.${TOKEN_FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | NONBLOCK, 0o600);
  const created = fstatSync(fd, { bigint: true });
  let published = false;
  let closeFailed = false;
  let committed = "";
  try {
    assertOwnedNode(created);
    writeFileSync(fd, `${token}\n`, { encoding: "utf8" });
    if (!windowsSecretAclApplies()) fchmodSync(fd, 0o600);
    else hardenSecretPath(temp, { required: true, timeoutMemoKey: path, principal: localCaWindowsPrincipal() });
    assertSameNode(temp, created);
    assertSameNode(dir, directory, true);
    try {
      linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A concurrent winner is validated below. No rename/overwrite fallback is safe here.
    }
    // linkSync makes nlink 2 until this stage name is gone. Identity is checked
    // without the single-link rule; admission below still requires nlink 1.
    try { closeSync(fd); fd = -1; }
    catch { closeFailed = true; fd = -1; }
    published = true;
    try {
      const staged = lstatSync(temp, { bigint: true });
      if (staged.isSymbolicLink() || !staged.isFile()
        || staged.dev !== created.dev || staged.ino !== created.ino || staged.ino === 0n) throw invalidCredential();
      unlinkSync(temp);
      forgetEphemeralSecretPath(temp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") forgetEphemeralSecretPath(temp);
      else {
        closeFailed = true;
        throw invalidCredential();
      }
    }
    committed = readPinnedToken(configDir, true);
  } finally {
    // Cleanup cannot turn a committed credential into a failed apply or hide the
    // original publication error. Returning from finally would discard it.
    // Do not retry close: its fd may already be reused.
    if (published) {
      if (closeFailed) {
        console.warn("[claude] Credential temporary cleanup incomplete; review retained temporary state.");
      }
    } else {
    let cleanupFailed = false;
    if (fd >= 0) {
      try { closeSync(fd); } catch { cleanupFailed = true; }
    }
    let removed = false;
    try {
      assertSameNode(temp, created);
      unlinkSync(temp);
      removed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") removed = true;
      else cleanupFailed = true;
    }
    if (removed) forgetEphemeralSecretPath(temp);
    if (cleanupFailed) {
      console.warn("[claude] Credential temporary cleanup incomplete; review retained temporary state.");
    }
    }
  }
  if (!committed) throw invalidCredential();
  return committed;
}
