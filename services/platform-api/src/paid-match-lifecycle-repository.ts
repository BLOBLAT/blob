import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import { canTransitionPaidMatch, type PaidMatchState } from "@blob/shared";

export interface TransitionPaidMatchInput {
  matchId: string;
  to: PaidMatchState;
  now?: Date;
}

export class PaidMatchLifecycleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Private orchestration boundary for durable paid-match state changes. It is
 * intentionally not an HTTP handler: a browser cannot open funding, select a
 * roster, or mark a match live. The paid room can start only after every
 * funded entry has consumed its one-time admission ticket.
 */
export class PrismaPaidMatchLifecycleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async transition(input: TransitionPaidMatchInput): Promise<{ matchId: string; from: PaidMatchState; to: PaidMatchState; startsAt: Date | null }> {
    assertInput(input);
    const now = input.now ?? new Date();
    if (!Number.isSafeInteger(now.getTime())) {
      throw new PaidMatchLifecycleError("LIFECYCLE_INPUT_INVALID", "Paid match transition time is invalid.");
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (transaction) => {
      const match = await transaction.match.findUnique({
        where: { id: input.matchId },
        select: {
          id: true,
          status: true,
          minimumPlayers: true,
          maximumPlayers: true,
          fundingDeadline: true,
          startsAt: true,
        }
      });
      if (!match) {
        throw new PaidMatchLifecycleError("MATCH_NOT_FOUND", "Paid match does not exist.");
      }
      const from = match.status as PaidMatchState;
      if (!canTransitionPaidMatch(from, input.to)) {
        throw new PaidMatchLifecycleError("LIFECYCLE_TRANSITION_INVALID", "Paid match lifecycle transition is invalid.");
      }
      if ((input.to === "READY" || input.to === "STARTING" || input.to === "LIVE")
        && now.getTime() >= match.fundingDeadline.getTime()) {
        throw new PaidMatchLifecycleError("FUNDING_DEADLINE_EXPIRED", "Paid match funding deadline has expired.");
      }
      if (input.to === "READY") {
        await assertVerifiedRoster(transaction, match.id, match.minimumPlayers, match.maximumPlayers);
      }
      if (input.to === "LIVE") {
        if (match.startsAt) {
          throw new PaidMatchLifecycleError("MATCH_ALREADY_STARTED", "Paid match already has a durable start time.");
        }
        await assertConsumedRoster(transaction, match.id, match.minimumPlayers, match.maximumPlayers);
      }

      const startsAt = input.to === "LIVE" ? now : match.startsAt;
      const updated = await transaction.match.updateMany({
        where: { id: match.id, status: match.status },
        data: { status: input.to, ...(input.to === "LIVE" ? { startsAt } : {}) }
      });
      if (updated.count !== 1) {
        throw new PaidMatchLifecycleError("LIFECYCLE_STATE_CONFLICT", "Paid match changed while its lifecycle was updated.");
      }
      await transaction.auditEvent.create({
        data: {
          userId: null,
          action: "paid_match_lifecycle_transitioned",
          entityType: "match",
          entityId: match.id,
          metadata: { from, to: input.to, at: now.toISOString() }
        }
      });
      return { matchId: match.id, from, to: input.to, startsAt };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (attempt === 0 && isSerializationConflict(error)) {
          continue;
        }
        throw error;
      }
    }
    throw new PaidMatchLifecycleError("LIFECYCLE_RETRY_EXHAUSTED", "Could not update the paid match lifecycle.");
  }
}

async function assertVerifiedRoster(
  transaction: Prisma.TransactionClient,
  matchId: string,
  minimumPlayers: number,
  maximumPlayers: number,
): Promise<void> {
  const entries = await transaction.matchEntry.findMany({
    where: { matchId },
    select: { status: true }
  });
  if (entries.length < minimumPlayers || entries.length > maximumPlayers || entries.some((entry) => entry.status !== "VERIFIED")) {
    throw new PaidMatchLifecycleError("VERIFIED_ROSTER_INVALID", "Paid match does not have a complete verified roster.");
  }
}

async function assertConsumedRoster(
  transaction: Prisma.TransactionClient,
  matchId: string,
  minimumPlayers: number,
  maximumPlayers: number,
): Promise<void> {
  const entries = await transaction.matchEntry.findMany({
    where: { matchId },
    select: { status: true }
  });
  if (entries.length < minimumPlayers || entries.length > maximumPlayers || entries.some((entry) => entry.status !== "CONSUMED")) {
    throw new PaidMatchLifecycleError("CONSUMED_ROSTER_INVALID", "Paid match cannot start without every verified entry admitted exactly once.");
  }
}

function assertInput(input: TransitionPaidMatchInput): void {
  if (!input
    || typeof input.matchId !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(input.matchId)
    || typeof input.to !== "string") {
    throw new PaidMatchLifecycleError("LIFECYCLE_INPUT_INVALID", "Paid match transition input is invalid.");
  }
}

function isSerializationConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2034");
}
