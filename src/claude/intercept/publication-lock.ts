/**
 * Private publication lease for the Claude intercept CA.
 *
 * This is not the shared client/Desktop lifecycle lock. That lock binds a
 * process-wide namespace and depends on user-identity roots this module does
 * not own. The CA lease is scoped to an explicit lock file inside the CA
 * directory the caller already validated. SQLite releases it when the process
 * dies; a contending caller fails before touching either PEM. The lock file is
 * never unlinked and a stale PID is never treated as ownership.
 */
import { Database } from "bun:sqlite";

export interface LocalCaPublicationLockDeps { lockPath: string }

class LocalCaPublicationError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "LocalCaPublicationError";
  }
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

function acquire(lockPath: string): Database {
  let database: Database | undefined;
  try {
    database = new Database(lockPath, { create: true });
    database.exec("PRAGMA locking_mode = NORMAL; PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    return database;
  } catch (error) {
    try { database?.close(); } catch { /* preserve acquisition failure */ }
    const code = errorCode(error);
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
      || (error instanceof Error && /database (?:is|table is) locked/i.test(error.message))) {
      throw new LocalCaPublicationError("client_lifecycle_busy");
    }
    throw new LocalCaPublicationError("client_lifecycle_lock_failed", { cause: error });
  }
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function finish<T>(database: Database, outcome: Outcome<T>): T {
  let release: Outcome<void> = { ok: true, value: undefined };
  try { database.exec("ROLLBACK"); }
  catch (error) { release = { ok: false, error }; }
  try { database.close(); }
  catch (error) { if (release.ok) release = { ok: false, error }; }
  if (!outcome.ok) throw outcome.error;
  if (!release.ok) throw new LocalCaPublicationError("client_lifecycle_lock_failed", { cause: release.error });
  return outcome.value;
}

/** Hold the named lock for the duration of a synchronous callback. Promises are refused. */
export function withLocalCaPublicationLock<T>(work: () => T, deps: LocalCaPublicationLockDeps): T {
  const database = acquire(deps.lockPath);
  let outcome: Outcome<T>;
  try {
    const value = work();
    if (value !== null && (typeof value === "object" || typeof value === "function")
      && typeof (value as { then?: unknown }).then === "function") {
      if (value instanceof Promise) void Promise.prototype.then.call(value, undefined, () => undefined);
      throw new LocalCaPublicationError("client_lifecycle_async_callback");
    }
    outcome = { ok: true, value };
  } catch (error) { outcome = { ok: false, error }; }
  return finish(database, outcome);
}
