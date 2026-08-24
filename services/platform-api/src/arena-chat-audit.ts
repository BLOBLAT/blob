import * as ed25519 from "@noble/ed25519";
import { arenaChatAuditRecordSchema, type ArenaChatAuditRecord } from "@blob/validation";
import { base58 } from "@scure/base";
import type { PrismaClient } from "./generated/prisma/client.js";

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface ArenaChatAuditRepository {
  store(record: ArenaChatAuditRecord): Promise<void>;
  pruneExpired(now: Date): Promise<number>;
}

export class PrismaArenaChatAuditRepository implements ArenaChatAuditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async store(record: ArenaChatAuditRecord): Promise<void> {
    await this.prisma.arenaChatMessageAudit.create({
      data: {
        id: record.id,
        roomId: record.roomId,
        matchId: record.matchId,
        roundId: record.roundId,
        profileUserId: record.profileUserId,
        anonymousAuthorKey: record.anonymousAuthorKey,
        authorName: record.authorName,
        text: record.text,
        sentAt: new Date(record.sentAt),
        expiresAt: new Date(record.expiresAt)
      }
    });
  }

  async pruneExpired(now: Date): Promise<number> {
    const result = await this.prisma.arenaChatMessageAudit.deleteMany({
      where: { expiresAt: { lte: now } }
    });
    return result.count;
  }
}

export function decodeArenaChatAuditPublicKey(value: string | undefined): Uint8Array | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const decoded = base58.decode(value);
    return decoded.length === 32 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export async function verifyArenaChatAuditRequest(input: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  publicKey: Uint8Array | undefined;
  retentionDays: number;
  now?: number;
}): Promise<{ success: true; record: ArenaChatAuditRecord } | { success: false; error: "AUDIT_UNAVAILABLE" | "AUDIT_UNAUTHORIZED" | "AUDIT_INVALID" }> {
  if (!input.publicKey) {
    return { success: false, error: "AUDIT_UNAVAILABLE" };
  }
  const signature = decodeSignature(input.signatureHeader);
  if (!signature) {
    return { success: false, error: "AUDIT_UNAUTHORIZED" };
  }
  try {
    if (!await ed25519.verifyAsync(signature, input.rawBody, input.publicKey)) {
      return { success: false, error: "AUDIT_UNAUTHORIZED" };
    }
  } catch {
    return { success: false, error: "AUDIT_UNAUTHORIZED" };
  }
  let rawRecord: unknown;
  try {
    rawRecord = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    return { success: false, error: "AUDIT_INVALID" };
  }
  const parsed = arenaChatAuditRecordSchema.safeParse(rawRecord);
  if (!parsed.success) {
    return { success: false, error: "AUDIT_INVALID" };
  }
  const now = input.now ?? Date.now();
  const maximumExpiry = parsed.data.sentAt + input.retentionDays * 24 * 60 * 60 * 1_000;
  if (Math.abs(parsed.data.sentAt - now) > MAX_CLOCK_SKEW_MS || parsed.data.expiresAt > maximumExpiry) {
    return { success: false, error: "AUDIT_INVALID" };
  }
  return { success: true, record: parsed.data };
}

function decodeSignature(value: string | undefined): Uint8Array | undefined {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 64 ? new Uint8Array(decoded) : undefined;
}
