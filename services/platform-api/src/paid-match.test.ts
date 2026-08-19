import { describe, expect, it } from "vitest";
import { DEFAULT_PAID_MATCH_CONFIGURATION, PaidReviveBlockReason, PaidRuleset, type AuthoritativeMatchResult } from "@blob/shared";
import { createPaidMatchTerms, finalizePaidMatch, getRebuyOffer } from "./paid-match.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ESCROW = "9xQeWvG816bUx9EPfEZgC3Jk6zR9aM2Qq8F4JZ2xAazC";
const WALLETS = [
  "4Nd1m3sW3vJ3zN9WZ1xQ2u5d7i9K6p4YvTq8eR1sA2bC",
  "7YttLkH3UQJfB73uExyGfEKvwR6LjhQmN6x2PRZKMrP2",
  "B6xXoQkbXZp27DiNUZCr36N54xe69Bp5uzWUsWeLMYqV"
];

describe("paid-match finalization", () => {
  it("uses a 5% fee and includes confirmed Rebuy Arena revives in the final pool", () => {
    const terms = createPaidMatchTerms({ usdcMint: USDC_MINT, escrowAddress: ESCROW, ruleset: PaidRuleset.REBUY, now: NOW });
    const result = createPaidResult(terms.matchId, terms.roundId);
    const finalized = finalizePaidMatch({
      terms,
      result,
      verifiedParticipants: participants(),
      confirmedRevives: [{ playerId: "player-1", deathId: "death-1" }],
      settlementId: "settlement-test"
    });

    expect(finalized.pool.grossPoolBaseUnits).toBe(3_500_000n);
    expect(finalized.prizes.platformFeeBaseUnits).toBe(175_000n);
    expect(finalized.prizes.prizePoolBaseUnits).toBe(3_325_000n);
    expect(finalized.prizes.payouts.map((payout) => payout.amountBaseUnits)).toEqual([1_995_000n, 997_500n, 332_500n]);
    expect(finalized.settlementRequest.idempotencyKey).toContain(terms.matchId);
    expect(finalized.immutableResultHash).toHaveLength(64);
  });

  it("does not allow paid revives for a standard Skill match", () => {
    const terms = createPaidMatchTerms({ usdcMint: USDC_MINT, escrowAddress: ESCROW, ruleset: PaidRuleset.SKILL, now: NOW });
    expect(terms.reviveConfiguration).toEqual({
      enabled: false,
      reviveAmountBaseUnits: 0n,
      maxRevivesPerPlayer: 0,
      reviveWindowMs: 0,
      reviveCutoffMs: 0,
      spawnProtectionMs: 0
    });
    const offer = getRebuyOffer({
      terms,
      playerIsDead: true,
      revivesUsed: 0,
      remainingMs: 120_000,
      diedAt: NOW,
      now: new Date(NOW.getTime() + 1_000)
    });
    expect(offer.reason).toBe(PaidReviveBlockReason.DISABLED);
    expect(offer.amountBaseUnits).toBeNull();
    expect(() => finalizePaidMatch({
      terms,
      result: createPaidResult(terms.matchId, terms.roundId),
      verifiedParticipants: participants(),
      confirmedRevives: [{ playerId: "player-1", deathId: "death-1" }]
    })).toThrow("Standard Skill matches cannot include paid revives");
  });

  it("rejects a result that omits or duplicates a funded participant", () => {
    const terms = createPaidMatchTerms({ usdcMint: USDC_MINT, escrowAddress: ESCROW, now: NOW });
    const result = createPaidResult(terms.matchId, terms.roundId);
    const malformed: AuthoritativeMatchResult = { ...result, players: result.players.slice(0, 2) };
    expect(() => finalizePaidMatch({ terms, result: malformed, verifiedParticipants: participants(), confirmedRevives: [] }))
      .toThrow("Final result does not include every verified entry");
  });

  it("rejects off-chain rules that the native-USDC escrow would reject before entries are accepted", () => {
    expect(() => createPaidMatchTerms({
      usdcMint: USDC_MINT,
      escrowAddress: ESCROW,
      now: NOW,
      configuration: {
        ...DEFAULT_PAID_MATCH_CONFIGURATION,
        prizeDistribution: [
          { place: 1, basisPoints: 7_000n },
          { place: 2, basisPoints: 3_000n }
        ]
      }
    })).toThrow("exactly three prize places");

    expect(() => createPaidMatchTerms({
      usdcMint: USDC_MINT,
      escrowAddress: ESCROW,
      now: NOW,
      configuration: { ...DEFAULT_PAID_MATCH_CONFIGURATION, maximumPlayers: 33 }
    })).toThrow("player limits");
  });
});

function participants() {
  return WALLETS.map((walletAddress, index) => ({ playerId: "player-" + (index + 1), walletAddress }));
}

function createPaidResult(matchId: string, roundId: string): AuthoritativeMatchResult {
  return {
    matchId,
    roundId,
    mode: "PAID",
    resultTimestamp: NOW,
    players: [
      { playerId: "player-1", finalRank: 1, finalMass: 450, foodCollected: 20, eliminations: 2, deaths: 1, survivalTimeMs: 600_000 },
      { playerId: "player-2", finalRank: 2, finalMass: 300, foodCollected: 12, eliminations: 1, deaths: 0, survivalTimeMs: 600_000 },
      { playerId: "player-3", finalRank: 3, finalMass: 180, foodCollected: 8, eliminations: 0, deaths: 1, survivalTimeMs: 500_000 }
    ]
  };
}
