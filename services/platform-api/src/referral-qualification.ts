import * as ed25519 from "@noble/ed25519";
import { z } from "zod";

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export const referralQualificationRecordSchema = z.object({
  eventId: z.string().min(16).max(220).regex(/^[A-Za-z0-9:_-]+$/),
  profileUserId: z.string().uuid(),
  matchId: z.string().min(3).max(120).regex(/^[A-Za-z0-9_-]+$/),
  roundId: z.string().min(3).max(120).regex(/^[A-Za-z0-9_-]+$/),
  completedAt: z.number().int().positive(),
}).strict();

export type ReferralQualificationRecord = z.infer<typeof referralQualificationRecordSchema>;

/** Verify a one-way request from the game server. The request deliberately
 * carries an internal profile ID only—never wallet addresses or cookies. */
export async function verifyReferralQualificationRequest(input: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  publicKey: Uint8Array | undefined;
  now?: number;
}): Promise<{ success: true; record: ReferralQualificationRecord } | { success: false; error: "REFERRAL_QUALIFICATION_UNAVAILABLE" | "REFERRAL_QUALIFICATION_UNAUTHORIZED" | "REFERRAL_QUALIFICATION_INVALID" }> {
  if (!input.publicKey) {
    return { success: false, error: "REFERRAL_QUALIFICATION_UNAVAILABLE" };
  }
  const signature = decodeSignature(input.signatureHeader);
  if (!signature) {
    return { success: false, error: "REFERRAL_QUALIFICATION_UNAUTHORIZED" };
  }
  try {
    if (!await ed25519.verifyAsync(signature, input.rawBody, input.publicKey)) {
      return { success: false, error: "REFERRAL_QUALIFICATION_UNAUTHORIZED" };
    }
  } catch {
    return { success: false, error: "REFERRAL_QUALIFICATION_UNAUTHORIZED" };
  }
  let rawRecord: unknown;
  try {
    rawRecord = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    return { success: false, error: "REFERRAL_QUALIFICATION_INVALID" };
  }
  const parsed = referralQualificationRecordSchema.safeParse(rawRecord);
  if (!parsed.success || Math.abs((input.now ?? Date.now()) - parsed.data.completedAt) > MAX_CLOCK_SKEW_MS) {
    return { success: false, error: "REFERRAL_QUALIFICATION_INVALID" };
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
