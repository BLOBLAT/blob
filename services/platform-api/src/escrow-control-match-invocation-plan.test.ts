import { describe, expect, it } from "vitest";
import { EscrowControlMatchInstruction, serializeEscrowControlMatchInstructionData } from "./escrow-control-match-abi.js";
import {
  createEscrowCancelMatchInvocationPlan,
  createEscrowExpireFundingInvocationPlan,
  createEscrowStartMatchInvocationPlan
} from "./escrow-control-match-invocation-plan.js";
import { createPaidMatchTerms } from "./paid-match.js";

const PROGRAM_ID = "Stake11111111111111111111111111111111111111";
const NATIVE_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CONTROLLER = "7YttLkH3UQJfB73uExyGfEKvwR6LjhQmN6x2PRZKMrP2";
const NOW = new Date("2026-08-31T02:30:00.000Z");

describe("escrow funding-lifecycle invocation plans", () => {
  it("locks exact Anchor instruction bytes and accounts without creating a transaction", () => {
    const terms = createPaidMatchTerms({ usdcMint: NATIVE_USDC_MINT, escrowProgramId: PROGRAM_ID, now: NOW });
    const start = createEscrowStartMatchInvocationPlan({ terms, escrowProgramId: PROGRAM_ID, controllerAddress: CONTROLLER });
    const cancel = createEscrowCancelMatchInvocationPlan({ terms, escrowProgramId: PROGRAM_ID, controllerAddress: CONTROLLER });
    const expire = createEscrowExpireFundingInvocationPlan({ terms, escrowProgramId: PROGRAM_ID });

    expect(start.instruction).toBe(EscrowControlMatchInstruction.START);
    expect(start.data.toString("hex")).toBe("64f6dfb5b065ff13");
    expect(start.data).toEqual(serializeEscrowControlMatchInstructionData(EscrowControlMatchInstruction.START));
    expect(start.accounts).toEqual([
      { address: CONTROLLER, isSigner: true, isWritable: false },
      { address: start.matchAddresses.matchEscrowAddress, isSigner: false, isWritable: true },
    ]);

    expect(cancel.instruction).toBe(EscrowControlMatchInstruction.CANCEL);
    expect(cancel.data.toString("hex")).toBe("8e88f72d5c70b453");
    expect(cancel.data).toEqual(serializeEscrowControlMatchInstructionData(EscrowControlMatchInstruction.CANCEL));
    expect(cancel.accounts).toEqual(start.accounts);

    expect(expire.instruction).toBe(EscrowControlMatchInstruction.EXPIRE_FUNDING);
    expect(expire.data.toString("hex")).toBe("f4d219b901a70759");
    expect(expire.data).toEqual(serializeEscrowControlMatchInstructionData(EscrowControlMatchInstruction.EXPIRE_FUNDING));
    expect(expire.accounts).toEqual([
      { address: expire.matchAddresses.matchEscrowAddress, isSigner: false, isWritable: true },
    ]);
  });

  it("fails closed when immutable terms do not select the derived escrow account", () => {
    const terms = createPaidMatchTerms({ usdcMint: NATIVE_USDC_MINT, escrowProgramId: PROGRAM_ID, now: NOW });
    expect(() => createEscrowStartMatchInvocationPlan({
      terms: { ...terms, escrowAddress: "9xQeWvG816bUx9EPfEZgC3Jk6zR9aM2Qq8F4JZ2xAazC" },
      escrowProgramId: PROGRAM_ID,
      controllerAddress: CONTROLLER,
    })).toThrow("do not match the escrow program-derived token account");
  });
});
