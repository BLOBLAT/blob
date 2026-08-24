import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import * as ed25519 from "@noble/ed25519";
import { AdmissionTicketError, issuePaidAdmissionTicket, verifyPaidAdmissionTicket } from "./admission-ticket.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");

describe("paid admission tickets", () => {
  it("issues a short-lived ticket that is bound to one match and round", async () => {
    const privateKey = createTestPrivateKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const issued = await issuePaidAdmissionTicket({
      privateKey,
      entryId: "entry-1",
      matchId: "match-1",
      roundId: "round-1",
      playerId: "player-1",
      rulesHash: "rules-hash",
      now: NOW
    });
    const claims = await verifyPaidAdmissionTicket({ token: issued.token, publicKey, expectedMatchId: "match-1", expectedRoundId: "round-1", now: NOW });
    expect(claims).toMatchObject({ entryId: "entry-1", playerId: "player-1" });
    expect(claims).not.toHaveProperty("walletAddress");
  });

  it("rejects tampering, the wrong verification key, a wrong match, and expiry", async () => {
    const privateKey = createTestPrivateKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const wrongPublicKey = await ed25519.getPublicKeyAsync(createTestPrivateKey());
    const issued = await issuePaidAdmissionTicket({ privateKey, entryId: "entry", matchId: "match", roundId: "round", playerId: "player", rulesHash: "hash", now: NOW, ttlMs: 10_000 });
    await expect(verifyPaidAdmissionTicket({ token: issued.token + "x", publicKey, expectedMatchId: "match", expectedRoundId: "round", now: NOW })).rejects.toBeInstanceOf(AdmissionTicketError);
    await expect(verifyPaidAdmissionTicket({ token: "x".repeat(3_000), publicKey, expectedMatchId: "match", expectedRoundId: "round", now: NOW })).rejects.toBeInstanceOf(AdmissionTicketError);
    await expect(verifyPaidAdmissionTicket({ token: issued.token, publicKey: wrongPublicKey, expectedMatchId: "match", expectedRoundId: "round", now: NOW })).rejects.toBeInstanceOf(AdmissionTicketError);
    await expect(verifyPaidAdmissionTicket({ token: issued.token, publicKey, expectedMatchId: "other", expectedRoundId: "round", now: NOW })).rejects.toBeInstanceOf(AdmissionTicketError);
    await expect(verifyPaidAdmissionTicket({ token: issued.token, publicKey, expectedMatchId: "match", expectedRoundId: "round", now: new Date(NOW.getTime() + 10_000) })).rejects.toBeInstanceOf(AdmissionTicketError);
  });

  it("rejects a correctly signed payload with malformed claims", async () => {
    const privateKey = createTestPrivateKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const encodedPayload = Buffer.from(JSON.stringify({
      audience: "blob-game-server",
      entryId: 42,
      matchId: "match",
      roundId: "round",
      playerId: "player",
      rulesHash: "hash",
      issuedAt: NOW.getTime(),
      expiresAt: NOW.getTime() + 60_000,
      nonce: "nonce"
    }), "utf8").toString("base64url");
    const signature = await ed25519.signAsync(new TextEncoder().encode(encodedPayload), privateKey);
    const token = encodedPayload + "." + Buffer.from(signature).toString("base64url");
    await expect(verifyPaidAdmissionTicket({ token, publicKey, expectedMatchId: "match", expectedRoundId: "round", now: NOW })).rejects.toBeInstanceOf(AdmissionTicketError);
  });
});

function createTestPrivateKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}
