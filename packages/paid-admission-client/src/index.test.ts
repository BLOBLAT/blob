import * as ed25519 from "@noble/ed25519";
import { describe, expect, it, vi } from "vitest";
import { PaidAdmissionConsumerError, SignedPaidAdmissionConsumer, type PaidAdmissionClaims } from "./index.js";

const privateKey = new Uint8Array(32).fill(7);
const issuedAt = Date.now();
const claims: PaidAdmissionClaims = {
  audience: "blob-game-server",
  entryId: "entry_a",
  matchId: "match_a",
  roundId: "round_a",
  playerId: "player_a",
  rulesHash: "a".repeat(64),
  issuedAt,
  expiresAt: issuedAt + 60_000,
  nonce: "00000000-0000-4000-8000-000000000001"
};

describe("SignedPaidAdmissionConsumer", () => {
  it("signs the exact internal payload and accepts only a 204 consume response", async () => {
    const send = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://platform-api.railway.internal:8080/internal/paid-admissions/consume");
      const body = Buffer.from(init?.body as Buffer);
      const signatureHeader = (init?.headers as Record<string, string>)["X-BLOB-Paid-Admission-Signature"];
      expect(signatureHeader).toBeTypeOf("string");
      const signature = Buffer.from(signatureHeader!, "base64");
      await expect(ed25519.verifyAsync(signature, body, await ed25519.getPublicKeyAsync(privateKey))).resolves.toBe(true);
      expect(JSON.parse(body.toString("utf8"))).toEqual({ token: "issued-ticket", claims });
      return new Response(null, { status: 204 });
    });
    const consumer = new SignedPaidAdmissionConsumer("http://platform-api.railway.internal:8080", privateKey, send);
    await expect(consumer.consume({ token: "issued-ticket", claims })).resolves.toBeUndefined();
  });

  it("fails closed for malformed claims and non-successful private responses", async () => {
    const consumer = new SignedPaidAdmissionConsumer("http://platform-api.railway.internal:8080", privateKey, async () => new Response(null, { status: 503 }));
    await expect(consumer.consume({ token: "issued-ticket", claims })).rejects.toMatchObject({ code: "ADMISSION_CONSUME_REJECTED" });
    await expect(consumer.consume({ token: "issued-ticket", claims: { ...claims, rulesHash: "invalid" } })).rejects.toBeInstanceOf(PaidAdmissionConsumerError);
  });
});
