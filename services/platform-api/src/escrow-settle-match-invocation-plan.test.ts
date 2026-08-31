import { describe, expect, it } from "vitest";
import type { AuthoritativeMatchResult } from "@blob/shared";
import { createEscrowSettleMatchInvocationPlan } from "./escrow-settle-match-invocation-plan.js";
import { createPaidMatchTerms } from "./paid-match.js";

const PROGRAM_ID = "Stake11111111111111111111111111111111111111";
const NATIVE_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WALLETS = [
  "4Nd1m3sW3vJ3zN9WZ1xQ2u5d7i9K6p4YvTq8eR1sA2bC",
  "7YttLkH3UQJfB73uExyGfEKvwR6LjhQmN6x2PRZKMrP2",
  "B6xXoQkbXZp27DiNUZCr36N54xe69Bp5uzWUsWeLMYqV",
  "So11111111111111111111111111111111111111112",
  "Stake11111111111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
];
const NOW = new Date("2026-08-31T02:30:00.000Z");

describe("settle_match invocation plan", () => {
  it("binds three authoritative winners, standard token accounts, and immutable result hash bytes", () => {
    const terms = createPaidMatchTerms({ usdcMint: NATIVE_USDC_MINT, escrowProgramId: PROGRAM_ID, now: NOW });
    const plan = createEscrowSettleMatchInvocationPlan({
      terms,
      result: resultFor(terms.matchId, terms.roundId),
      verifiedParticipants: WALLETS.map((walletAddress, index) => ({ playerId: "player-" + (index + 1), walletAddress })),
      confirmedRevives: [],
      escrowProgramId: PROGRAM_ID,
      resultAuthority: "BPFLoader1111111111111111111111111111111111",
      treasury: "11111111111111111111111111111111",
      settlementId: "settlement-test",
    });

    expect(plan.winners.map((winner) => winner.playerId)).toEqual(["player-1", "player-2", "player-3"]);
    expect(plan.data.subarray(0, 8).toString("hex")).toBe("477c7560bfd97418");
    expect(plan.data.subarray(8).toString("hex")).toBe(plan.finalized.immutableResultHash);
    expect(plan.accounts).toEqual([
      { address: "BPFLoader1111111111111111111111111111111111", isSigner: true, isWritable: false },
      { address: plan.matchAddresses.matchEscrowAddress, isSigner: false, isWritable: true },
      { address: NATIVE_USDC_MINT, isSigner: false, isWritable: false },
      { address: terms.escrowAddress, isSigner: false, isWritable: true },
      { address: plan.treasuryTokenAccountAddress, isSigner: false, isWritable: true },
      { address: plan.winners[0]!.entryAddresses.entryAddress, isSigner: false, isWritable: true },
      { address: plan.winners[0]!.entryAddresses.playerTokenAccountAddress, isSigner: false, isWritable: true },
      { address: plan.winners[1]!.entryAddresses.entryAddress, isSigner: false, isWritable: true },
      { address: plan.winners[1]!.entryAddresses.playerTokenAccountAddress, isSigner: false, isWritable: true },
      { address: plan.winners[2]!.entryAddresses.entryAddress, isSigner: false, isWritable: true },
      { address: plan.winners[2]!.entryAddresses.playerTokenAccountAddress, isSigner: false, isWritable: true },
      { address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", isSigner: false, isWritable: false },
    ]);
  });

  it("fails closed when durable terms do not select the derived escrow ATA", () => {
    const terms = createPaidMatchTerms({ usdcMint: NATIVE_USDC_MINT, escrowProgramId: PROGRAM_ID, now: NOW });
    expect(() => createEscrowSettleMatchInvocationPlan({
      terms: { ...terms, escrowAddress: "9xQeWvG816bUx9EPfEZgC3Jk6zR9aM2Qq8F4JZ2xAazC" },
      result: resultFor(terms.matchId, terms.roundId),
      verifiedParticipants: WALLETS.map((walletAddress, index) => ({ playerId: "player-" + (index + 1), walletAddress })),
      confirmedRevives: [],
      escrowProgramId: PROGRAM_ID,
      resultAuthority: "BPFLoader1111111111111111111111111111111111",
      treasury: "11111111111111111111111111111111",
    })).toThrow("do not match the escrow program-derived token account");
  });
});

function resultFor(matchId: string, roundId: string): AuthoritativeMatchResult {
  return {
    matchId,
    roundId,
    mode: "PAID",
    resultTimestamp: NOW,
    players: WALLETS.map((_, index) => ({
      playerId: "player-" + (index + 1),
      finalRank: index + 1,
      finalMass: 600 - index * 50,
      foodCollected: 20 - index,
      eliminations: Math.max(0, 5 - index),
      deaths: index,
      survivalTimeMs: 600_000 - index * 1_000,
    })),
  };
}
