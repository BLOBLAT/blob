import { PaidRuleset, type PaidDeathEvent } from "@blob/shared";
import { describe, expect, it } from "vitest";
import { createEscrowPurchaseReviveInvocationPlan } from "./escrow-purchase-revive-invocation-plan.js";
import { createPaidMatchTerms } from "./paid-match.js";

const PROGRAM_ID = "Stake11111111111111111111111111111111111111";
const NATIVE_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PLAYER = "7YttLkH3UQJfB73uExyGfEKvwR6LjhQmN6x2PRZKMrP2";
const RESULT_AUTHORITY = "B6xXoQkbXZp27DiNUZCr36N54xe69Bp5uzWUsWeLMYqV";
const NOW = new Date("2026-08-31T02:30:00.000Z");

describe("purchase_revive invocation plan", () => {
  it("accepts only a matching authoritative Rebuy death and locks Anchor account order", () => {
    const terms = createPaidMatchTerms({
      usdcMint: NATIVE_USDC_MINT,
      escrowProgramId: PROGRAM_ID,
      ruleset: PaidRuleset.REBUY,
      now: NOW,
    });
    const death: PaidDeathEvent = {
      deathId: "death-0001",
      matchId: terms.matchId,
      roundId: terms.roundId,
      playerId: "player-1",
      diedAt: new Date("2026-08-31T02:42:00.000Z"),
      reviveExpiresAt: new Date("2026-08-31T02:42:30.000Z"),
      reviveCutoffAt: new Date("2026-08-31T02:37:00.000Z"),
    };
    const plan = createEscrowPurchaseReviveInvocationPlan({
      terms,
      escrowProgramId: PROGRAM_ID,
      player: { playerId: "player-1", walletAddress: PLAYER },
      death,
      resultAuthority: RESULT_AUTHORITY,
    });

    expect(plan.deathAtUnixSeconds).toBe(1_788_144_120n);
    expect(plan.data.subarray(0, 8).toString("hex")).toBe("d64b985dc410ab9c");
    expect(plan.data).toHaveLength(48);
    expect(plan.reviveAddresses.deathIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.accounts).toEqual([
      { address: PLAYER, isSigner: true, isWritable: true },
      { address: RESULT_AUTHORITY, isSigner: true, isWritable: false },
      { address: plan.matchAddresses.matchEscrowAddress, isSigner: false, isWritable: true },
      { address: plan.reviveAddresses.entryAddress, isSigner: false, isWritable: true },
      { address: plan.reviveAddresses.reviveReceiptAddress, isSigner: false, isWritable: true },
      { address: NATIVE_USDC_MINT, isSigner: false, isWritable: false },
      { address: plan.reviveAddresses.playerTokenAccountAddress, isSigner: false, isWritable: true },
      { address: terms.escrowAddress, isSigner: false, isWritable: true },
      { address: "11111111111111111111111111111111", isSigner: false, isWritable: false },
      { address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", isSigner: false, isWritable: false },
    ]);
  });

  it("fails closed for standard rules, cross-match deaths, and fractional timestamps", () => {
    const standardTerms = createPaidMatchTerms({ usdcMint: NATIVE_USDC_MINT, escrowProgramId: PROGRAM_ID, now: NOW });
    const incompatibleDeath = deathFor(standardTerms, "player-1");
    expect(() => createEscrowPurchaseReviveInvocationPlan({
      terms: standardTerms,
      escrowProgramId: PROGRAM_ID,
      player: { playerId: "player-1", walletAddress: PLAYER },
      death: incompatibleDeath,
      resultAuthority: RESULT_AUTHORITY,
    })).toThrow("do not permit a paid revive");

    const rebuyTerms = createPaidMatchTerms({ usdcMint: NATIVE_USDC_MINT, escrowProgramId: PROGRAM_ID, ruleset: PaidRuleset.REBUY, now: NOW });
    expect(() => createEscrowPurchaseReviveInvocationPlan({
      terms: rebuyTerms,
      escrowProgramId: PROGRAM_ID,
      player: { playerId: "player-1", walletAddress: PLAYER },
      death: { ...deathFor(rebuyTerms, "player-1"), matchId: "another-match" },
      resultAuthority: RESULT_AUTHORITY,
    })).toThrow("does not belong to this paid player and match");
    expect(() => createEscrowPurchaseReviveInvocationPlan({
      terms: rebuyTerms,
      escrowProgramId: PROGRAM_ID,
      player: { playerId: "player-1", walletAddress: PLAYER },
      death: { ...deathFor(rebuyTerms, "player-1"), diedAt: new Date("2026-08-31T02:42:00.001Z") },
      resultAuthority: RESULT_AUTHORITY,
    })).toThrow("whole-second precision");
  });
});

function deathFor(terms: ReturnType<typeof createPaidMatchTerms>, playerId: string): PaidDeathEvent {
  return {
    deathId: "death-0002",
    matchId: terms.matchId,
    roundId: terms.roundId,
    playerId,
    diedAt: new Date("2026-08-31T02:42:00.000Z"),
    reviveExpiresAt: new Date("2026-08-31T02:42:30.000Z"),
    reviveCutoffAt: new Date("2026-08-31T02:37:00.000Z"),
  };
}
