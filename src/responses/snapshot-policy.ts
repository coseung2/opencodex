import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  forgetHardenedSecretPath,
  hardenSecretPathAsync,
  windowsSecretAclApplies,
} from "../lib/windows-secret-acl";

const BASE_DEBOUNCE_MS = 2_000;
const SCALE_FROM_BYTES = 1024 * 1024;
const MAX_DEBOUNCE_MS = 30_000;

/** Large snapshots trade a bounded hard-kill recovery window for fewer atomic replacements. */
export function responseSnapshotDebounceMs(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= SCALE_FROM_BYTES) return BASE_DEBOUNCE_MS;
  return Math.min(MAX_DEBOUNCE_MS, Math.round(BASE_DEBOUNCE_MS * bytes / SCALE_FROM_BYTES));
}

export interface ResponseSnapshotWriteMetrics {
  writes: number;
  unchangedSkips: number;
  bytesWritten: number;
  lastSnapshotBytes: number;
  debounceMs: number;
}

type SnapshotWrite = (path: string, payload: string) => Promise<void>;

/**
 * Memoize only a digest, size and resolved target, never another copy of the snapshot.
 * The state store owns the single-flight writer gate; this class does not queue writes.
 */
export class ResponseSnapshotWriter {
  private digest: string | null = null;
  private target: string | null = null;
  private bytes = 0;
  private writes = 0;
  private unchangedSkips = 0;
  private bytesWritten = 0;

  constructor(private readonly write: SnapshotWrite) {}

  metrics(): ResponseSnapshotWriteMetrics {
    return {
      writes: this.writes,
      unchangedSkips: this.unchangedSkips,
      bytesWritten: this.bytesWritten,
      lastSnapshotBytes: this.bytes,
      debounceMs: responseSnapshotDebounceMs(this.bytes),
    };
  }

  reset(): void {
    this.digest = null;
    this.target = null;
    this.bytes = 0;
    this.writes = 0;
    this.unchangedSkips = 0;
    this.bytesWritten = 0;
  }

  private async diskMatches(path: string, payload: string, bytes: number): Promise<boolean> {
    try {
      const before = lstatSync(path);
      // Atomic replacement would replace a symlink or break a hardlink. An optimization must
      // not silently preserve either, even if it currently resolves to identical bytes.
      if (!before.isFile() || before.nlink !== 1 || before.size !== bytes) return false;
      if (realpathSync(path) !== this.target) return false;
      if (!windowsSecretAclApplies()) {
        if ((before.mode & 0o777) !== 0o600) return false;
        if ((statSync(dirname(path)).mode & 0o777) !== 0o700) return false;
      } else {
        // An ordinary atomic write hardens a new temp. A skipped write must still use the
        // required publication policy, not a potentially stale pathname-only success memo.
        forgetHardenedSecretPath(path);
        try { await hardenSecretPathAsync(path, { required: true }); }
        finally { forgetHardenedSecretPath(path); }
      }
      // The digest records our last write, not the current disk contents. A same-size edit,
      // a second process or a deleted snapshot must never turn into a false cache hit.
      if (await Bun.file(path).text() !== payload) return false;
      const after = lstatSync(path);
      return after.isFile() && after.nlink === 1 && after.dev === before.dev
        && after.ino === before.ino && after.size === before.size
        && after.mtimeMs === before.mtimeMs && realpathSync(path) === this.target;
    } catch {
      return false;
    }
  }

  async persist(path: string, payload: string): Promise<void> {
    const bytes = Buffer.byteLength(payload, "utf8");
    const digest = Bun.hash(payload).toString(36);
    if (this.digest === digest && this.bytes === bytes && await this.diskMatches(path, payload, bytes)) {
      this.unchangedSkips += 1;
      return;
    }
    await this.write(path, payload);
    // Publish the memo only after a successful atomic write. A failed write keeps the previous
    // fingerprint, which is harmless because every prospective skip rechecks the disk.
    this.digest = digest;
    this.bytes = bytes;
    this.writes += 1;
    this.bytesWritten += bytes;
    try { this.target = realpathSync(path); }
    catch { this.target = null; }
  }
}
