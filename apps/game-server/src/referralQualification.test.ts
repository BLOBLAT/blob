import * as ed25519 from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import {
  createReferralQualificationEventId,
  createReferralQualificationPersistence,
  SignedReferralQualificationClient,
} from "./referralQualification.js";

const RECORD = {
  eventId: "free-round:free-match-1:round-1:aa3b4583-48e4-4963-b32d-b18be97e1dc6",
  profileUserId: "aa3b4583-48e4-4963-b32d-b18be97e1dc6",
  matchId: "free-match-1",
  roundId: "round-1",
  completedAt: Date.UTC(2026, 7, 28, 12, 0, 0),
  foodCollected: 20,
  survivalTimeMs: 2 * 60 * 1_000,
};

describe("referral qualification handoff", () => {
  it("sends a compact signed completion fact to the private platform API", async () => {
    const privateKey = ed25519.utils.randomSecretKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const send: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ status: "QUALIFIED" }), { status: 201 });
    };
    const client = new SignedReferralQualificationClient("https://platform.internal/", privateKey, send);

    await expect(client.persist(RECORD)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://platform.internal/internal/referrals/qualifications");
    const body = Buffer.from(init!.body as Uint8Array);
    expect(JSON.parse(body.toString("utf8"))).toEqual(RECORD);
    const headers = init!.headers as Record<string, string>;
    const signature = Buffer.from(headers["X-BLOB-Referral-Qualification-Signature"]!, "base64");
    await expect(ed25519.verifyAsync(signature, body, publicKey)).resolves.toBe(true);
  });

  it("does not enable awards with incomplete server-only configuration", async () => {
    expect(createReferralQualificationPersistence({
      PLATFORM_REFERRAL_ORIGIN: "https://platform.internal",
    }).enabled).toBe(false);
    expect(createReferralQualificationPersistence({
      BLOB_REFERRAL_QUALIFICATION_PRIVATE_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
    }).enabled).toBe(false);
  });

  it("keeps an early in-progress activity fact retryable until its server-owned thresholds are met", async () => {
    const privateKey = ed25519.utils.randomSecretKey();
    const send: typeof fetch = async () => new Response(JSON.stringify({ status: "INSUFFICIENT_GAMEPLAY" }), { status: 201 });
    const client = new SignedReferralQualificationClient("https://platform.internal", privateKey, send);

    await expect(client.persist({ ...RECORD, foodCollected: 4, survivalTimeMs: 10_000 })).resolves.toBe(false);
  });

  it("uses a stable per-user, match, and round idempotency key", () => {
    expect(createReferralQualificationEventId(
      "free-match-1",
      "round-1",
      "aa3b4583-48e4-4963-b32d-b18be97e1dc6",
    )).toBe(RECORD.eventId);
  });
});
