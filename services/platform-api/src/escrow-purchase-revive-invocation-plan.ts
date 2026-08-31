import type { PaidDeathEvent } from "@blob/shared";
import {
  canonicalSolanaPublicKey,
  deriveEscrowAddressPlan,
  deriveEscrowReviveAddressPlan,
  type EscrowAddressPlan,
  type EscrowReviveAddressPlan
} from "./escrow-address.js";
import type { EscrowAccountMetaPlan } from "./escrow-create-match-invocation-plan.js";
import { serializePurchaseReviveInstructionData } from "./escrow-purchase-revive-abi.js";
import type { PaidMatchTerms } from "./paid-match.js";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const LEGACY_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export interface EscrowPurchaseReviveInvocationPlan {
  programId: string;
  accounts: readonly EscrowAccountMetaPlan[];
  data: Buffer;
  matchAddresses: EscrowAddressPlan;
  reviveAddresses: EscrowReviveAddressPlan;
  deathAtUnixSeconds: bigint;
}

/**
 * Builds a bounded account-and-byte plan for one verified Rebuy death. The
 * server must supply both the player identity and the match's independent
 * result authority. The plan itself is inert: it cannot request signatures,
 * create a transaction, contact an RPC, or move native USDC.
 */
export function createEscrowPurchaseReviveInvocationPlan(input: {
  terms: PaidMatchTerms;
  escrowProgramId: string;
  player: { playerId: string; walletAddress: string };
  death: PaidDeathEvent;
  resultAuthority: string;
}): EscrowPurchaseReviveInvocationPlan {
  if (!input.terms.reviveConfiguration.enabled) {
    throw new EscrowPurchaseReviveInvocationPlanError("REVIVE_DISABLED", "This match's immutable rules do not permit a paid revive.");
  }
  if (input.death.matchId !== input.terms.matchId
    || input.death.roundId !== input.terms.roundId
    || input.death.playerId !== input.player.playerId) {
    throw new EscrowPurchaseReviveInvocationPlanError("DEATH_MISMATCH", "The authoritative death does not belong to this paid player and match.");
  }
  const deathAtUnixSeconds = dateToExactUnixSeconds(input.death.diedAt);
  const programId = canonicalSolanaPublicKey(input.escrowProgramId, "escrow program ID");
  const matchAddresses = deriveEscrowAddressPlan({
    programId,
    matchId: input.terms.matchId,
    nativeUsdcMint: input.terms.usdcMint,
  });
  if (input.terms.escrowAddress !== matchAddresses.escrowTokenAccountAddress) {
    throw new EscrowPurchaseReviveInvocationPlanError(
      "ESCROW_ADDRESS_MISMATCH",
      "Persisted match terms do not match the escrow program-derived token account."
    );
  }
  const player = canonicalSolanaPublicKey(input.player.walletAddress, "player wallet address");
  const resultAuthority = canonicalSolanaPublicKey(input.resultAuthority, "result authority");
  const reviveAddresses = deriveEscrowReviveAddressPlan({
    programId,
    matchEscrowAddress: matchAddresses.matchEscrowAddress,
    playerAddress: player,
    nativeUsdcMint: input.terms.usdcMint,
    deathId: input.death.deathId,
  });

  return {
    programId,
    matchAddresses,
    reviveAddresses,
    deathAtUnixSeconds,
    data: serializePurchaseReviveInstructionData({
      deathIdHash: reviveAddresses.deathIdHash,
      deathAtUnixSeconds,
    }),
    accounts: [
      { address: player, isSigner: true, isWritable: true },
      { address: resultAuthority, isSigner: true, isWritable: false },
      { address: matchAddresses.matchEscrowAddress, isSigner: false, isWritable: true },
      { address: reviveAddresses.entryAddress, isSigner: false, isWritable: true },
      { address: reviveAddresses.reviveReceiptAddress, isSigner: false, isWritable: true },
      { address: canonicalSolanaPublicKey(input.terms.usdcMint, "native USDC mint"), isSigner: false, isWritable: false },
      { address: reviveAddresses.playerTokenAccountAddress, isSigner: false, isWritable: true },
      { address: matchAddresses.escrowTokenAccountAddress, isSigner: false, isWritable: true },
      { address: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { address: LEGACY_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  };
}

function dateToExactUnixSeconds(value: Date): bigint {
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime()) || value.getMilliseconds() !== 0) {
    throw new EscrowPurchaseReviveInvocationPlanError("DEATH_TIME_INVALID", "The authoritative death time must have whole-second precision.");
  }
  return BigInt(value.getTime() / 1_000);
}

export class EscrowPurchaseReviveInvocationPlanError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
