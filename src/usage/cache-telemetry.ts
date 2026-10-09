import type { OcxUsage } from "../types";

export function reportedCacheCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function cacheTelemetry(read: unknown, write: unknown): NonNullable<OcxUsage["cacheTelemetry"]> {
  return { readReported: reportedCacheCount(read), writeReported: reportedCacheCount(write), inputIncludesCache: true };
}
