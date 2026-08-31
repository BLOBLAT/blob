import { describe, expect, it } from "vitest";
import { createEscrowCreateMatchInvocationPlan } from "./escrow-create-match-invocation-plan.js";
import { serializeCreateMatchInstructionData } from "./escrow-create-match-abi.js";
import { createPaidMatchTerms } from "./paid-match.js";

const PROGRAM_ID = "Stake11111111111111111111111111111111111111";
const NATIVE_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ROLES = {
  platformAuthority: "4Nd1m3sW3vJ3zN9WZ1xQ2u5d7i9K6p4YvTq8eR1sA2bC",
  matchController: "7YttLkH3UQJfB73uExyGfEKvwR6LjhQmN6x2PRZKMrP2",
  resultAuthority: "B6xXoQkbXZp27DiNUZCr36N54xe69Bp5uzWUsWeLMYqV",
  treasury: "So11111111111111111111111111111111111111112",
};
const NOW = new Date("2026-08-31T02:30:00.000Z");

describe("create_match invocation plan", () => {
  it("uses the Anchor account order and only the program-derived escrow ATA", () => {
    const terms = createPaidMatchTerms({
      usdcMint: NATIVE_USDC_MINT,
      escrowProgramId: PROGRAM_ID,
      now: NOW,
      fundingDeadline: new Date("2026-08-31T02:35:00.000Z"),
    });
    const plan = createEscrowCreateMatchInvocationPlan({ terms, roles: ROLES, escrowProgramId: PROGRAM_ID });

    expect(plan.programId).toBe(PROGRAM_ID);
    expect(plan.data).toEqual(serializeCreateMatchInstructionData(plan.arguments));
    expect(plan.accounts).toEqual([
      { address: ROLES.matchController, isSigner: true, isWritable: true },
      { address: plan.addresses.platformConfigAddress, isSigner: false, isWritable: false },
      { address: plan.addresses.matchEscrowAddress, isSigner: false, isWritable: true },
      { address: NATIVE_USDC_MINT, isSigner: false, isWritable: false },
      { address: terms.escrowAddress, isSigner: false, isWritable: true },
      { address: "11111111111111111111111111111111", isSigner: false, isWritable: false },
      { address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", isSigner: false, isWritable: false },
      { address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", isSigner: false, isWritable: false },
    ]);
  });

  it("fails closed if stored terms or deployment identity select another escrow", () => {
    const terms = createPaidMatchTerms({ usdcMint: NATIVE_USDC_MINT, escrowProgramId: PROGRAM_ID, now: NOW });
    expect(() => createEscrowCreateMatchInvocationPlan({
      terms: { ...terms, escrowAddress: "9xQeWvG816bUx9EPfEZgC3Jk6zR9aM2Qq8F4JZ2xAazC" },
      roles: ROLES,
      escrowProgramId: PROGRAM_ID,
    })).toThrow("do not match the escrow program-derived token account");
    expect(() => createEscrowCreateMatchInvocationPlan({
      terms,
      roles: ROLES,
      escrowProgramId: "Vote111111111111111111111111111111111111111",
    })).toThrow("do not match the escrow program-derived token account");
  });
});
