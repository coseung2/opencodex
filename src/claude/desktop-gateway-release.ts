import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config";
import { resolveDesktop3pConfigLibraryPath } from "./desktop-3p";

// Adapted from upstream d17a9f22's standard-profile pivot. Retain the gateway row for rollback.
const MAX_PROFILE_BYTES = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export interface GatewayReleaseOptions {
  libraryPath?: string;
  appliedFingerprint?: string;
  /** Explicit local Notch transition: allow only the exact saved loopback relay destination. */
  expectedGatewayOrigin?: string;
  beforeCommit?: () => void;
}
export type GatewayReleaseResult =
  | { ok: true; changed: boolean; rollback: () => boolean }
  | { ok: false; changed: false; reason: "unsafe_library" | "foreign_profile" | "profile_changed" | "write_failed" };

function readRegular(path: string): string | null {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_PROFILE_BYTES) throw new Error("unsafe_file");
  return readFileSync(path, "utf8");
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fingerprint(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** Leave a foreign selection untouched; release only an exact, previously applied OCX gateway. */
export function releaseDesktopGateway(options: GatewayReleaseOptions = {}): GatewayReleaseResult {
  const library = options.libraryPath ?? resolveDesktop3pConfigLibraryPath();
  const metadataPath = join(library, "_meta.json");
  let original: string;
  let metadata: Record<string, unknown>;
  let gateway: Record<string, unknown>;
  try {
    let directory;
    try { directory = lstatSync(library); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, changed: false, rollback: () => true };
      throw error;
    }
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("unsafe_directory");
    const bytes = readRegular(metadataPath);
    if (bytes === null) return { ok: true, changed: false, rollback: () => true };
    original = bytes;
    const parsed: unknown = JSON.parse(bytes);
    if (!record(parsed) || !Array.isArray(parsed.entries)) throw new Error("invalid_metadata");
    metadata = parsed;
    const selected = parsed.appliedId;
    if (selected === undefined || selected === null) return { ok: true, changed: false, rollback: () => true };
    if (typeof selected !== "string" || !SAFE_ID.test(selected)) throw new Error("unsafe_id");
    const entries = parsed.entries.filter(record);
    const owned = entries.find(entry => entry.id === selected && (entry.name === "opencodex"
      || (options.expectedGatewayOrigin === "http://127.0.0.1:10101" && entry.name === "vmocx")));
    if (!owned && entries.some(entry => entry.id === selected && entry.name === "opencodex-standard")) {
      const standard = readRegular(join(library, `${selected}.json`));
      const parsedStandard: unknown = standard === null ? null : JSON.parse(standard);
      if (record(parsedStandard) && parsedStandard.inferenceProvider === undefined) return { ok: true, changed: false, rollback: () => true };
    }
    if (!owned) return { ok: false, changed: false, reason: "foreign_profile" };
    const selectedBytes = readRegular(join(library, `${selected}.json`));
    if (selectedBytes === null) return { ok: false, changed: false, reason: "profile_changed" };
    const profile: unknown = JSON.parse(selectedBytes);
    if (!record(profile) || profile.inferenceProvider !== "gateway") return { ok: false, changed: false, reason: "foreign_profile" };
    const fingerprintMatches = options.appliedFingerprint !== undefined && fingerprint(selectedBytes) === options.appliedFingerprint;
    const explicitRelayMatches = options.expectedGatewayOrigin === "http://127.0.0.1:10101"
      && profile.inferenceGatewayBaseUrl === options.expectedGatewayOrigin;
    if (!fingerprintMatches && !explicitRelayMatches) return { ok: false, changed: false, reason: "profile_changed" };
    gateway = profile;
  } catch { return { ok: false, changed: false, reason: "unsafe_library" }; }

  const id = randomUUID();
  const standardPath = join(library, `${id}.json`);
  // Retain egress and unrelated application settings, never gateway credentials.
  const ownedKeys = new Set(["inferenceProvider", "inferenceCredentialKind", "inferenceGatewayBaseUrl", "inferenceGatewayApiKey", "inferenceModels", "modelDiscoveryEnabled"]);
  const standard = `${JSON.stringify(Object.fromEntries(Object.entries(gateway).filter(([key]) => !ownedKeys.has(key))), null, 2)}\n`;
  const replacement = `${JSON.stringify({ ...metadata, appliedId: id, entries: [...metadata.entries as unknown[], { id, name: "opencodex-standard" }] }, null, 2)}\n`;
  let published = false;
  try {
    if (readRegular(standardPath) !== null) throw new Error("profile_collision");
    atomicWriteFile(standardPath, standard);
    options.beforeCommit?.();
    if (readRegular(metadataPath) !== original) {
      if (readRegular(standardPath) === standard) unlinkSync(standardPath);
      return { ok: false, changed: false, reason: "profile_changed" };
    }
    atomicWriteFile(metadataPath, replacement);
    published = true;
    return {
      ok: true, changed: true,
      rollback() {
        try {
          if (readRegular(metadataPath) !== replacement || readRegular(standardPath) !== standard) return false;
          atomicWriteFile(metadataPath, original);
          if (readRegular(standardPath) === standard) unlinkSync(standardPath);
          return true;
        } catch { return false; }
      },
    };
  } catch {
    if (!published) {
      try { if (readRegular(standardPath) === standard) unlinkSync(standardPath); } catch { /* Preserve a substituted file. */ }
    }
    return { ok: false, changed: false, reason: "write_failed" };
  }
}
