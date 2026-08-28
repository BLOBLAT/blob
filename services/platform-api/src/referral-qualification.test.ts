import * as ed25519 from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import { verifyReferralQualificationRequest } from "./referral-qualification.js";

const RECORD = {
  eventId: "free-round:free-match-1:round-1:aa3b4583-48e4-4963-b32d-b18be97e1dc6",
  profileUserId: "aa3b4583-48e4-4963-b32d-b18be97e1dc6",
  matchId: "free-match-1",
  roundId: "round-1",
  completedAt: Date.UTC(2026, 7, 28, 12, 0, 0),
  foodCollected: 20,
  survivalTimeMs: 2 * 60 * 1_000,
};

describe("referral qualification signature", () => {
  it("accepts only a fresh record signed by the game-server key", async () => {
    const privateKey = ed25519.utils.randomSecretKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const body = Buffer.from(JSON.stringify(RECORD));
    const signature = await ed25519.signAsync(body, privateKey);

    await expect(verifyReferralQualificationRequest({
      rawBody: body,
      signatureHeader: Buffer.from(signature).toString("base64"),
      publicKey,
      now: RECORD.completedAt + 1_000,
    })).resolves.toEqual({ success: true, record: RECORD });
  });

  it("rejects tampering, missing signatures, and stale completion facts", async () => {
    const privateKey = ed25519.utils.randomSecretKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const body = Buffer.from(JSON.stringify(RECORD));
    const signature = Buffer.from(await ed25519.signAsync(body, privateKey)).toString("base64");

    await expect(verifyReferralQualificationRequest({
      rawBody: Buffer.from(JSON.stringify({ ...RECORD, matchId: "tampered" })),
      signatureHeader: signature,
      publicKey,
      now: RECORD.completedAt,
    })).resolves.toEqual({ success: false, error: "REFERRAL_QUALIFICATION_UNAUTHORIZED" });
    await expect(verifyReferralQualificationRequest({
      rawBody: body,
      signatureHeader: undefined,
      publicKey,
      now: RECORD.completedAt,
    })).resolves.toEqual({ success: false, error: "REFERRAL_QUALIFICATION_UNAUTHORIZED" });
    await expect(verifyReferralQualificationRequest({
      rawBody: body,
      signatureHeader: signature,
      publicKey,
      now: RECORD.completedAt + 5 * 60_000 + 1,
    })).resolves.toEqual({ success: false, error: "REFERRAL_QUALIFICATION_INVALID" });
  });
});
