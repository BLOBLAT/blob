import { describe, expect, it } from "vitest";
import { serializeEnterMatchInstructionData } from "./escrow-enter-match-abi.js";
import { createEscrowEnterMatchInvocationPlan } from "./escrow-enter-match-invocation-plan.js";
import { createPaidMatchTerms } from "./paid-match.js";

const PROGRAM_ID = "Stake11111111111111111111111111111111111111";
const NATIVE_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PLAYER = "7YttLkH3UQJfB73uExyGfEKvwR6LjhQmN6x2PRZKMrP2";
const NOW = new Date("2026-08-31T02:30:00.000Z");

describe("enter_match invocation plan", () => {
  it("uses exactly the Anchor account order, canonical player ATA, and no instruction arguments", () => {
    const terms = createPaidMatchTerms({ usdcMint: NATIVE_USDC_MINT, escrowProgramId: PROGRAM_ID, now: NOW });
    const plan = createEscrowEnterMatchInvocationPlan({ terms, escrowProgramId: PROGRAM_ID, playerAddress: PLAYER });

    expect(plan.data.toString("hex")).toBe("194883fc6fe7cf95");
    expect(plan.data).toEqual(serializeEnterMatchInstructionData());
    expect(plan.accounts).toEqual([
      { address: PLAYER, isSigner: true, isWritable: true },
      { address: plan.matchAddresses.matchEscrowAddress, isSigner: false, isWritable: true },
      { address: plan.entryAddresses.entryAddress, isSigner: false, isWritable: true },
      { address: NATIVE_USDC_MINT, isSigner: false, isWritable: false },
      { address: plan.entryAddresses.playerTokenAccountAddress, isSigner: false, isWritable: true },
      { address: terms.escrowAddress, isSigner: false, isWritable: true },
      { address: "11111111111111111111111111111111", isSigner: false, isWritable: false },
      { address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", isSigner: false, isWritable: false },
    ]);
  });

  it("fails closed if immutable terms select another escrow account", () => {
    const terms = createPaidMatchTerms({ usdcMint: NATIVE_USDC_MINT, escrowProgramId: PROGRAM_ID, now: NOW });
    expect(() => createEscrowEnterMatchInvocationPlan({
      terms: { ...terms, escrowAddress: "9xQeWvG816bUx9EPfEZgC3Jk6zR9aM2Qq8F4JZ2xAazC" },
      escrowProgramId: PROGRAM_ID,
      playerAddress: PLAYER,
    })).toThrow("do not match the escrow program-derived token account");
  });
});
