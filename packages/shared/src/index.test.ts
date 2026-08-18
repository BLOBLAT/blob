import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAID_MATCH_CONFIGURATION,
  PaidMatchState,
  calculatePrizeDistribution,
  canTransitionPaidMatch,
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

  it("calculates the specified 10-player, 1 USDC example without floats", () => {
    const result = calculatePrizeDistribution({ ...DEFAULT_PAID_MATCH_CONFIGURATION, playerCount: 10 });

    expect(result.grossPoolBaseUnits).toBe(10_000_000n);
    expect(result.platformFeeBaseUnits).toBe(500_000n);
    expect(result.prizePoolBaseUnits).toBe(9_500_000n);
    expect(result.payouts.map((payout) => payout.amountBaseUnits)).toEqual([5_700_000n, 2_375_000n, 1_425_000n]);
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
    })).toThrow("10000 basis points");
  });
});

describe("paid-match state machine", () => {
  it("allows only explicit financial lifecycle transitions", () => {
    expect(canTransitionPaidMatch(PaidMatchState.FUNDING, PaidMatchState.READY)).toBe(true);
    expect(transitionPaidMatch(PaidMatchState.FINALIZING, PaidMatchState.SETTLED)).toBe(PaidMatchState.SETTLED);
    expect(canTransitionPaidMatch(PaidMatchState.OPEN, PaidMatchState.LIVE)).toBe(false);
    expect(() => transitionPaidMatch(PaidMatchState.OPEN, PaidMatchState.SETTLED)).toThrow("Invalid paid-match transition");
  });
});
