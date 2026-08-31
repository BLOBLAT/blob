import { createHash } from "node:crypto";

export enum EscrowPlayerClaimInstruction {
  REFUND = "REFUND",
  PARTICIPATION_REBATE = "PARTICIPATION_REBATE",
}

const ANCHOR_INSTRUCTION_NAMES: Readonly<Record<EscrowPlayerClaimInstruction, string>> = {
  [EscrowPlayerClaimInstruction.REFUND]: "claim_refund",
  [EscrowPlayerClaimInstruction.PARTICIPATION_REBATE]: "claim_participation_rebate",
};

/**
 * Returns the complete data payload for a zero-argument player pull claim.
 * It is byte planning only: no browser prompt, signer, transaction, RPC, or
 * token transfer can result from this helper.
 */
export function serializeEscrowPlayerClaimInstructionData(instruction: EscrowPlayerClaimInstruction): Buffer {
  const instructionName = ANCHOR_INSTRUCTION_NAMES[instruction];
  if (!instructionName) {
    throw new EscrowPlayerClaimAbiError("INSTRUCTION_INVALID", "The escrow player claim instruction is invalid.");
  }
  return createHash("sha256")
    .update("global:" + instructionName, "utf8")
    .digest()
    .subarray(0, 8);
}

export class EscrowPlayerClaimAbiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
