import { describe, expect, it } from "vitest";
import {
  ReferralError,
  ReferralService,
  type ReferralRepository,
} from "./referrals.js";

describe("referral service", () => {
  it("normalizes an opaque referral code and keeps capture server-side", async () => {
    const calls: Array<{ refereeUserId: string; code: string }> = [];
    const service = new ReferralService({
      ...repository(),
      captureAttribution: async (input) => {
        calls.push(input);
        return "CAPTURED";
      },
    }, { referrer: 100n, referee: 25n });

    await expect(service.captureAttribution({
      refereeUserId: "aa3b4583-48e4-4963-b32d-b18be97e1dc6",
      code: "  abcd234567  ",
    })).resolves.toBe("CAPTURED");
    expect(calls).toEqual([{
      refereeUserId: "aa3b4583-48e4-4963-b32d-b18be97e1dc6",
      code: "ABCD234567",
      now: expect.any(Date),
    }]);
  });

  it("rejects malformed and self-referral codes before any points can be created", async () => {
    const service = new ReferralService({
      ...repository(),
      captureAttribution: async () => {
        throw { code: "REFERRAL_SELF_NOT_ALLOWED" };
      },
    }, { referrer: 100n, referee: 25n });

    await expect(service.captureAttribution({
      refereeUserId: "aa3b4583-48e4-4963-b32d-b18be97e1dc6",
      code: "not a code",
    })).rejects.toMatchObject({ code: "REFERRAL_CODE_INVALID" });
    await expect(service.captureAttribution({
      refereeUserId: "aa3b4583-48e4-4963-b32d-b18be97e1dc6",
      code: "ABCD234567",
    })).rejects.toMatchObject({ code: "REFERRAL_SELF_NOT_ALLOWED" });
  });

  it("passes only configured integer point awards to a server-confirmed qualification", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const service = new ReferralService({
      ...repository(),
      qualifyReferral: async (input) => {
        calls.push(input);
        return "QUALIFIED";
      },
    }, { referrer: 100n, referee: 25n });

    await expect(service.qualify({
      profileUserId: "aa3b4583-48e4-4963-b32d-b18be97e1dc6",
      matchId: "free-match-1",
      roundId: "round-1",
      sourceEventId: "free-round:free-match-1:round-1:aa3b4583-48e4-4963-b32d-b18be97e1dc6",
      completedAt: new Date("2026-08-28T12:00:00.000Z"),
    })).resolves.toBe("QUALIFIED");
    expect(calls).toEqual([{
      profileUserId: "aa3b4583-48e4-4963-b32d-b18be97e1dc6",
      matchId: "free-match-1",
      roundId: "round-1",
      sourceEventId: "free-round:free-match-1:round-1:aa3b4583-48e4-4963-b32d-b18be97e1dc6",
      completedAt: new Date("2026-08-28T12:00:00.000Z"),
      referrerPoints: 100n,
      refereePoints: 25n,
    }]);
  });
});

function repository(): ReferralRepository {
  return {
    getDashboard: async () => ({
      code: "ABCD234567",
      totalPoints: 0n,
      invitedCount: 0,
      qualifiedCount: 0,
      referralBound: false,
      recentEntries: [],
    }),
    captureAttribution: async () => "ALREADY_ATTRIBUTED",
    qualifyReferral: async () => "NOT_ATTRIBUTED",
  };
}
