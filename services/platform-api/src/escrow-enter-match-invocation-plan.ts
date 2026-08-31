import {
  canonicalSolanaPublicKey,
  deriveEscrowAddressPlan,
  deriveEscrowEntryAddressPlan,
  type EscrowAddressPlan,
  type EscrowEntryAddressPlan
} from "./escrow-address.js";
import type { EscrowAccountMetaPlan } from "./escrow-create-match-invocation-plan.js";
import { serializeEnterMatchInstructionData } from "./escrow-enter-match-abi.js";
import type { PaidMatchTerms } from "./paid-match.js";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const LEGACY_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export interface EscrowEnterMatchInvocationPlan {
  programId: string;
  accounts: readonly EscrowAccountMetaPlan[];
  data: Buffer;
  matchAddresses: EscrowAddressPlan;
  entryAddresses: EscrowEntryAddressPlan;
}

/**
 * Resolves the exact checked-in Anchor `enter_match` account order for a
 * Wallet Standard client. The player remains the only signer and the source
 * account is the player's standard native-USDC ATA. This function plans
 * bytes and public addresses only; it cannot submit, sign, or transfer USDC.
 */
export function createEscrowEnterMatchInvocationPlan(input: {
  terms: PaidMatchTerms;
  escrowProgramId: string;
  playerAddress: string;
}): EscrowEnterMatchInvocationPlan {
  const programId = canonicalSolanaPublicKey(input.escrowProgramId, "escrow program ID");
  const matchAddresses = deriveEscrowAddressPlan({
    programId,
    matchId: input.terms.matchId,
    nativeUsdcMint: input.terms.usdcMint,
  });
  if (input.terms.escrowAddress !== matchAddresses.escrowTokenAccountAddress) {
    throw new EscrowEnterMatchInvocationPlanError(
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
    matchAddresses,
    entryAddresses,
    data: serializeEnterMatchInstructionData(),
    accounts: [
      { address: player, isSigner: true, isWritable: true },
      { address: matchAddresses.matchEscrowAddress, isSigner: false, isWritable: true },
      { address: entryAddresses.entryAddress, isSigner: false, isWritable: true },
      { address: canonicalSolanaPublicKey(input.terms.usdcMint, "native USDC mint"), isSigner: false, isWritable: false },
      { address: entryAddresses.playerTokenAccountAddress, isSigner: false, isWritable: true },
      { address: matchAddresses.escrowTokenAccountAddress, isSigner: false, isWritable: true },
      { address: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { address: LEGACY_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  };
}

export class EscrowEnterMatchInvocationPlanError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
