import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import type { PaidMatchTerms } from "./paid-match.js";

export interface PersistedPaidMatchTerms {
  created: boolean;
  matchId: string;
  roundId: string;
}

/**
 * Stores server-created paid-match terms before an entry can be reserved.
 *
 * This is deliberately an internal repository rather than a public route:
 * production mint, escrow and rules configuration must be selected by the
 * controlled match orchestrator, never by a wallet-connected browser.
 */
export class PrismaPaidMatchTermsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async persist(terms: PaidMatchTerms): Promise<PersistedPaidMatchTerms> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.persistOnce(terms);
      } catch (error) {
        if (attempt === 0 && (isSerializationConflict(error) || isUniqueConflict(error))) {
          continue;
        }
        if (isUniqueConflict(error)) {
          throw new PaidMatchTermsPersistenceError("MATCH_TERMS_WRITE_CONFLICT", "Could not create the immutable paid match terms.");
        }
        throw error;
      }
    }
    throw new PaidMatchTermsPersistenceError("MATCH_TERMS_RETRY_EXHAUSTED", "Could not persist immutable paid match terms.");
  }

  private async persistOnce(terms: PaidMatchTerms): Promise<PersistedPaidMatchTerms> {
    return this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.match.findUnique({
        where: { id: terms.matchId },
        select: MATCH_TERMS_SELECT,
      });
      if (existing) {
        assertStoredTermsMatch(terms, existing);
        return { created: false, matchId: terms.matchId, roundId: terms.roundId };
      }

      await transaction.match.create({
        data: {
          id: terms.matchId,
          roundId: terms.roundId,
          status: "DRAFT",
          ruleset: terms.ruleset,
          rulesVersion: terms.rulesVersion,
          rulesHash: terms.rulesHash,
          settlementAsset: terms.settlementAsset,
          usdcMint: terms.usdcMint,
          entryAmountBaseUnits: terms.configuration.entryAmountBaseUnits,
          reviveAmountBaseUnits: terms.reviveConfiguration.reviveAmountBaseUnits,
          maxRevivesPerPlayer: terms.reviveConfiguration.maxRevivesPerPlayer,
          reviveWindowMs: terms.reviveConfiguration.reviveWindowMs,
          reviveCutoffMs: terms.reviveConfiguration.reviveCutoffMs,
          reviveSpawnProtectionMs: terms.reviveConfiguration.spawnProtectionMs,
          platformFeeBps: Number(terms.configuration.platformFeeBps),
          payoutBps: terms.configuration.prizeDistribution.map((payout) => Number(payout.basisPoints)),
          minimumPlayers: terms.configuration.minimumPlayers,
          maximumPlayers: terms.configuration.maximumPlayers,
          roundDurationMs: terms.configuration.roundDurationMs,
          fundingDeadline: terms.fundingDeadline,
          escrowAddress: terms.escrowAddress,
          createdAt: terms.createdAt,
        }
      });
      await transaction.auditEvent.create({
        data: {
          userId: null,
          action: "paid_match_terms_created",
          entityType: "match",
          entityId: terms.matchId,
          metadata: { roundId: terms.roundId, rulesHash: terms.rulesHash }
        }
      });
      return { created: true, matchId: terms.matchId, roundId: terms.roundId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}

export class PaidMatchTermsPersistenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const MATCH_TERMS_SELECT = {
  roundId: true,
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
} as const;

function assertStoredTermsMatch(
  terms: PaidMatchTerms,
  stored: {
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
  const matches = stored.roundId === terms.roundId
    && stored.ruleset === terms.ruleset
    && stored.rulesVersion === terms.rulesVersion
    && stored.rulesHash === terms.rulesHash
    && stored.settlementAsset === terms.settlementAsset
    && stored.usdcMint === terms.usdcMint
    && stored.entryAmountBaseUnits === configuration.entryAmountBaseUnits
    && stored.reviveAmountBaseUnits === revive.reviveAmountBaseUnits
    && stored.maxRevivesPerPlayer === revive.maxRevivesPerPlayer
    && stored.reviveWindowMs === revive.reviveWindowMs
    && stored.reviveCutoffMs === revive.reviveCutoffMs
    && stored.reviveSpawnProtectionMs === revive.spawnProtectionMs
    && stored.platformFeeBps === Number(configuration.platformFeeBps)
    && equalNumberArrays(stored.payoutBps, configuration.prizeDistribution.map((payout) => Number(payout.basisPoints)))
    && stored.minimumPlayers === configuration.minimumPlayers
    && stored.maximumPlayers === configuration.maximumPlayers
    && stored.roundDurationMs === configuration.roundDurationMs
    && stored.fundingDeadline.getTime() === terms.fundingDeadline.getTime()
    && stored.escrowAddress === terms.escrowAddress;
  if (!matches) {
    throw new PaidMatchTermsPersistenceError("MATCH_TERMS_CONFLICT", "Stored paid match terms do not match the immutable rules.");
  }
}

function equalNumberArrays(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSerializationConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2034");
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002");
}
