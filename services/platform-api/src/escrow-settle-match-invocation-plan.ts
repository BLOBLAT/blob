import { SettlementPayoutKind, type AuthoritativeMatchResult } from "@blob/shared";
import {
  canonicalSolanaPublicKey,
  deriveAssociatedTokenAccountAddress,
  deriveEscrowAddressPlan,
  deriveEscrowEntryAddressPlan,
  type EscrowAddressPlan,
  type EscrowEntryAddressPlan
} from "./escrow-address.js";
import type { EscrowAccountMetaPlan } from "./escrow-create-match-invocation-plan.js";
import { serializeSettleMatchInstructionData } from "./escrow-settle-match-abi.js";
import {
  finalizePaidMatch,
  type ConfirmedRevive,
  type FinalizedPaidMatch,
  type PaidMatchTerms,
  type VerifiedParticipant
} from "./paid-match.js";

const LEGACY_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WINNER_COUNT = 3;

interface WinnerAccountPlan {
  playerId: string;
  playerAddress: string;
  entryAddresses: EscrowEntryAddressPlan;
}

export interface EscrowSettleMatchInvocationPlan {
  programId: string;
  accounts: readonly EscrowAccountMetaPlan[];
  data: Buffer;
  matchAddresses: EscrowAddressPlan;
  finalized: FinalizedPaidMatch;
  winners: readonly WinnerAccountPlan[];
  treasuryTokenAccountAddress: string;
}

/**
 * Produces a complete, auditable account plan for Anchor `settle_match` from
 * a freshly finalized server result. Winners are selected solely from the
 * authoritative rank result; each destination is the holder's standard
 * native-USDC ATA. The result authority is the sole signer. This function is
 * deliberately data-only: it cannot invoke a wallet, sign, send RPC, or move
 * USDC.
 */
export function createEscrowSettleMatchInvocationPlan(input: {
  terms: PaidMatchTerms;
  result: AuthoritativeMatchResult;
  verifiedParticipants: readonly VerifiedParticipant[];
  confirmedRevives: readonly ConfirmedRevive[];
  escrowProgramId: string;
  resultAuthority: string;
  treasury: string;
  settlementId?: string;
}): EscrowSettleMatchInvocationPlan {
  const finalized = finalizePaidMatch({
    terms: input.terms,
    result: input.result,
    verifiedParticipants: input.verifiedParticipants,
    confirmedRevives: input.confirmedRevives,
    settlementId: input.settlementId,
  });
  const programId = canonicalSolanaPublicKey(input.escrowProgramId, "escrow program ID");
  const matchAddresses = deriveEscrowAddressPlan({
    programId,
    matchId: input.terms.matchId,
    nativeUsdcMint: input.terms.usdcMint,
  });
  if (input.terms.escrowAddress !== matchAddresses.escrowTokenAccountAddress) {
    throw new EscrowSettleMatchInvocationPlanError(
      "ESCROW_ADDRESS_MISMATCH",
      "Persisted match terms do not match the escrow program-derived token account."
    );
  }

  const participantWallets = new Map<string, string>();
  for (const participant of input.verifiedParticipants) {
    if (participantWallets.has(participant.playerId)) {
      throw new EscrowSettleMatchInvocationPlanError("PARTICIPANT_DUPLICATE", "A participant cannot receive more than one settlement destination.");
    }
    participantWallets.set(
      participant.playerId,
      canonicalSolanaPublicKey(participant.walletAddress, "participant wallet address")
    );
  }
  const winners = resolveWinners({
    finalized,
    participantWallets,
    programId,
    matchEscrowAddress: matchAddresses.matchEscrowAddress,
    nativeUsdcMint: input.terms.usdcMint,
  });
  const resultAuthority = canonicalSolanaPublicKey(input.resultAuthority, "result authority");
  const treasury = canonicalSolanaPublicKey(input.treasury, "treasury authority");
  const treasuryTokenAccountAddress = deriveAssociatedTokenAccountAddress({
    ownerAddress: treasury,
    nativeUsdcMint: input.terms.usdcMint,
  });

  return {
    programId,
    matchAddresses,
    finalized,
    winners,
    treasuryTokenAccountAddress,
    data: serializeSettleMatchInstructionData(finalized.immutableResultHash),
    accounts: [
      { address: resultAuthority, isSigner: true, isWritable: false },
      { address: matchAddresses.matchEscrowAddress, isSigner: false, isWritable: true },
      { address: canonicalSolanaPublicKey(input.terms.usdcMint, "native USDC mint"), isSigner: false, isWritable: false },
      { address: matchAddresses.escrowTokenAccountAddress, isSigner: false, isWritable: true },
      { address: treasuryTokenAccountAddress, isSigner: false, isWritable: true },
      { address: winners[0]!.entryAddresses.entryAddress, isSigner: false, isWritable: true },
      { address: winners[0]!.entryAddresses.playerTokenAccountAddress, isSigner: false, isWritable: true },
      { address: winners[1]!.entryAddresses.entryAddress, isSigner: false, isWritable: true },
      { address: winners[1]!.entryAddresses.playerTokenAccountAddress, isSigner: false, isWritable: true },
      { address: winners[2]!.entryAddresses.entryAddress, isSigner: false, isWritable: true },
      { address: winners[2]!.entryAddresses.playerTokenAccountAddress, isSigner: false, isWritable: true },
      { address: LEGACY_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  };
}

function resolveWinners(input: {
  finalized: FinalizedPaidMatch;
  participantWallets: ReadonlyMap<string, string>;
  programId: string;
  matchEscrowAddress: string;
  nativeUsdcMint: string;
}): readonly WinnerAccountPlan[] {
  const payouts = input.finalized.settlementRequest.payoutPlan
    .filter((payout) => payout.kind === SettlementPayoutKind.PRIZE)
    .sort((left, right) => left.finalRank - right.finalRank);
  if (payouts.length !== WINNER_COUNT || payouts.some((payout, index) => payout.finalRank !== index + 1 || payout.place !== index + 1)) {
    throw new EscrowSettleMatchInvocationPlanError("WINNERS_INVALID", "Settlement must contain exactly ranks one through three as winners.");
  }
  const playerIds = new Set<string>();
  return payouts.map((payout) => {
    const playerAddress = input.participantWallets.get(payout.playerId);
    if (!playerAddress || playerIds.has(payout.playerId)) {
      throw new EscrowSettleMatchInvocationPlanError("WINNERS_INVALID", "Every winner must be one distinct verified participant.");
    }
    playerIds.add(payout.playerId);
    return {
      playerId: payout.playerId,
      playerAddress,
      entryAddresses: deriveEscrowEntryAddressPlan({
        programId: input.programId,
        matchEscrowAddress: input.matchEscrowAddress,
        playerAddress,
        nativeUsdcMint: input.nativeUsdcMint,
      }),
    };
  });
}

export class EscrowSettleMatchInvocationPlanError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
