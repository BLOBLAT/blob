import { createHash } from "node:crypto";

export enum EscrowControlMatchInstruction {
  START = "START",
  CANCEL = "CANCEL",
  EXPIRE_FUNDING = "EXPIRE_FUNDING",
}

const ANCHOR_INSTRUCTION_NAMES: Readonly<Record<EscrowControlMatchInstruction, string>> = {
  [EscrowControlMatchInstruction.START]: "start_match",
  [EscrowControlMatchInstruction.CANCEL]: "cancel_match",
  [EscrowControlMatchInstruction.EXPIRE_FUNDING]: "expire_funding",
};

/**
 * Serializes one of the zero-argument Anchor funding-lifecycle instructions.
 * The result is instruction data only: this module has no RPC, wallet,
 * transaction, signer, or token-transfer capability.
 */
export function serializeEscrowControlMatchInstructionData(instruction: EscrowControlMatchInstruction): Buffer {
  const instructionName = ANCHOR_INSTRUCTION_NAMES[instruction];
  if (!instructionName) {
    throw new EscrowControlMatchAbiError("INSTRUCTION_INVALID", "The escrow funding-lifecycle instruction is invalid.");
  }
  return createHash("sha256")
    .update("global:" + instructionName, "utf8")
    .digest()
    .subarray(0, 8);
}

export class EscrowControlMatchAbiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
