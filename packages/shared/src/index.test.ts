import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAID_MATCH_CONFIGURATION,
  DEFAULT_REBUY_REVIVE_CONFIGURATION,
  PAID_MATCH_MIN_ENTRY_AMOUNT_BASE_UNITS,
  PaidMatchState,
  PaidReviveBlockReason,
  PaidRuleset,
  assertPaidMatchConfiguration,
  assertPaidReviveConfiguration,
  calculatePaidMatchPool,
  calculatePrizeDistribution,
  calculatePrizeDistributionFromGrossPool,
  canTransitionPaidMatch,
  getPaidReviveEligibility,
  transitionPaidMatch
} from "./index.js";

function totalDistributed(result: ReturnType<typeof calculatePrizeDistribution>): bigint {
  return result.platformFeeBaseUnits + result.payouts.reduce((total, payout) => total + payout.amountBaseUnits, 0n);
}

describe("integer prize calculation", () => {
  it.each([
    [3, 1_000_000n],
    [10, 1_000_000n],
    [100, 1_000_000n],
    [3, 1n],
    [10, 12_345n]
  ])("balances exactly for %i players at %sn base units", (playerCount, entryAmountBaseUnits) => {
    const result = calculatePrizeDistribution({
      ...DEFAULT_PAID_MATCH_CONFIGURATION,
      playerCount,
      entryAmountBaseUnits
    });

    expect(totalDistributed(result)).toBe(result.grossPoolBaseUnits);
    expect(result.payouts).toHaveLength(3);
  });

  it("calculates the specified 10-player, 10 USDC example without floats", () => {
    const result = calculatePrizeDistribution({
      ...DEFAULT_PAID_MATCH_CONFIGURATION,
      playerCount: 10,
      entryAmountBaseUnits: 10_000_000n,
    });

    expect(result.grossPoolBaseUnits).toBe(100_000_000n);
    expect(result.platformFeeBaseUnits).toBe(5_000_000n);
    expect(result.prizePoolBaseUnits).toBe(95_000_000n);
    expect(result.payouts.map((payout) => payout.amountBaseUnits)).toEqual([57_000_000n, 28_500_000n, 9_500_000n]);
  });

  it("assigns rounding remainder to first place deterministically", () => {
    const result = calculatePrizeDistribution({ ...DEFAULT_PAID_MATCH_CONFIGURATION, playerCount: 3, entryAmountBaseUnits: 1n });

    expect(result.roundingRemainderBaseUnits).toBe(2n);
    expect(result.payouts[0]?.amountBaseUnits).toBe(3n);
    expect(totalDistributed(result)).toBe(3n);
  });

  it("rejects invalid configurations", () => {
    expect(() => calculatePrizeDistribution({
      ...DEFAULT_PAID_MATCH_CONFIGURATION,
      playerCount: 0
    })).toThrow("playerCount");
    expect(() => calculatePrizeDistribution({
      ...DEFAULT_PAID_MATCH_CONFIGURATION,
      playerCount: 3,
      prizeDistribution: [{ place: 1, basisPoints: 9_999n }]
    })).toThrow("exactly three prize places");
  });

  it("includes confirmed paid revives in the final pool before fee and payouts", () => {
    const pool = calculatePaidMatchPool({
      entryAmountBaseUnits: 1_000_000n,
      entryCount: 10,
      reviveAmountBaseUnits: 500_000n,
      confirmedReviveCount: 3
    });
    const result = calculatePrizeDistributionFromGrossPool({
      ...DEFAULT_PAID_MATCH_CONFIGURATION,
      grossPoolBaseUnits: pool.grossPoolBaseUnits
    });

    expect(pool).toEqual({
      entryPoolBaseUnits: 10_000_000n,
      revivePoolBaseUnits: 1_500_000n,
      grossPoolBaseUnits: 11_500_000n
    });
    expect(result.platformFeeBaseUnits).toBe(575_000n);
    expect(result.prizePoolBaseUnits).toBe(10_925_000n);
    expect(result.payouts.map((payout) => payout.amountBaseUnits)).toEqual([6_555_000n, 3_277_500n, 1_092_500n]);
    expect(totalDistributed(result)).toBe(11_500_000n);
  });
});

describe("paid revive policy", () => {
  it("allows one timely revive and closes it at the authoritative final minute", () => {
    expect(getPaidReviveEligibility(DEFAULT_REBUY_REVIVE_CONFIGURATION, {
      isPlayerDead: true,
      revivesUsed: 0,
      remainingMs: 60_001,
      millisecondsSinceDeath: 30_000
    })).toBe(PaidReviveBlockReason.ALLOWED);

    expect(getPaidReviveEligibility(DEFAULT_REBUY_REVIVE_CONFIGURATION, {
      isPlayerDead: true,
      revivesUsed: 0,
      remainingMs: 60_000,
      millisecondsSinceDeath: 1
    })).toBe(PaidReviveBlockReason.ROUND_CUTOFF_REACHED);
  });

  it("rejects a revive from a living player, expired death window, or second purchase", () => {
    expect(getPaidReviveEligibility(DEFAULT_REBUY_REVIVE_CONFIGURATION, {
      isPlayerDead: false,
      revivesUsed: 0,
      remainingMs: 90_000,
      millisecondsSinceDeath: 1
    })).toBe(PaidReviveBlockReason.PLAYER_IS_ALIVE);

    expect(getPaidReviveEligibility(DEFAULT_REBUY_REVIVE_CONFIGURATION, {
      isPlayerDead: true,
      revivesUsed: 0,
      remainingMs: 90_000,
      millisecondsSinceDeath: 30_001
    })).toBe(PaidReviveBlockReason.REVIVE_WINDOW_EXPIRED);

    expect(getPaidReviveEligibility(DEFAULT_REBUY_REVIVE_CONFIGURATION, {
      isPlayerDead: true,
      revivesUsed: 1,
      remainingMs: 90_000,
      millisecondsSinceDeath: 1
    })).toBe(PaidReviveBlockReason.REVIVE_LIMIT_REACHED);
  });

  it("keeps canonical Skill and Rebuy policy shapes compatible with escrow", () => {
    expect(() => assertPaidMatchConfiguration(DEFAULT_PAID_MATCH_CONFIGURATION)).not.toThrow();
    expect(() => assertPaidReviveConfiguration(DEFAULT_REBUY_REVIVE_CONFIGURATION)).not.toThrow();
    expect(() => assertPaidReviveConfiguration({
      enabled: false,
      reviveAmountBaseUnits: 0n,
      maxRevivesPerPlayer: 0,
      reviveWindowMs: 0,
      reviveCutoffMs: 0,
      spawnProtectionMs: 0
    })).not.toThrow();
    expect(() => assertPaidReviveConfiguration({
      ...DEFAULT_REBUY_REVIVE_CONFIGURATION,
      enabled: false
    })).toThrow("canonical zero values");
    expect(() => assertPaidMatchConfiguration({
      ...DEFAULT_PAID_MATCH_CONFIGURATION,
      ruleset: PaidRuleset.SKILL,
      maximumPlayers: 33
    })).toThrow("player limits");
    expect(() => assertPaidMatchConfiguration({
      ...DEFAULT_PAID_MATCH_CONFIGURATION,
      entryAmountBaseUnits: PAID_MATCH_MIN_ENTRY_AMOUNT_BASE_UNITS - 1n
    })).toThrow("at least 0.01 USDC");
  });
});

describe("paid-match state machine", () => {
  it("allows only explicit financial lifecycle transitions", () => {
    expect(canTransitionPaidMatch(PaidMatchState.FUNDING, PaidMatchState.READY)).toBe(true);
    expect(canTransitionPaidMatch(PaidMatchState.READY, PaidMatchState.REFUNDING)).toBe(true);
    expect(transitionPaidMatch(PaidMatchState.FINALIZING, PaidMatchState.SETTLED)).toBe(PaidMatchState.SETTLED);
    expect(canTransitionPaidMatch(PaidMatchState.OPEN, PaidMatchState.LIVE)).toBe(false);
    expect(canTransitionPaidMatch(PaidMatchState.LIVE, PaidMatchState.REFUNDING)).toBe(false);
    expect(canTransitionPaidMatch(PaidMatchState.FINALIZING, PaidMatchState.REFUNDING)).toBe(false);
    expect(canTransitionPaidMatch(PaidMatchState.CANCELLED, PaidMatchState.REFUNDING)).toBe(false);
    expect(() => transitionPaidMatch(PaidMatchState.OPEN, PaidMatchState.SETTLED)).toThrow("Invalid paid-match transition");
  });
});
