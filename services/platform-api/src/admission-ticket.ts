import { randomUUID } from "node:crypto";
import * as ed25519 from "@noble/ed25519";

const MAX_ENCODED_PAYLOAD_LENGTH = 2_048;
const MAX_ENCODED_SIGNATURE_LENGTH = 128;
const MAX_TICKET_LENGTH = MAX_ENCODED_PAYLOAD_LENGTH + MAX_ENCODED_SIGNATURE_LENGTH + 1;

export interface PaidAdmissionClaims {
  audience: "blob-game-server";
  entryId: string;
  matchId: string;
  roundId: string;
  playerId: string;
  rulesHash: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export class AdmissionTicketError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * This ticket is created only after durable entry verification. It carries no
 * token balance or outcome authority; the game server still owns gameplay.
 */
export async function issuePaidAdmissionTicket(input: {
  privateKey: Uint8Array;
  entryId: string;
  matchId: string;
  roundId: string;
  playerId: string;
  rulesHash: string;
  now?: Date;
  ttlMs?: number;
}): Promise<{ token: string; claims: PaidAdmissionClaims }> {
  assertSigningPrivateKey(input.privateKey);
  assertRequiredFields(input);
  const now = input.now ?? new Date();
  if (!Number.isSafeInteger(now.getTime())) {
    throw new AdmissionTicketError("ADMISSION_TIME_INVALID", "Admission ticket time is invalid.");
  }
  const ttlMs = input.ttlMs ?? 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 10_000 || ttlMs > 5 * 60_000) {
    throw new AdmissionTicketError("ADMISSION_TTL_INVALID", "Admission ticket lifetime is invalid.");
  }
  const expiresAt = now.getTime() + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new AdmissionTicketError("ADMISSION_TIME_INVALID", "Admission ticket time is invalid.");
  }
  const claims: PaidAdmissionClaims = {
    audience: "blob-game-server",
    entryId: input.entryId,
    matchId: input.matchId,
    roundId: input.roundId,
    playerId: input.playerId,
    rulesHash: input.rulesHash,
    issuedAt: now.getTime(),
    expiresAt,
    nonce: randomUUID()
  };
  const payload = toBase64Url(JSON.stringify(claims));
  const signature = await ed25519.signAsync(new TextEncoder().encode(payload), input.privateKey);
  return { token: payload + "." + Buffer.from(signature).toString("base64url"), claims };
}

export async function verifyPaidAdmissionTicket(input: {
  token: string;
  publicKey: Uint8Array;
  expectedMatchId: string;
  expectedRoundId: string;
  now?: Date;
}): Promise<PaidAdmissionClaims> {
  assertVerificationPublicKey(input.publicKey);
  const now = input.now ?? new Date();
  if (!Number.isSafeInteger(now.getTime())) {
    throw new AdmissionTicketError("ADMISSION_CLAIMS_INVALID", "Paid admission ticket is expired or does not match this round.");
  }
  if (input.token.length > MAX_TICKET_LENGTH) {
    throw new AdmissionTicketError("ADMISSION_SIGNATURE_INVALID", "Paid admission ticket is invalid.");
  }
  const [payload, signature, ...extra] = input.token.split(".");
  if (!payload || !signature || extra.length !== 0
    || payload.length > MAX_ENCODED_PAYLOAD_LENGTH
    || signature.length > MAX_ENCODED_SIGNATURE_LENGTH) {
    throw new AdmissionTicketError("ADMISSION_SIGNATURE_INVALID", "Paid admission ticket is invalid.");
  }
  const signatureBytes = decodeBase64Url(signature);
  if (!signatureBytes || signatureBytes.length !== 64) {
    throw new AdmissionTicketError("ADMISSION_SIGNATURE_INVALID", "Paid admission ticket is invalid.");
  }
  try {
    if (!await ed25519.verifyAsync(signatureBytes, new TextEncoder().encode(payload), input.publicKey)) {
      throw new AdmissionTicketError("ADMISSION_SIGNATURE_INVALID", "Paid admission ticket is invalid.");
    }
  } catch (error) {
    if (error instanceof AdmissionTicketError) {
      throw error;
    }
    throw new AdmissionTicketError("ADMISSION_SIGNATURE_INVALID", "Paid admission ticket is invalid.");
  }
  let claims: PaidAdmissionClaims;
  try {
    claims = JSON.parse(fromBase64Url(payload)) as PaidAdmissionClaims;
  } catch {
    throw new AdmissionTicketError("ADMISSION_PAYLOAD_INVALID", "Paid admission ticket is invalid.");
  }
  if (claims.audience !== "blob-game-server"
    || claims.matchId !== input.expectedMatchId
    || claims.roundId !== input.expectedRoundId
    || !isBoundedText(claims.entryId) || !isBoundedText(claims.playerId)
    || !isBoundedText(claims.matchId) || !isBoundedText(claims.roundId)
    || !isBoundedText(claims.rulesHash) || !isBoundedText(claims.nonce)
    || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)
    || claims.expiresAt <= claims.issuedAt || claims.expiresAt <= now.getTime()) {
    throw new AdmissionTicketError("ADMISSION_CLAIMS_INVALID", "Paid admission ticket is expired or does not match this round.");
  }
  return claims;
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  const bytes = Buffer.from(value, "base64url");
  return bytes.length ? new Uint8Array(bytes) : undefined;
}

function assertSigningPrivateKey(privateKey: Uint8Array): void {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
    throw new AdmissionTicketError("ADMISSION_SIGNING_KEY_INVALID", "Admission signing key is invalid.");
  }
}

function assertVerificationPublicKey(publicKey: Uint8Array): void {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    throw new AdmissionTicketError("ADMISSION_VERIFICATION_KEY_INVALID", "Admission verification key is invalid.");
  }
}

function assertRequiredFields(input: Omit<PaidAdmissionClaims, "audience" | "issuedAt" | "expiresAt" | "nonce"> & { privateKey: Uint8Array; now?: Date; ttlMs?: number }): void {
  for (const value of [input.entryId, input.matchId, input.roundId, input.playerId, input.rulesHash]) {
    if (!isBoundedText(value)) {
      throw new AdmissionTicketError("ADMISSION_CLAIMS_INVALID", "Paid admission ticket claims are invalid.");
    }
  }
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256;
}
