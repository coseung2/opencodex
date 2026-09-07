import { beforeEach, describe, expect, test } from "bun:test";
import {
  calibrateKiroEstimate,
  recordKiroCalibration,
  rekeyKiroCalibration,
  resetKiroCalibration,
} from "../src/adapters/kiro-calibration";

describe("Kiro context estimate calibration", () => {
  beforeEach(() => resetKiroCalibration());

  test("an unseen conversation is unchanged", () => {
    expect(calibrateKiroEstimate("conv-a", 1_000)).toBe(1_000);
  });

  test("an under-estimating conversation learns upward gradually", () => {
    calibrateKiroEstimate("conv-a", 1_000);
    recordKiroCalibration("conv-a", 1_000, 1_500);
    const next = calibrateKiroEstimate("conv-a", 1_000);
    expect(next).toBeGreaterThan(1_000);
    expect(next).toBeLessThan(1_500);
  });

  test("an over-estimating conversation can correct downward only within the clamp", () => {
    calibrateKiroEstimate("conv-a", 1_000);
    recordKiroCalibration("conv-a", 1_000, 100);
    const next = calibrateKiroEstimate("conv-a", 1_000);
    expect(next).toBeGreaterThanOrEqual(700);
    expect(next).toBeLessThan(1_000);
  });

  test("invalid and implausible observations are ignored", () => {
    for (const charged of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 7_000]) {
      calibrateKiroEstimate("conv-junk", 1_000);
      recordKiroCalibration("conv-junk", 1_000, charged);
    }
    expect(calibrateKiroEstimate("conv-junk", 1_000)).toBe(1_000);
  });

  test("conversations are isolated", () => {
    calibrateKiroEstimate("conv-x", 1_000);
    recordKiroCalibration("conv-x", 1_000, 2_000);
    expect(calibrateKiroEstimate("conv-y", 1_000)).toBe(1_000);
    expect(calibrateKiroEstimate("conv-x", 1_000)).toBeGreaterThan(1_000);
  });

  test("provider-returned conversation ids inherit the request calibration baseline", () => {
    calibrateKiroEstimate("request-id", 1_000);
    rekeyKiroCalibration("request-id", "returned-id");
    recordKiroCalibration("returned-id", 1_000, 1_500);
    expect(calibrateKiroEstimate("returned-id", 1_000)).toBeGreaterThan(1_000);
    expect(calibrateKiroEstimate("request-id", 1_000)).toBe(1_000);
  });

  test("tracking is bounded and evicts old conversations", () => {
    for (let index = 0; index < 600; index += 1) {
      calibrateKiroEstimate(`conv-${index}`, 1_000);
      recordKiroCalibration(`conv-${index}`, 1_000, 1_500);
    }
    expect(calibrateKiroEstimate("conv-0", 1_000)).toBe(1_000);
    expect(calibrateKiroEstimate("conv-599", 1_000)).toBeGreaterThan(1_000);
  });

  test("learning uses the raw heuristic so repeated turns converge near the true ratio", () => {
    const conversationId = "conv-converge";
    const trueRatio = 1.35;
    let lastRatio = 0;
    for (let turn = 1; turn <= 6; turn += 1) {
      const raw = 10_000 * turn;
      const applied = calibrateKiroEstimate(conversationId, raw);
      const charged = Math.round(raw * trueRatio);
      lastRatio = applied / charged;
      recordKiroCalibration(conversationId, applied, charged);
    }
    expect(lastRatio).toBeGreaterThan(0.95);
    expect(lastRatio).toBeLessThan(1.03);
  });

  test("post-response output must be removed by the caller before learning", () => {
    const requestEstimate = 1_000;
    calibrateKiroEstimate("correct", requestEstimate);
    recordKiroCalibration("correct", requestEstimate, 1_000);
    expect(calibrateKiroEstimate("correct", requestEstimate)).toBe(requestEstimate);

    calibrateKiroEstimate("poisoned", requestEstimate);
    recordKiroCalibration("poisoned", requestEstimate, 3_000);
    expect(calibrateKiroEstimate("poisoned", requestEstimate)).toBeGreaterThan(requestEstimate * 1.5);
  });
});
