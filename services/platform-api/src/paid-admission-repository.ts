import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import {
  issuePaidAdmissionTicket,
  type PaidAdmissionClaims,
} from "./admission-ticket.js";

export interface IssuePaidAdmissionTicketInput {
  entryId: string;
  privateKey: Uint8Array;
  now?: Date;
  ttlMs?: number;
}

export interface ConsumePaidAdmissionTicketInput {
  token: string;
  claims: PaidAdmissionClaims;
  now?: Date;
}

/**
 * Server-only durable state for the future paid-room admission protocol.
 * The issuing service holds the Ed25519 private key. A future Paid Room must
 * first verify the ticket signature with its public key, then call this
 * repository over an authenticated internal channel to consume it exactly
 * once. The raw signed internal route is deliberately unavailable until its
 * separate caller public key is configured; no browser route exposes it.
 */
export class PrismaPaidAdmissionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async issue(input: IssuePaidAdmissionTicketInput): Promise<{ token: string; claims: PaidAdmissionClaims }> {
    const now = input.now ?? new Date();
    assertValidNow(now);
    return this.prisma.$transaction(async (transaction) => {
      const entry = await transaction.matchEntry.findUnique({
        where: { id: input.entryId },
        select: {
          id: true,
          matchId: true,
          playerId: true,
          status: true,
          admissionTokenHash: true,
          admissionExpiresAt: true,
          match: { select: { roundId: true, rulesHash: true, status: true } },
        }
      });
      if (!entry) {
        throw new PaidAdmissionPersistenceError("ENTRY_NOT_FOUND", "The paid entry does not exist.");
      }
      if (entry.status !== "VERIFIED") {
        throw new PaidAdmissionPersistenceError("ENTRY_NOT_ADMISSIBLE", "The paid entry is not verified for admission.");
      }
      if (entry.match.status !== "READY" && entry.match.status !== "STARTING") {
        throw new PaidAdmissionPersistenceError("MATCH_NOT_ADMITTING", "The paid match is not admitting players.");
      }
      if (entry.admissionTokenHash && (!entry.admissionExpiresAt || entry.admissionExpiresAt.getTime() > now.getTime())) {
        throw new PaidAdmissionPersistenceError("ADMISSION_ALREADY_ISSUED", "An unexpired paid admission ticket already exists for this entry.");
      }
      const issued = await issuePaidAdmissionTicket({
        privateKey: input.privateKey,
        entryId: entry.id,
        matchId: entry.matchId,
        roundId: entry.match.roundId,
        playerId: entry.playerId,
        rulesHash: entry.match.rulesHash,
        now,
        ttlMs: input.ttlMs,
      });
      const updated = await transaction.matchEntry.updateMany({
        where: {
          id: entry.id,
          status: "VERIFIED",
          admissionTokenHash: entry.admissionTokenHash,
        },
        data: {
          admissionTokenHash: hashTicket(issued.token),
          admissionIssuedAt: now,
          admissionExpiresAt: new Date(issued.claims.expiresAt),
        }
      });
      if (updated.count !== 1) {
        throw new PaidAdmissionPersistenceError("ADMISSION_STATE_CONFLICT", "The paid entry changed while admission was issued.");
      }
      await transaction.auditEvent.create({
        data: {
          userId: null,
          action: "paid_admission_issued",
          entityType: "match_entry",
          entityId: entry.id,
          metadata: { nonce: issued.claims.nonce, expiresAt: issued.claims.expiresAt }
        }
      });
      return issued;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async consume(input: ConsumePaidAdmissionTicketInput): Promise<void> {
    const now = input.now ?? new Date();
    assertValidNow(now);
    if (typeof input.token !== "string" || input.token.length === 0 || input.token.length > 2_177) {
      throw new PaidAdmissionPersistenceError("ADMISSION_INPUT_INVALID", "The paid admission ticket is invalid.");
    }
    return this.prisma.$transaction(async (transaction) => {
      const entry = await transaction.matchEntry.findUnique({
        where: { id: input.claims.entryId },
        select: {
          id: true,
          userId: true,
          matchId: true,
          playerId: true,
          status: true,
          admissionTokenHash: true,
          admissionExpiresAt: true,
          match: { select: { roundId: true, rulesHash: true, status: true } },
        }
      });
      const matches = entry
        && entry.status === "VERIFIED"
        && entry.match.status === "STARTING"
        && entry.matchId === input.claims.matchId
        && entry.match.roundId === input.claims.roundId
        && entry.playerId === input.claims.playerId
        && entry.match.rulesHash === input.claims.rulesHash
        && entry.admissionTokenHash === hashTicket(input.token)
        && entry.admissionExpiresAt?.getTime() === input.claims.expiresAt
        && input.claims.expiresAt > now.getTime();
      if (!matches) {
        throw new PaidAdmissionPersistenceError("ADMISSION_NOT_CONSUMABLE", "The paid admission ticket is expired, used, or does not match this entry.");
      }
      const updated = await transaction.matchEntry.updateMany({
        where: { id: entry.id, status: "VERIFIED", admissionTokenHash: entry.admissionTokenHash },
        data: { status: "CONSUMED" }
      });
      if (updated.count !== 1) {
        throw new PaidAdmissionPersistenceError("ADMISSION_ALREADY_CONSUMED", "The paid admission ticket has already been used.");
      }
      await transaction.auditEvent.create({
        data: {
          userId: entry.userId,
          action: "paid_admission_consumed",
          entityType: "match_entry",
          entityId: entry.id,
          metadata: { nonce: input.claims.nonce }
        }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}

export class PaidAdmissionPersistenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function hashTicket(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function assertValidNow(now: Date): void {
  if (!(now instanceof Date) || !Number.isSafeInteger(now.getTime())) {
    throw new PaidAdmissionPersistenceError("ADMISSION_INPUT_INVALID", "The paid admission time is invalid.");
  }
}
