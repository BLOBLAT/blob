import { describe, expect, it } from "vitest";
import { AdmissionTicketError, issuePaidAdmissionTicket, verifyPaidAdmissionTicket } from "./admission-ticket.js";

const SECRET = "a".repeat(48);
const NOW = new Date("2026-08-19T12:00:00.000Z");

describe("paid admission tickets", () => {
  it("issues a short-lived ticket that is bound to one match and round", () => {
    const issued = issuePaidAdmissionTicket({
      secret: SECRET,
      entryId: "entry-1",
      matchId: "match-1",
      roundId: "round-1",
      playerId: "player-1",
      walletAddress: "wallet-1",
      rulesHash: "rules-hash",
      now: NOW
    });
    expect(verifyPaidAdmissionTicket({ token: issued.token, secret: SECRET, expectedMatchId: "match-1", expectedRoundId: "round-1", now: NOW })).toMatchObject({ entryId: "entry-1", playerId: "player-1" });
  });

  it("rejects tampering, a wrong match, and an expired ticket", () => {
    const issued = issuePaidAdmissionTicket({ secret: SECRET, entryId: "entry", matchId: "match", roundId: "round", playerId: "player", walletAddress: "wallet", rulesHash: "hash", now: NOW, ttlMs: 10_000 });
    expect(() => verifyPaidAdmissionTicket({ token: issued.token + "x", secret: SECRET, expectedMatchId: "match", expectedRoundId: "round", now: NOW })).toThrow(AdmissionTicketError);
    expect(() => verifyPaidAdmissionTicket({ token: issued.token, secret: SECRET, expectedMatchId: "other", expectedRoundId: "round", now: NOW })).toThrow(AdmissionTicketError);
    expect(() => verifyPaidAdmissionTicket({ token: issued.token, secret: SECRET, expectedMatchId: "match", expectedRoundId: "round", now: new Date(NOW.getTime() + 10_000) })).toThrow(AdmissionTicketError);
  });
});
