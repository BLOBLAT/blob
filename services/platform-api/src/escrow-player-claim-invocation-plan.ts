import {
  canonicalSolanaPublicKey,
  deriveEscrowAddressPlan,
  deriveEscrowEntryAddressPlan,
  type EscrowAddressPlan,
  type EscrowEntryAddressPlan
} from "./escrow-address.js";
import type { EscrowAccountMetaPlan } from "./escrow-create-match-invocation-plan.js";
import {
  EscrowPlayerClaimInstruction,
  serializeEscrowPlayerClaimInstructionData
} from "./escrow-player-claim-abi.js";
import type { PaidMatchTerms } from "./paid-match.js";

const LEGACY_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export interface EscrowPlayerClaimInvocationPlan {
  programId: string;
  instruction: EscrowPlayerClaimInstruction;
  accounts: readonly EscrowAccountMetaPlan[];
  data: Buffer;
  matchAddresses: EscrowAddressPlan;
  entryAddresses: EscrowEntryAddressPlan;
}

/**
 * Builds a player-owned pull-claim plan. The escrow program, not the browser
 * or this helper, decides whether the lifecycle permits the requested refund
 * or non-podium participation rebate and calculates the exact amount.
 */
export function createEscrowClaimRefundInvocationPlan(input: {
  terms: PaidMatchTerms;
  escrowProgramId: string;
  playerAddress: string;
}): EscrowPlayerClaimInvocationPlan {
  return createPlayerClaimPlan({ ...input, instruction: EscrowPlayerClaimInstruction.REFUND });
}

export function createEscrowClaimParticipationRebateInvocationPlan(input: {
  terms: PaidMatchTerms;
  escrowProgramId: string;
  playerAddress: string;
}): EscrowPlayerClaimInvocationPlan {
  return createPlayerClaimPlan({ ...input, instruction: EscrowPlayerClaimInstruction.PARTICIPATION_REBATE });
}

function createPlayerClaimPlan(input: {
  terms: PaidMatchTerms;
  escrowProgramId: string;
  playerAddress: string;
  instruction: EscrowPlayerClaimInstruction;
}): EscrowPlayerClaimInvocationPlan {
  const programId = canonicalSolanaPublicKey(input.escrowProgramId, "escrow program ID");
  const matchAddresses = deriveEscrowAddressPlan({
    programId,
    matchId: input.terms.matchId,
    nativeUsdcMint: input.terms.usdcMint,
  });
  if (input.terms.escrowAddress !== matchAddresses.escrowTokenAccountAddress) {
    throw new EscrowPlayerClaimInvocationPlanError(
      "ESCROW_ADDRESS_MISMATCH",
      "Persisted match terms do not match the escrow program-derived token account."
    );
  }
  const player = canonicalSolanaPublicKey(input.playerAddress, "player wallet address");
  const entryAddresses = deriveEscrowEntryAddressPlan({
    programId,
    matchEscrowAddress: matchAddresses.matchEscrowAddress,
    playerAddress: player,
    nativeUsdcMint: input.terms.usdcMint,
  });
  return {
    programId,
    instruction: input.instruction,
    matchAddresses,
    entryAddresses,
    data: serializeEscrowPlayerClaimInstructionData(input.instruction),
    accounts: [
      { address: player, isSigner: true, isWritable: true },
      { address: matchAddresses.matchEscrowAddress, isSigner: false, isWritable: true },
      { address: entryAddresses.entryAddress, isSigner: false, isWritable: true },
      { address: canonicalSolanaPublicKey(input.terms.usdcMint, "native USDC mint"), isSigner: false, isWritable: false },
      { address: entryAddresses.playerTokenAccountAddress, isSigner: false, isWritable: true },
      { address: matchAddresses.escrowTokenAccountAddress, isSigner: false, isWritable: true },
      { address: LEGACY_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  };
}

export class EscrowPlayerClaimInvocationPlanError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
