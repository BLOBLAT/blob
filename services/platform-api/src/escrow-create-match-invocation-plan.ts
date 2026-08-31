import {
  canonicalSolanaPublicKey,
  deriveEscrowAddressPlan,
  type EscrowAddressPlan
} from "./escrow-address.js";
import { serializeCreateMatchInstructionData } from "./escrow-create-match-abi.js";
import {
  createEscrowCreateMatchPlan,
  type EscrowAuthorityRoles,
  type EscrowCreateMatchPlan
} from "./escrow-instruction-plan.js";
import type { PaidMatchTerms } from "./paid-match.js";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const LEGACY_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export interface EscrowAccountMetaPlan {
  address: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface EscrowCreateMatchInvocationPlan {
  programId: string;
  accounts: readonly EscrowAccountMetaPlan[];
  data: Buffer;
  addresses: EscrowAddressPlan;
  arguments: EscrowCreateMatchPlan;
}

/**
 * Resolves the exact checked-in Anchor `create_match` account order and Borsh
 * data. This is an auditable server-side plan, not a web3 Transaction or
 * instruction object: it cannot sign, prompt a wallet, submit an RPC request,
 * or create a match by itself.
 */
export function createEscrowCreateMatchInvocationPlan(input: {
  terms: PaidMatchTerms;
  roles: EscrowAuthorityRoles;
  escrowProgramId: string;
}): EscrowCreateMatchInvocationPlan {
  const programId = canonicalSolanaPublicKey(input.escrowProgramId, "escrow program ID");
  const addresses = deriveEscrowAddressPlan({
    programId,
    matchId: input.terms.matchId,
    nativeUsdcMint: input.terms.usdcMint,
  });
  if (input.terms.escrowAddress !== addresses.escrowTokenAccountAddress) {
    throw new EscrowCreateMatchInvocationPlanError(
      "ESCROW_ADDRESS_MISMATCH",
      "Persisted match terms do not match the escrow program-derived token account."
    );
  }
  const argumentsPlan = createEscrowCreateMatchPlan(input.terms, input.roles);
  const controller = canonicalSolanaPublicKey(input.roles.matchController, "match controller");

  return {
    programId,
    arguments: argumentsPlan,
    addresses,
    data: serializeCreateMatchInstructionData(argumentsPlan),
    accounts: [
      { address: controller, isSigner: true, isWritable: true },
      { address: addresses.platformConfigAddress, isSigner: false, isWritable: false },
      { address: addresses.matchEscrowAddress, isSigner: false, isWritable: true },
      { address: canonicalSolanaPublicKey(input.terms.usdcMint, "native USDC mint"), isSigner: false, isWritable: false },
      { address: addresses.escrowTokenAccountAddress, isSigner: false, isWritable: true },
      { address: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { address: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { address: LEGACY_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  };
}

export class EscrowCreateMatchInvocationPlanError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
