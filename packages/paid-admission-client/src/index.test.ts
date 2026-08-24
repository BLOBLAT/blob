import * as ed25519 from "@noble/ed25519";
import { describe, expect, it, vi } from "vitest";
import {
  PaidAdmissionConsumerError,
  SignedPaidAdmissionConsumer,
  verifyPaidAdmissionTicket,
  type PaidAdmissionClaims,
} from "./index.js";

const privateKey = new Uint8Array(32).fill(7);
const ticketPrivateKey = new Uint8Array(32).fill(9);
const issuedAt = new Date("2026-08-24T12:00:00.000Z").getTime();
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
    const ticketIssuerPublicKey = await ed25519.getPublicKeyAsync(ticketPrivateKey);
    const token = await signTicket(claims, ticketPrivateKey);
    const send = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://platform-api.railway.internal:8080/internal/paid-admissions/consume");
      const body = Buffer.from(init?.body as Buffer);
      const signatureHeader = (init?.headers as Record<string, string>)["X-BLOB-Paid-Admission-Signature"];
      expect(signatureHeader).toBeTypeOf("string");
      const signature = Buffer.from(signatureHeader!, "base64");
      await expect(ed25519.verifyAsync(signature, body, await ed25519.getPublicKeyAsync(privateKey))).resolves.toBe(true);
      expect(JSON.parse(body.toString("utf8"))).toEqual({ token, claims });
      return new Response(null, { status: 204 });
    });
    const consumer = new SignedPaidAdmissionConsumer("http://platform-api.railway.internal:8080", privateKey, ticketIssuerPublicKey, send);
    await expect(consumer.consume({ token, expectedMatchId: "match_a", expectedRoundId: "round_a", now: new Date(issuedAt) })).resolves.toEqual(claims);
  });

  it("normalizes a valid trailing slash without changing the signed request path", async () => {
    const ticketIssuerPublicKey = await ed25519.getPublicKeyAsync(ticketPrivateKey);
    const token = await signTicket(claims, ticketPrivateKey);
    const send = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("http://platform-api.railway.internal:8080/internal/paid-admissions/consume");
      return new Response(null, { status: 204 });
    });
    const consumer = new SignedPaidAdmissionConsumer("http://platform-api.railway.internal:8080/", privateKey, ticketIssuerPublicKey, send);
    await expect(consumer.consume({ token, expectedMatchId: "match_a", expectedRoundId: "round_a", now: new Date(issuedAt) })).resolves.toEqual(claims);
  });

  it("fails closed for invalid tickets and non-successful private responses", async () => {
    const ticketIssuerPublicKey = await ed25519.getPublicKeyAsync(ticketPrivateKey);
    const token = await signTicket(claims, ticketPrivateKey);
    const consumer = new SignedPaidAdmissionConsumer("http://platform-api.railway.internal:8080", privateKey, ticketIssuerPublicKey, async () => new Response(null, { status: 503 }));
    await expect(consumer.consume({ token, expectedMatchId: "match_a", expectedRoundId: "round_a", now: new Date(issuedAt) })).rejects.toMatchObject({ code: "ADMISSION_CONSUME_REJECTED" });
    await expect(consumer.consume({ token: token + "x", expectedMatchId: "match_a", expectedRoundId: "round_a", now: new Date(issuedAt) })).rejects.toBeInstanceOf(PaidAdmissionConsumerError);
  });

  it("rejects a valid signature bound to another match before calling Platform API", async () => {
    const ticketIssuerPublicKey = await ed25519.getPublicKeyAsync(ticketPrivateKey);
    const token = await signTicket(claims, ticketPrivateKey);
    const send = vi.fn();
    const consumer = new SignedPaidAdmissionConsumer("http://platform-api.railway.internal:8080", privateKey, ticketIssuerPublicKey, send);
    await expect(consumer.consume({ token, expectedMatchId: "other-match", expectedRoundId: "round_a", now: new Date(issuedAt) })).rejects.toMatchObject({ code: "ADMISSION_TICKET_INVALID" });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a malformed but correctly signed claims payload", async () => {
    const ticketIssuerPublicKey = await ed25519.getPublicKeyAsync(ticketPrivateKey);
    const malformed = await signTicket({ ...claims, playerId: "player/not-safe" }, ticketPrivateKey);
    await expect(verifyPaidAdmissionTicket({
      token: malformed,
      publicKey: ticketIssuerPublicKey,
      expectedMatchId: "match_a",
      expectedRoundId: "round_a",
      now: new Date(issuedAt),
    })).rejects.toBeInstanceOf(PaidAdmissionConsumerError);
  });

  it("refuses a public or malformed consume origin", async () => {
    const ticketIssuerPublicKey = await ed25519.getPublicKeyAsync(ticketPrivateKey);
    expect(() => new SignedPaidAdmissionConsumer("https://api.blob.lat", privateKey, ticketIssuerPublicKey))
      .toThrow("Paid admission consumer configuration is invalid.");
    expect(() => new SignedPaidAdmissionConsumer("http://platform-api.railway.internal.evil.example", privateKey, ticketIssuerPublicKey))
      .toThrow("Paid admission consumer configuration is invalid.");
    expect(() => new SignedPaidAdmissionConsumer("http://user:password@platform-api.railway.internal:8080", privateKey, ticketIssuerPublicKey))
      .toThrow("Paid admission consumer configuration is invalid.");
    expect(() => new SignedPaidAdmissionConsumer("http://platform-api.railway.internal:0", privateKey, ticketIssuerPublicKey))
      .toThrow("Paid admission consumer configuration is invalid.");
  });
});

async function signTicket(value: PaidAdmissionClaims, signingKey: Uint8Array): Promise<string> {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signature = await ed25519.signAsync(new TextEncoder().encode(payload), signingKey);
  return payload + "." + Buffer.from(signature).toString("base64url");
}
