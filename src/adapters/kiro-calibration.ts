/**
 * Per-conversation correction for Kiro's heuristic context estimate.
 *
 * Kiro reports `contextUsagePercentage`; against a known context window that is an authoritative
 * post-response checkpoint. We learn a bounded, smoothed charged/estimated factor per conversation
 * and apply it to later turns. State is process-local, bounded, and never persisted.
 */

const MIN_FACTOR = 0.7;
const MAX_FACTOR = 3;
const SMOOTHING = 0.35;
const MAX_TRACKED_CONVERSATIONS = 256;
const MAX_PLAUSIBLE_OBSERVATION = 6;

interface Calibration {
  factor?: number;
  /** Raw heuristic estimate most recently built for this conversation. */
  rawEstimate?: number;
}

const calibrations = new Map<string, Calibration>();

function touch(conversationId: string, update: (current: Calibration) => Calibration): void {
  const current = calibrations.get(conversationId) ?? {};
  calibrations.delete(conversationId);
  calibrations.set(conversationId, update(current));
  while (calibrations.size > MAX_TRACKED_CONVERSATIONS) {
    const oldest = calibrations.keys().next();
    if (oldest.done) break;
    calibrations.delete(oldest.value);
  }
}

function clamp(value: number): number {
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, value));
}

/** Record one terminal turn's measured Kiro input charge. Invalid/implausible readings are ignored. */
export function recordKiroCalibration(
  conversationId: string | undefined,
  estimated: number,
  charged: number,
): void {
  if (!conversationId || !Number.isFinite(estimated) || !Number.isFinite(charged)) return;
  if (estimated <= 0 || charged <= 0) return;
  const entry = calibrations.get(conversationId);
  // Learning must use the RAW heuristic, not an already-corrected estimate, or the correction
  // measures its own residual and converges short of the actual provider charge.
  const baseline = entry?.rawEstimate ?? estimated;
  if (!Number.isFinite(baseline) || baseline <= 0) return;
  const observed = charged / baseline;
  if (!Number.isFinite(observed) || observed <= 0 || observed > MAX_PLAUSIBLE_OBSERVATION) return;

  const previous = entry?.factor ?? 1;
  const next = clamp(previous + (observed - previous) * SMOOTHING);
  // Consume the baseline so duplicate metadata cannot re-score a stale payload.
  touch(conversationId, () => ({ factor: next }));
}

/** Apply the learned factor and remember the raw estimate used for the next observation. */
export function calibrateKiroEstimate(conversationId: string | undefined, estimate: number): number {
  if (!conversationId || !Number.isFinite(estimate) || estimate <= 0) return estimate;
  touch(conversationId, current => ({ ...current, rawEstimate: estimate }));
  const factor = calibrations.get(conversationId)?.factor;
  return factor === undefined ? estimate : Math.ceil(estimate * factor);
}

/** Carry calibration to a provider-returned conversation id when it differs from the request id. */
export function rekeyKiroCalibration(
  fromConversationId: string | undefined,
  toConversationId: string | undefined,
): void {
  if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return;
  const entry = calibrations.get(fromConversationId);
  if (!entry) return;
  calibrations.delete(fromConversationId);
  touch(toConversationId, current => ({ ...current, ...entry }));
}

/** Test-only reset. */
export function resetKiroCalibration(): void {
  calibrations.clear();
}
