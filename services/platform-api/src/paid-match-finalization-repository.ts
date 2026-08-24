import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import {
  finalizePaidMatch,
  type ConfirmedRevive,
  type FinalizedPaidMatch,
  type PaidMatchTerms,
  type VerifiedParticipant,
} from "./paid-match.js";
import type { AuthoritativeMatchResult } from "@blob/shared";

export interface PersistPaidMatchFinalizationInput {
  terms: PaidMatchTerms;
  result: AuthoritativeMatchResult;
  verifiedParticipants: readonly VerifiedParticipant[];
  confirmedRevives: readonly ConfirmedRevive[];
  settlementId?: string;
}

export interface PersistedPaidMatchFinalization {
  created: boolean;
  resultId: string;
  immutableResultHash: string;
  settlementId: string;
}

/**
 * Raised when durable paid-match records disagree with the already-frozen
 * terms or result. It deliberately never initiates a transfer: an escrow or
 * independently controlled settlement adapter must consume this record later.
 */
export class PaidMatchPersistenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Persists a frozen, server-produced Paid Match result and its exact payout
 * plan in one database transaction. This class has no HTTP route and no
 * browser caller while Paid Mode remains disabled.
 */
export class PrismaPaidMatchFinalizationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async persist(input: PersistPaidMatchFinalizationInput): Promise<PersistedPaidMatchFinalization> {
    const finalized = finalizePaidMatch(input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.persistOnce(input, finalized);
      } catch (error) {
        // PostgreSQL may abort one of two concurrent serializable result
        // writes. Retrying once makes identical finalization idempotent; a
        // divergent retry then observes the immutable stored result and fails
        // with RESULT_IMMUTABLE_CONFLICT below.
        if (attempt === 0 && isSerializationConflict(error)) {
          continue;
        }
        throw error;
      }
    }
    throw new PaidMatchPersistenceError("FINALIZATION_RETRY_EXHAUSTED", "Could not persist the immutable paid result.");
  }

  private async persistOnce(
    input: PersistPaidMatchFinalizationInput,
    finalized: FinalizedPaidMatch,
  ): Promise<PersistedPaidMatchFinalization> {
    return this.prisma.$transaction(async (transaction) => {
      const match = await transaction.match.findUnique({
        where: { id: input.terms.matchId },
        select: {
          id: true,
          roundId: true,
          status: true,
          ruleset: true,
          rulesVersion: true,
          rulesHash: true,
          settlementAsset: true,
          usdcMint: true,
          entryAmountBaseUnits: true,
          reviveAmountBaseUnits: true,
          maxRevivesPerPlayer: true,
          reviveWindowMs: true,
          reviveCutoffMs: true,
          reviveSpawnProtectionMs: true,
          platformFeeBps: true,
          payoutBps: true,
          minimumPlayers: true,
          maximumPlayers: true,
          roundDurationMs: true,
          fundingDeadline: true,
          escrowAddress: true,
        }
      });
      if (!match) {
        throw new PaidMatchPersistenceError("MATCH_NOT_FOUND", "Paid match terms have not been durably created.");
      }
      assertStoredTermsMatch(input.terms, match);

      const existingResult = await transaction.matchResult.findUnique({
        where: { matchId: input.terms.matchId },
        select: { id: true, roundId: true, rulesHash: true, resultHash: true }
      });
      if (existingResult) {
        return this.reuseExistingFinalization(transaction, existingResult, finalized, input);
      }
      if (match.status !== "LIVE" && match.status !== "FINALIZING") {
        throw new PaidMatchPersistenceError("MATCH_NOT_FINALIZABLE", "Paid match is not in a finalizable lifecycle state.");
      }

      const entriesByPlayer = await loadVerifiedEntries(transaction, input.terms, input.verifiedParticipants);
      const resultRecord = await transaction.matchResult.create({
        data: {
          matchId: input.terms.matchId,
          roundId: input.terms.roundId,
          rulesHash: input.terms.rulesHash,
          resultHash: finalized.immutableResultHash,
          resultPayload: toStoredResultPayload(finalized),
          finalizedAt: input.result.resultTimestamp,
        },
        select: { id: true }
      });
      await transaction.settlementAttempt.create({
        data: {
          matchId: input.terms.matchId,
          resultId: resultRecord.id,
          resultHash: finalized.immutableResultHash,
          settlementId: finalized.settlementRequest.settlementId,
          idempotencyKey: finalized.settlementRequest.idempotencyKey,
        }
      });
      await transaction.payout.createMany({
        data: finalized.prizes.payouts.map((payout) => {
          const rankedPlayer = input.result.players.find((player) => player.finalRank === payout.place);
          const entry = rankedPlayer ? entriesByPlayer.get(rankedPlayer.playerId) : undefined;
          if (!rankedPlayer || !entry) {
            throw new PaidMatchPersistenceError("PAYOUT_BINDING_INVALID", "A prize winner is not a verified paid entry.");
          }
          return {
            matchId: input.terms.matchId,
            resultId: resultRecord.id,
            entryId: entry.id,
            place: payout.place,
            amountBaseUnits: payout.amountBaseUnits,
            idempotencyKey: "payout:" + input.terms.matchId + ":" + finalized.immutableResultHash + ":" + payout.place,
          };
        })
      });
      await transaction.match.update({
        where: { id: input.terms.matchId },
        data: { status: "FINALIZING", endsAt: input.result.resultTimestamp }
      });
      await transaction.auditEvent.create({
        data: {
          userId: null,
          action: "paid_match_result_finalized",
          entityType: "match",
          entityId: input.terms.matchId,
          metadata: {
            resultHash: finalized.immutableResultHash,
            settlementId: finalized.settlementRequest.settlementId,
          }
        }
      });
      return {
        created: true,
        resultId: resultRecord.id,
        immutableResultHash: finalized.immutableResultHash,
        settlementId: finalized.settlementRequest.settlementId,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async reuseExistingFinalization(
    transaction: Prisma.TransactionClient,
    existingResult: { id: string; roundId: string; rulesHash: string; resultHash: string },
    finalized: FinalizedPaidMatch,
    input: PersistPaidMatchFinalizationInput,
  ): Promise<PersistedPaidMatchFinalization> {
    const { terms } = input;
    if (existingResult.roundId !== terms.roundId
      || existingResult.rulesHash !== terms.rulesHash
      || existingResult.resultHash !== finalized.immutableResultHash) {
      throw new PaidMatchPersistenceError("RESULT_IMMUTABLE_CONFLICT", "A different immutable result already exists for this paid match.");
    }
    const attempt = await transaction.settlementAttempt.findUnique({
      where: { matchId: terms.matchId },
      select: { resultId: true, resultHash: true, settlementId: true, idempotencyKey: true }
    });
    if (!attempt
      || attempt.resultId !== existingResult.id
      || attempt.resultHash !== finalized.immutableResultHash
      || attempt.settlementId !== finalized.settlementRequest.settlementId
      || attempt.idempotencyKey !== finalized.settlementRequest.idempotencyKey) {
      throw new PaidMatchPersistenceError("SETTLEMENT_RECORD_CONFLICT", "The durable settlement record does not match the immutable result.");
    }
    const entriesByPlayer = await loadVerifiedEntries(transaction, terms, input.verifiedParticipants);
    const expectedPayouts = finalized.prizes.payouts.map((payout) => {
      const rankedPlayer = input.result.players.find((player) => player.finalRank === payout.place);
      const entry = rankedPlayer ? entriesByPlayer.get(rankedPlayer.playerId) : undefined;
      if (!rankedPlayer || !entry) {
        throw new PaidMatchPersistenceError("PAYOUT_BINDING_INVALID", "A prize winner is not a verified paid entry.");
      }
      return {
        entryId: entry.id,
        place: payout.place,
        amountBaseUnits: payout.amountBaseUnits,
        idempotencyKey: "payout:" + terms.matchId + ":" + finalized.immutableResultHash + ":" + payout.place,
      };
    });
    const storedPayouts = await transaction.payout.findMany({
      where: { resultId: existingResult.id },
      select: { entryId: true, place: true, amountBaseUnits: true, idempotencyKey: true }
    });
    const storedPayoutsByPlace = new Map(storedPayouts.map((payout) => [payout.place, payout]));
    if (storedPayouts.length !== expectedPayouts.length
      || storedPayoutsByPlace.size !== storedPayouts.length
      || expectedPayouts.some((expectedPayout) => {
        const storedPayout = storedPayoutsByPlace.get(expectedPayout.place);
        return !storedPayout
          || expectedPayout.entryId !== storedPayout.entryId
          || expectedPayout.amountBaseUnits !== storedPayout.amountBaseUnits
          || expectedPayout.idempotencyKey !== storedPayout.idempotencyKey;
      })) {
      throw new PaidMatchPersistenceError("PAYOUT_RECORD_CONFLICT", "The durable payout plan does not match the immutable result.");
    }
    return {
      created: false,
      resultId: existingResult.id,
      immutableResultHash: existingResult.resultHash,
      settlementId: attempt.settlementId,
    };
  }
}

function assertStoredTermsMatch(
  terms: PaidMatchTerms,
  match: {
    roundId: string;
    ruleset: string;
    rulesVersion: string;
    rulesHash: string;
    settlementAsset: string;
    usdcMint: string;
    entryAmountBaseUnits: bigint;
    reviveAmountBaseUnits: bigint;
    maxRevivesPerPlayer: number;
    reviveWindowMs: number;
    reviveCutoffMs: number;
    reviveSpawnProtectionMs: number;
    platformFeeBps: number;
    payoutBps: number[];
    minimumPlayers: number;
    maximumPlayers: number;
    roundDurationMs: number;
    fundingDeadline: Date;
    escrowAddress: string;
  }
): void {
  const configuration = terms.configuration;
  const revive = terms.reviveConfiguration;
  const expectedPayoutBps = configuration.prizeDistribution.map((payout) => Number(payout.basisPoints));
  const matches = match.roundId === terms.roundId
    && match.ruleset === terms.ruleset
    && match.rulesVersion === terms.rulesVersion
    && match.rulesHash === terms.rulesHash
    && match.settlementAsset === terms.settlementAsset
    && match.usdcMint === terms.usdcMint
    && match.entryAmountBaseUnits === configuration.entryAmountBaseUnits
    && match.reviveAmountBaseUnits === revive.reviveAmountBaseUnits
    && match.maxRevivesPerPlayer === revive.maxRevivesPerPlayer
    && match.reviveWindowMs === revive.reviveWindowMs
    && match.reviveCutoffMs === revive.reviveCutoffMs
    && match.reviveSpawnProtectionMs === revive.spawnProtectionMs
    && match.platformFeeBps === Number(configuration.platformFeeBps)
    && equalNumberArrays(match.payoutBps, expectedPayoutBps)
    && match.minimumPlayers === configuration.minimumPlayers
    && match.maximumPlayers === configuration.maximumPlayers
    && match.roundDurationMs === configuration.roundDurationMs
    && match.fundingDeadline.getTime() === terms.fundingDeadline.getTime()
    && match.escrowAddress === terms.escrowAddress;
  if (!matches) {
    throw new PaidMatchPersistenceError("MATCH_TERMS_CONFLICT", "Durable paid match terms do not match the immutable rules.");
  }
}

async function loadVerifiedEntries(
  transaction: Prisma.TransactionClient,
  terms: PaidMatchTerms,
  participants: readonly VerifiedParticipant[],
): Promise<Map<string, { id: string }>> {
  const playerIds = participants.map((participant) => participant.playerId);
  const entries = await transaction.matchEntry.findMany({
    where: {
      matchId: terms.matchId,
      playerId: { in: playerIds },
      status: { in: ["VERIFIED", "CONSUMED"] },
    },
    select: {
      id: true,
      playerId: true,
      amountBaseUnits: true,
      wallet: { select: { address: true } }
    }
  });
  if (entries.length !== participants.length) {
    throw new PaidMatchPersistenceError("ENTRY_BINDING_INVALID", "Every result participant must have one verified paid entry.");
  }
  const entriesByPlayer = new Map(entries.map((entry) => [entry.playerId, entry]));
  for (const participant of participants) {
    const entry = entriesByPlayer.get(participant.playerId);
    if (!entry
      || entry.wallet.address !== participant.walletAddress
      || entry.amountBaseUnits !== terms.configuration.entryAmountBaseUnits) {
      throw new PaidMatchPersistenceError("ENTRY_BINDING_INVALID", "A paid entry does not match the immutable participant record.");
    }
  }
  return new Map([...entriesByPlayer].map(([playerId, entry]) => [playerId, { id: entry.id }]));
}

function toStoredResultPayload(finalized: FinalizedPaidMatch): Prisma.InputJsonValue {
  const result = finalized.settlementRequest.result;
  return {
    version: 1,
    mode: result.mode,
    matchId: result.matchId,
    roundId: result.roundId,
    resultTimestamp: result.resultTimestamp.toISOString(),
    players: [...result.players]
      .sort((left, right) => left.finalRank - right.finalRank)
      .map((player) => ({
        playerId: player.playerId,
        finalRank: player.finalRank,
        finalMass: player.finalMass,
        foodCollected: player.foodCollected,
        eliminations: player.eliminations,
        deaths: player.deaths,
        survivalTimeMs: player.survivalTimeMs,
      })),
    pool: {
      entryPoolBaseUnits: finalized.pool.entryPoolBaseUnits.toString(),
      revivePoolBaseUnits: finalized.pool.revivePoolBaseUnits.toString(),
      grossPoolBaseUnits: finalized.pool.grossPoolBaseUnits.toString(),
      platformFeeBaseUnits: finalized.prizes.platformFeeBaseUnits.toString(),
      prizePoolBaseUnits: finalized.prizes.prizePoolBaseUnits.toString(),
    },
    payouts: finalized.prizes.payouts.map((payout) => ({
      place: payout.place,
      amountBaseUnits: payout.amountBaseUnits.toString(),
    })),
  };
}

function equalNumberArrays(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSerializationConflict(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "P2034";
}
