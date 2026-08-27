import { Prisma, type PrismaClient } from "./generated/prisma/client.js";

export interface ReservePaidEntryInput {
  matchId: string;
  userId: string;
  walletId: string;
  playerId: string;
  idempotencyKey: string;
  now?: Date;
}

export class PaidEntryReservationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Reserves one immutable funded-match seat before a wallet submits a transfer.
 * This repository has no browser route: its caller must obtain user and wallet
 * IDs from the authenticated Platform API session, never from Colyseus.
 */
export class PrismaPaidEntryReservationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async reserve(input: ReservePaidEntryInput): Promise<{ created: boolean; entryId: string }> {
    assertInput(input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.reserveOnce(input);
      } catch (error) {
        if (attempt === 0 && isSerializationConflict(error)) continue;
        if (isUniqueConflict(error)) {
          throw new PaidEntryReservationError("ENTRY_RESERVATION_CONFLICT", "Paid entry conflicts with an existing reservation.");
        }
        throw error;
      }
    }
    throw new PaidEntryReservationError("ENTRY_RESERVATION_RETRY_EXHAUSTED", "Could not reserve a paid match entry.");
  }

  private async reserveOnce(input: ReservePaidEntryInput): Promise<{ created: boolean; entryId: string }> {
    return this.prisma.$transaction(async (transaction) => {
      const existingByKey = await transaction.matchEntry.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true, matchId: true, userId: true, walletId: true, playerId: true }
      });
      if (existingByKey) {
        if (existingByKey.matchId !== input.matchId || existingByKey.userId !== input.userId
          || existingByKey.walletId !== input.walletId || existingByKey.playerId !== input.playerId) {
          throw new PaidEntryReservationError("ENTRY_IDEMPOTENCY_CONFLICT", "Paid entry idempotency key does not match its original reservation.");
        }
        return { created: false, entryId: existingByKey.id };
      }
      const match = await transaction.match.findUnique({
        where: { id: input.matchId },
        select: { id: true, status: true, maximumPlayers: true, entryAmountBaseUnits: true, fundingDeadline: true }
      });
      if (!match) throw new PaidEntryReservationError("MATCH_NOT_FOUND", "Paid match does not exist.");
      if (match.status !== "FUNDING") throw new PaidEntryReservationError("MATCH_NOT_FUNDING", "Paid match is not accepting entries.");
      const now = input.now ?? new Date();
      if (!Number.isSafeInteger(now.getTime()) || now.getTime() >= match.fundingDeadline.getTime()) {
        throw new PaidEntryReservationError("FUNDING_DEADLINE_EXPIRED", "Paid match funding deadline has expired.");
      }
      const wallet = await transaction.wallet.findUnique({
        where: { id: input.walletId },
        select: { id: true, userId: true }
      });
      if (!wallet || wallet.userId !== input.userId) {
        throw new PaidEntryReservationError("ENTRY_WALLET_MISMATCH", "Paid entry wallet is not owned by the authenticated user.");
      }
      const existingForUser = await transaction.matchEntry.findUnique({
        where: { matchId_userId: { matchId: input.matchId, userId: input.userId } },
        select: { id: true }
      });
      if (existingForUser) throw new PaidEntryReservationError("ENTRY_ALREADY_RESERVED", "User already has a paid entry for this match.");
      const entryCount = await transaction.matchEntry.count({ where: { matchId: input.matchId } });
      if (entryCount >= match.maximumPlayers) throw new PaidEntryReservationError("MATCH_CAPACITY_REACHED", "Paid match has no remaining entries.");
      const entry = await transaction.matchEntry.create({
        data: {
          matchId: match.id,
          userId: input.userId,
          walletId: wallet.id,
          playerId: input.playerId,
          status: "RESERVED",
          amountBaseUnits: match.entryAmountBaseUnits,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true }
      });
      await transaction.auditEvent.create({
        data: {
          userId: input.userId,
          action: "paid_entry_reserved",
          entityType: "match_entry",
          entityId: entry.id,
          metadata: { matchId: input.matchId, playerId: input.playerId }
        }
      });
      return { created: true, entryId: entry.id };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}

function assertInput(input: ReservePaidEntryInput): void {
  const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (!input || !identifier(input.matchId) || !identifier(input.userId) || !identifier(input.walletId)
    || !identifier(input.playerId) || !identifier(input.idempotencyKey)) {
    throw new PaidEntryReservationError("ENTRY_RESERVATION_INPUT_INVALID", "Paid entry reservation input is invalid.");
  }
}

function isSerializationConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2034");
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002");
}
