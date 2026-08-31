import {
  canonicalSolanaPublicKey,
  deriveEscrowAddressPlan,
  type EscrowAddressPlan
} from "./escrow-address.js";
import type { EscrowAccountMetaPlan } from "./escrow-create-match-invocation-plan.js";
import {
  EscrowControlMatchInstruction,
  serializeEscrowControlMatchInstructionData
} from "./escrow-control-match-abi.js";
import type { PaidMatchTerms } from "./paid-match.js";

export interface EscrowControlMatchInvocationPlan {
  programId: string;
  instruction: EscrowControlMatchInstruction;
  accounts: readonly EscrowAccountMetaPlan[];
  data: Buffer;
  matchAddresses: EscrowAddressPlan;
}

/**
 * Resolves exact checked-in Anchor account plans for the funding lifecycle.
 * Start and cancel require the configured controller; funding expiry is
 * deliberately permissionless and therefore has no signer. Each function
 * emits public addresses and bytes only, never an executable transaction.
 */
export function createEscrowStartMatchInvocationPlan(input: {
  terms: PaidMatchTerms;
  escrowProgramId: string;
  controllerAddress: string;
}): EscrowControlMatchInvocationPlan {
  return createControllerPlan({ ...input, instruction: EscrowControlMatchInstruction.START });
}

export function createEscrowCancelMatchInvocationPlan(input: {
  terms: PaidMatchTerms;
  escrowProgramId: string;
  controllerAddress: string;
}): EscrowControlMatchInvocationPlan {
  return createControllerPlan({ ...input, instruction: EscrowControlMatchInstruction.CANCEL });
}

export function createEscrowExpireFundingInvocationPlan(input: {
  terms: PaidMatchTerms;
  escrowProgramId: string;
}): EscrowControlMatchInvocationPlan {
  const { programId, matchAddresses } = deriveMatchAddresses(input.terms, input.escrowProgramId);
  return {
    programId,
    instruction: EscrowControlMatchInstruction.EXPIRE_FUNDING,
    matchAddresses,
    data: serializeEscrowControlMatchInstructionData(EscrowControlMatchInstruction.EXPIRE_FUNDING),
    accounts: [{ address: matchAddresses.matchEscrowAddress, isSigner: false, isWritable: true }],
  };
}

function createControllerPlan(input: {
  terms: PaidMatchTerms;
  escrowProgramId: string;
  controllerAddress: string;
  instruction: EscrowControlMatchInstruction.START | EscrowControlMatchInstruction.CANCEL;
}): EscrowControlMatchInvocationPlan {
  const { programId, matchAddresses } = deriveMatchAddresses(input.terms, input.escrowProgramId);
  const controller = canonicalSolanaPublicKey(input.controllerAddress, "match controller");
  return {
    programId,
    instruction: input.instruction,
    matchAddresses,
    data: serializeEscrowControlMatchInstructionData(input.instruction),
    accounts: [
      { address: controller, isSigner: true, isWritable: false },
      { address: matchAddresses.matchEscrowAddress, isSigner: false, isWritable: true },
    ],
  };
}

function deriveMatchAddresses(terms: PaidMatchTerms, escrowProgramId: string): {
  programId: string;
  matchAddresses: EscrowAddressPlan;
} {
  const programId = canonicalSolanaPublicKey(escrowProgramId, "escrow program ID");
  const matchAddresses = deriveEscrowAddressPlan({
    programId,
    matchId: terms.matchId,
    nativeUsdcMint: terms.usdcMint,
  });
  if (terms.escrowAddress !== matchAddresses.escrowTokenAccountAddress) {
    throw new EscrowControlMatchInvocationPlanError(
      "ESCROW_ADDRESS_MISMATCH",
      "Persisted match terms do not match the escrow program-derived token account."
    );
  }
  return { programId, matchAddresses };
}

export class EscrowControlMatchInvocationPlanError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
