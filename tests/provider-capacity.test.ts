import { describe, expect, test } from "bun:test";
import {
  aggregateCodexPoolCapacity,
  CODEX_CAPACITY_MAX_QUOTA_AGE_MS,
  type CodexCapacityAccount,
} from "../src/providers/codex-capacity";

const NOW = 1_800_000_000_000;

function account(
  plan: unknown,
  weeklyPercent: number | undefined,
  options: Partial<CodexCapacityAccount> & { weeklyResetAt?: number } = {},
): CodexCapacityAccount {
  return {
    isMain: false,
    plan,
    paused: false,
    quota: weeklyPercent === undefined ? null : {
      weeklyPercent,
      ...(options.weeklyResetAt !== undefined ? { weeklyResetAt: options.weeklyResetAt } : {}),
      updatedAt: NOW,
    },
    ...options,
  };
}

describe("configured-weight Codex pool capacity", () => {
  test("weights Pro, Prolite, and Plus and groups the next recovery", () => {
    const result = aggregateCodexPoolCapacity([
      account("pro", 10, { isMain: true, active: true, weeklyResetAt: NOW + 30_000 }),
      account("prolite", 100, { weeklyResetAt: NOW + 10_000 }),
      account("plus", 100, { weeklyResetAt: NOW + 20_000 }),
    ], NOW);
    expect(result.quota?.weeklyPercent).toBeCloseTo(30.769230769, 8);
    expect(result.aggregation?.weekly).toMatchObject({
      totalWeight: 26,
      consumedWeight: 8,
      remainingWeight: 18,
      nextRecoveryAt: NOW + 10_000,
    });
    expect(result.aggregation?.currentAccount?.quota?.weeklyPercent).toBe(10);
  });

  test("keeps paused and reset-pending-shaped rows visible but outside capacity", () => {
    const result = aggregateCodexPoolCapacity([
      account("plus", 20, { isMain: true }),
      account("pro", 100, { active: true, paused: true }),
    ], NOW);
    expect(result.quota?.weeklyPercent).toBe(20);
    expect(result.aggregation).toMatchObject({
      includedAccounts: 1,
      excludedAccounts: 1,
      pausedAccounts: 1,
      incomplete: true,
      currentAccount: { plan: "pro", quota: null },
    });
  });

  test("rejects stale, malformed, prototype, and OpenCode Go plan data", () => {
    const stale = account("pro", 100);
    stale.quota = { ...stale.quota!, updatedAt: NOW - CODEX_CAPACITY_MAX_QUOTA_AGE_MS - 1 };
    const result = aggregateCodexPoolCapacity([
      account("plus", 20, { isMain: true, active: true }),
      stale,
      account("constructor", 100),
      account("opencode-go", 100),
      account({ provider: "opencode-go", windows: ["per-key"] }, 100),
    ], NOW);
    expect(result.quota?.weeklyPercent).toBe(20);
    expect(result.aggregation).toMatchObject({
      includedAccounts: 1,
      excludedAccounts: 4,
      unknownPlanAccounts: 3,
      staleQuotaAccounts: 1,
    });
  });

  test("recognizes legacy Team and Business as equal capacity tiers", () => {
    const result = aggregateCodexPoolCapacity([
      account("team", 20, { isMain: true, active: true }),
      account("business", 60),
    ], NOW);
    expect(result.quota?.weeklyPercent).toBe(40);
    expect(result.aggregation).toMatchObject({ includedAccounts: 2, incomplete: false });
  });
});
