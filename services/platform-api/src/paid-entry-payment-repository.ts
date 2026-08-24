import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import type { VerifiedSolanaUsdcTransfer } from "./solana-payment-verifier.js";

export interface PersistVerifiedEntryPaymentInput {
  entryId: string;
  userId: string;
  walletId: string;
  walletAddress: string;
  payment: VerifiedSolanaUsdcTransfer;
}

export interface PersistedEntryPayment {
  created: boolean;
  entryId: string;
  transactionId: string;
}

/**
 * A durable admission receipt for a payment already verified by the private
 * Solana RPC verifier. It has no HTTP route: a future paid-match
 * orchestrator must verify the actual transfer before it can call this class.
 *
 * The transaction and entry update share a serializable database transaction,
 * so one finalized Solana signature can fund only one exact reserved entry.
 * This repository never signs, submits, refunds, or otherwise moves USDC.
 */
export class PrismaPaidEntryPaymentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async persist(input: PersistVerifiedEntryPaymentInput): Promise<PersistedEntryPayment> {
    assertInput(input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.persistOnce(input);
      } catch (error) {
        if (attempt === 0 && isSerializationConflict(error)) {
          continue;
        }
        if (isUniqueConflict(error)) {
          throw new PaidEntryPaymentPersistenceError(
            "PAYMENT_SIGNATURE_CONFLICT",
            "This finalized Solana signature is already bound to another record."
          );
        }
        throw error;
      }
    }
    throw new PaidEntryPaymentPersistenceError("ENTRY_PAYMENT_RETRY_EXHAUSTED", "Could not persist the verified paid entry.");
  }

  private async persistOnce(input: PersistVerifiedEntryPaymentInput): Promise<PersistedEntryPayment> {
    return this.prisma.$transaction(async (transaction) => {
      const entry = await transaction.matchEntry.findUnique({
        where: { id: input.entryId },
        select: {
          id: true,
          matchId: true,
          userId: true,
          walletId: true,
          status: true,
          amountBaseUnits: true,
          transactionId: true,
          fundedAt: true,
          wallet: { select: { address: true } },
          match: { select: { status: true, fundingDeadline: true } },
        }
      });
      if (!entry) {
        throw new PaidEntryPaymentPersistenceError("ENTRY_NOT_FOUND", "The paid entry does not exist.");
      }
      if (entry.userId !== input.userId || entry.walletId !== input.walletId || entry.wallet.address !== input.walletAddress) {
        throw new PaidEntryPaymentPersistenceError("ENTRY_IDENTITY_MISMATCH", "The payment wallet is not bound to this paid entry.");
      }

      if (entry.transactionId) {
        return this.reuseExistingReceipt(transaction, entry, input);
      }
      if (entry.status !== "RESERVED" && entry.status !== "PENDING") {
        throw new PaidEntryPaymentPersistenceError("ENTRY_NOT_FUNDABLE", "The paid entry is not awaiting a payment.");
      }
      if (entry.match.status !== "FUNDING") {
        throw new PaidEntryPaymentPersistenceError("MATCH_NOT_FUNDING", "The paid match is not accepting entry payments.");
      }
      if (input.payment.finalizedAt.getTime() >= entry.match.fundingDeadline.getTime()) {
        throw new PaidEntryPaymentPersistenceError("PAYMENT_AFTER_FUNDING_DEADLINE", "The payment finalized after the funding deadline.");
      }

      const signatureRecord = await transaction.chainTransaction.findUnique({
        where: { signature: input.payment.signature },
        select: { id: true }
      });
      if (signatureRecord) {
        throw new PaidEntryPaymentPersistenceError("PAYMENT_SIGNATURE_CONFLICT", "This finalized Solana signature is already bound to another record.");
      }

      const payment = await transaction.chainTransaction.create({
        data: {
          matchId: entry.matchId,
          kind: "ENTRY",
          signature: input.payment.signature,
          amountBaseUnits: entry.amountBaseUnits,
          walletAddress: input.walletAddress,
          confirmedAt: input.payment.finalizedAt,
          finalizedAt: input.payment.finalizedAt,
          idempotencyKey: "entry-payment:" + entry.id,
        },
        select: { id: true }
      });
      const updated = await transaction.matchEntry.updateMany({
        where: {
          id: entry.id,
          status: { in: ["RESERVED", "PENDING"] },
          transactionId: null,
        },
        data: {
          status: "VERIFIED",
          transactionId: payment.id,
          fundedAt: input.payment.finalizedAt,
        }
      });
      if (updated.count !== 1) {
        throw new PaidEntryPaymentPersistenceError("ENTRY_STATE_CONFLICT", "The paid entry changed while its payment was being recorded.");
      }
      await transaction.auditEvent.create({
        data: {
          userId: entry.userId,
          action: "paid_entry_verified",
          entityType: "match_entry",
          entityId: entry.id,
          metadata: { slot: input.payment.slot }
        }
      });
      return { created: true, entryId: entry.id, transactionId: payment.id };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async reuseExistingReceipt(
    transaction: Prisma.TransactionClient,
    entry: {
      id: string;
      matchId: string;
      status: string;
      amountBaseUnits: bigint;
      transactionId: string | null;
      fundedAt: Date | null;
    },
    input: PersistVerifiedEntryPaymentInput,
  ): Promise<PersistedEntryPayment> {
    const existing = await transaction.chainTransaction.findUnique({
      where: { id: entry.transactionId! },
      select: {
        id: true,
        matchId: true,
        kind: true,
        signature: true,
        amountBaseUnits: true,
        walletAddress: true,
        finalizedAt: true,
        idempotencyKey: true,
      }
    });
    const matches = entry.status === "VERIFIED"
      && entry.fundedAt?.getTime() === input.payment.finalizedAt.getTime()
      && existing?.matchId === entry.matchId
      && existing.kind === "ENTRY"
      && existing.signature === input.payment.signature
      && existing.amountBaseUnits === entry.amountBaseUnits
      && existing.walletAddress === input.walletAddress
      && existing.finalizedAt?.getTime() === input.payment.finalizedAt.getTime()
      && existing.idempotencyKey === "entry-payment:" + entry.id;
    if (!matches) {
      throw new PaidEntryPaymentPersistenceError("ENTRY_PAYMENT_RECORD_CONFLICT", "The stored payment receipt does not match this verified transfer.");
    }
    return { created: false, entryId: entry.id, transactionId: existing.id };
  }
}

export class PaidEntryPaymentPersistenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function assertInput(input: PersistVerifiedEntryPaymentInput): void {
  if (!isIdentifier(input.entryId) || !isIdentifier(input.userId) || !isIdentifier(input.walletId)
    || typeof input.walletAddress !== "string" || input.walletAddress.length === 0 || input.walletAddress.length > 128
    || typeof input.payment?.signature !== "string" || input.payment.signature.length < 32 || input.payment.signature.length > 128
    || !Number.isSafeInteger(input.payment.slot) || input.payment.slot < 0
    || !(input.payment.finalizedAt instanceof Date) || !Number.isFinite(input.payment.finalizedAt.getTime())) {
    throw new PaidEntryPaymentPersistenceError("ENTRY_PAYMENT_INPUT_INVALID", "Verified entry-payment data is invalid.");
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isSerializationConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2034");
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002");
}
