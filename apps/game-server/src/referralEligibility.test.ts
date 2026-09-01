import { ArenaPhase } from "@blob/protocol";
import { describe, expect, it } from "vitest";
import { createEligibleReferralQualificationRecords } from "./BlobArenaRoom.js";

const PLAYER_ID = "player-one";
const PROFILE_USER_ID = "f80120b1-cd50-4bf8-932e-0fb67e87330d";

describe("Free Mode referral eligibility handoff", () => {
  it("uses only current server-owned activity for a signed referral fact", () => {
    const snapshot = {
      mode: "FREE",
      phase: ArenaPhase.ACTIVE,
      matchId: "free-match-14",
      roundId: "round-14",
      serverTime: 1_234_567,
      players: [
        { id: PLAYER_ID, isBot: false, inRound: true, foodCollected: 20, survivalTimeMs: 120_000 },
        { id: "arena-bot", isBot: true, inRound: true, foodCollected: 9_999, survivalTimeMs: 120_000 },
        { id: "waiting-player", isBot: false, inRound: false, foodCollected: 99, survivalTimeMs: 999_999 },
      ],
    } as Parameters<typeof createEligibleReferralQualificationRecords>[0];

    expect(createEligibleReferralQualificationRecords(snapshot, new Map([[PLAYER_ID, PROFILE_USER_ID]]))).toEqual([{
      eventId: "free-round:free-match-14:round-14:" + PROFILE_USER_ID,
      profileUserId: PROFILE_USER_ID,
      matchId: "free-match-14",
      roundId: "round-14",
      completedAt: 1_234_567,
      foodCollected: 20,
      survivalTimeMs: 120_000,
    }]);
  });

  it("does not send browser-looking activity during a non-active phase", () => {
    const snapshot = {
      mode: "FREE",
      phase: ArenaPhase.COUNTDOWN,
      matchId: "free-match-15",
      roundId: "round-15",
      serverTime: 10,
      players: [],
    } as Parameters<typeof createEligibleReferralQualificationRecords>[0];

    expect(createEligibleReferralQualificationRecords(snapshot, new Map())).toEqual([]);
  });
});
