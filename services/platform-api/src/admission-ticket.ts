import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface PaidAdmissionClaims {
  audience: "blob-game-server";
  entryId: string;
  matchId: string;
  roundId: string;
  playerId: string;
  walletAddress: string;
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
export function issuePaidAdmissionTicket(input: {
  secret: string;
  entryId: string;
  matchId: string;
  roundId: string;
  playerId: string;
  walletAddress: string;
  rulesHash: string;
  now?: Date;
  ttlMs?: number;
}): { token: string; claims: PaidAdmissionClaims } {
  assertSecret(input.secret);
  assertRequiredFields(input);
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 10_000 || ttlMs > 5 * 60_000) {
    throw new AdmissionTicketError("ADMISSION_TTL_INVALID", "Admission ticket lifetime is invalid.");
  }
  const claims: PaidAdmissionClaims = {
    audience: "blob-game-server",
    entryId: input.entryId,
    matchId: input.matchId,
    roundId: input.roundId,
    playerId: input.playerId,
    walletAddress: input.walletAddress,
    rulesHash: input.rulesHash,
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + ttlMs,
    nonce: randomUUID()
  };
  const payload = toBase64Url(JSON.stringify(claims));
  return { token: payload + "." + sign(payload, input.secret), claims };
}

export function verifyPaidAdmissionTicket(input: {
  token: string;
  secret: string;
  expectedMatchId: string;
  expectedRoundId: string;
  now?: Date;
}): PaidAdmissionClaims {
  assertSecret(input.secret);
  const [payload, signature, ...extra] = input.token.split(".");
  if (!payload || !signature || extra.length !== 0 || !constantTimeEqual(sign(payload, input.secret), signature)) {
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
    || !claims.entryId || !claims.playerId || !claims.walletAddress || !claims.rulesHash
    || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)
    || claims.expiresAt <= claims.issuedAt || claims.expiresAt <= (input.now ?? new Date()).getTime()) {
    throw new AdmissionTicketError("ADMISSION_CLAIMS_INVALID", "Paid admission ticket is expired or does not match this round.");
  }
  return claims;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function assertSecret(secret: string): void {
  if (secret.length < 32) {
    throw new AdmissionTicketError("ADMISSION_SECRET_INVALID", "Admission signing secret must be at least 32 characters.");
  }
}

function assertRequiredFields(input: Omit<PaidAdmissionClaims, "audience" | "issuedAt" | "expiresAt" | "nonce"> & { secret: string; now?: Date; ttlMs?: number }): void {
  for (const value of [input.entryId, input.matchId, input.roundId, input.playerId, input.walletAddress, input.rulesHash]) {
    if (!value || value.length > 256) {
      throw new AdmissionTicketError("ADMISSION_CLAIMS_INVALID", "Paid admission ticket claims are invalid.");
    }
  }
}
