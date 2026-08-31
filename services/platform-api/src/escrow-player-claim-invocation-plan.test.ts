import { describe, expect, it } from "vitest";
import { EscrowPlayerClaimInstruction, serializeEscrowPlayerClaimInstructionData } from "./escrow-player-claim-abi.js";
import {
  createEscrowClaimParticipationRebateInvocationPlan,
  createEscrowClaimRefundInvocationPlan
} from "./escrow-player-claim-invocation-plan.js";
import { createPaidMatchTerms } from "./paid-match.js";

const PROGRAM_ID = "Stake11111111111111111111111111111111111111";
const NATIVE_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PLAYER = "7YttLkH3UQJfB73uExyGfEKvwR6LjhQmN6x2PRZKMrP2";
const NOW = new Date("2026-08-31T02:30:00.000Z");

describe("escrow player claim invocation plans", () => {
  it("locks the two player pull-claim discriminators and exact Anchor account order", () => {
    const terms = createPaidMatchTerms({ usdcMint: NATIVE_USDC_MINT, escrowProgramId: PROGRAM_ID, now: NOW });
    const refund = createEscrowClaimRefundInvocationPlan({ terms, escrowProgramId: PROGRAM_ID, playerAddress: PLAYER });
    const rebate = createEscrowClaimParticipationRebateInvocationPlan({ terms, escrowProgramId: PROGRAM_ID, playerAddress: PLAYER });

    expect(refund.instruction).toBe(EscrowPlayerClaimInstruction.REFUND);
    expect(refund.data.toString("hex")).toBe("0f101ea1ffe4613c");
    expect(refund.data).toEqual(serializeEscrowPlayerClaimInstructionData(EscrowPlayerClaimInstruction.REFUND));
    expect(refund.accounts).toEqual([
      { address: PLAYER, isSigner: true, isWritable: true },
      { address: refund.matchAddresses.matchEscrowAddress, isSigner: false, isWritable: true },
      { address: refund.entryAddresses.entryAddress, isSigner: false, isWritable: true },
      { address: NATIVE_USDC_MINT, isSigner: false, isWritable: false },
      { address: refund.entryAddresses.playerTokenAccountAddress, isSigner: false, isWritable: true },
      { address: terms.escrowAddress, isSigner: false, isWritable: true },
      { address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", isSigner: false, isWritable: false },
    ]);

    expect(rebate.instruction).toBe(EscrowPlayerClaimInstruction.PARTICIPATION_REBATE);
    expect(rebate.data.toString("hex")).toBe("c29769bcc57cbc82");
    expect(rebate.data).toEqual(serializeEscrowPlayerClaimInstructionData(EscrowPlayerClaimInstruction.PARTICIPATION_REBATE));
    expect(rebate.accounts).toEqual(refund.accounts);
  });

  it("fails closed if immutable terms select a different escrow account", () => {
    const terms = createPaidMatchTerms({ usdcMint: NATIVE_USDC_MINT, escrowProgramId: PROGRAM_ID, now: NOW });
    expect(() => createEscrowClaimRefundInvocationPlan({
      terms: { ...terms, escrowAddress: "9xQeWvG816bUx9EPfEZgC3Jk6zR9aM2Qq8F4JZ2xAazC" },
      escrowProgramId: PROGRAM_ID,
      playerAddress: PLAYER,
    })).toThrow("do not match the escrow program-derived token account");
  });
});
