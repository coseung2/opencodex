/**
 * Resolve the effective Windows token to the locale-independent SID form that
 * icacls accepts ("*S-1-..."). Environment values such as USERDOMAIN are not
 * an authority for the current token: on workgroup machines USERDOMAIN may be
 * the literal WORKGROUP even though the account belongs to the local computer.
 *
 * There is deliberately NO name-shaped fallback. A `DOMAIN\User` string has a
 * valid shape, but shape is not evidence that the account is the current
 * token's subject, and both environment variables are writable by whatever
 * launched us. A wrong principal here is not cosmetic: ACL hardening grants it
 * Full Control and then removes inheritance, so a wrong grant either leaves a
 * different account holding the secret or strands the file with no usable ACE.
 * When the SID cannot be resolved, the caller declines to touch the ACL at all.
 *
 * Budget caveat: callers pass their REMAINING harden budget, which becomes the
 * child process timeout. Trusted-executable resolution and spawn setup happen
 * before that timeout starts. Both are small in practice, but the lookup is
 * not bounded by the deadline to the microsecond.
 */

import { resolveTrustedWindowsPowerShellExe } from "./windows-elevation";

/**
 * Shared ceiling for a full effective-token identity lookup. PowerShell startup
 * can legitimately take several seconds on loaded desktops as well as CI.
 */
export const WINDOWS_PRINCIPAL_LOOKUP_TIMEOUT_MS = 30_000;

const SID_PATTERN = /^S-1-(?:\d+-)+\d+$/i;
const IDENTITY_EXPRESSION =
  "$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();$identity.User.Value;$identity.Name";

export interface WindowsPrincipalLookupResult {
  success: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Raw child stdout. The SID is ASCII; the account name is not used as an ACL principal. */
  stdout: string | Uint8Array;
}

export type WindowsPrincipalRunner = (timeoutMs: number) => WindowsPrincipalLookupResult;

const POWERSHELL_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  IDENTITY_EXPRESSION,
] as const;

function defaultWindowsPrincipalRunner(timeoutMs: number): WindowsPrincipalLookupResult {
  const result = Bun.spawnSync([resolveTrustedWindowsPowerShellExe(), ...POWERSHELL_ARGS], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: Math.max(1, timeoutMs),
    windowsHide: true,
  });
  return {
    success: result.success,
    exitCode: result.exitCode,
    timedOut: result.exitedDueToTimeout ?? false,
    stdout: result.stdout ?? new Uint8Array(),
  };
}

let principalRunner: WindowsPrincipalRunner = defaultWindowsPrincipalRunner;
let cachedSid: string | null = null;

function identityError(reason: string): NodeJS.ErrnoException {
  const error = new Error(`Windows effective-account SID lookup ${reason}`) as NodeJS.ErrnoException;
  // Distinct from icacls timeouts so a failed lookup cannot populate the ACL timeout memo.
  error.code = "EACLIDENTITY";
  return error;
}

function sidFromResult(result: WindowsPrincipalLookupResult): string {
  if (!result.success) {
    throw identityError(result.timedOut ? "timed out" : `exited ${result.exitCode ?? "null"}`);
  }
  const text = typeof result.stdout === "string" ? result.stdout : new TextDecoder("utf-8", { fatal: false }).decode(result.stdout);
  const sid = text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (!SID_PATTERN.test(sid)) throw identityError(sid ? "returned an invalid SID" : "returned an empty SID");
  return sid.toUpperCase();
}

/**
 * Resolve and process-cache the effective token SID for synchronous ACL paths.
 * Returns the icacls form `*S-1-...`. An injected runner outranks any cache so a
 * test can force a lookup failure on a non-Windows host.
 */
export function resolveCurrentWindowsPrincipal(timeoutMs: number): string {
  if (principalRunner !== defaultWindowsPrincipalRunner) {
    if (cachedSid) return `*${cachedSid}`;
    if (timeoutMs <= 0) throw identityError("had no remaining deadline");
    let overridden: WindowsPrincipalLookupResult;
    try { overridden = principalRunner(timeoutMs); }
    catch { throw identityError("could not start"); }
    cachedSid = sidFromResult(overridden);
    return `*${cachedSid}`;
  }
  if (cachedSid) return `*${cachedSid}`;
  if (timeoutMs <= 0) throw identityError("had no remaining deadline");
  let result: WindowsPrincipalLookupResult;
  try { result = principalRunner(timeoutMs); }
  catch { throw identityError("could not start"); }
  cachedSid = sidFromResult(result);
  return `*${cachedSid}`;
}

/** Test seam: replace the sync resolver process and clear its successful cache. */
export function setWindowsPrincipalRunnerForTests(runner: WindowsPrincipalRunner | null): void {
  principalRunner = runner ?? defaultWindowsPrincipalRunner;
  cachedSid = null;
}

/** Test seam: clear only process-local principal state. */
export function resetWindowsPrincipalForTests(): void {
  cachedSid = null;
}
