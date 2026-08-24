import * as ed25519 from "@noble/ed25519";
import { z } from "zod";
import type { PaidAdmissionClaims } from "./admission-ticket.js";

const identifierSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const claimsSchema = z.object({
  audience: z.literal("blob-game-server"),
  entryId: identifierSchema,
  matchId: identifierSchema,
  roundId: identifierSchema,
  playerId: identifierSchema,
  rulesHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().safe(),
  expiresAt: z.number().int().safe(),
  nonce: z.string().uuid(),
}).strict();

const payloadSchema = z.object({
  token: z.string().min(1).max(2_177),
  claims: claimsSchema,
}).strict();

/**
 * Authenticates a future paid-room → Platform API consume request. The
 * browser has neither this caller key nor direct access to the route; the
 * repository independently checks the ticket hash and immutable match state.
 */
export async function verifyPaidAdmissionConsumeRequest(input: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  publicKey: Uint8Array | undefined;
}): Promise<{ success: true; payload: { token: string; claims: PaidAdmissionClaims } } | { success: false; error: "ADMISSION_UNAVAILABLE" | "ADMISSION_UNAUTHORIZED" | "ADMISSION_INVALID" }> {
  if (!input.publicKey) return { success: false, error: "ADMISSION_UNAVAILABLE" };
  const signature = decodeSignature(input.signatureHeader);
  if (!signature) return { success: false, error: "ADMISSION_UNAUTHORIZED" };
  try {
    if (!await ed25519.verifyAsync(signature, input.rawBody, input.publicKey)) {
      return { success: false, error: "ADMISSION_UNAUTHORIZED" };
    }
  } catch {
    return { success: false, error: "ADMISSION_UNAUTHORIZED" };
  }
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    return { success: false, error: "ADMISSION_INVALID" };
  }
  const parsed = payloadSchema.safeParse(rawPayload);
  if (!parsed.success || parsed.data.claims.expiresAt <= parsed.data.claims.issuedAt) {
    return { success: false, error: "ADMISSION_INVALID" };
  }
  return { success: true, payload: parsed.data };
}

function decodeSignature(value: string | undefined): Uint8Array | undefined {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 64 ? new Uint8Array(decoded) : undefined;
}
