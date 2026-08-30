import { describe, expect, it } from "vitest";
import { createEscrowRulesHash } from "./escrow-rules-hash.js";

const INPUT = {
  matchIdHash: "11".repeat(32),
  roundIdHash: "22".repeat(32),
  nativeUsdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  platformAuthority: "4Nd1m3sW3vJ3zN9WZ1xQ2u5d7i9K6p4YvTq8eR1sA2bC",
  matchController: "7YttLkH3UQJfB73uExyGfEKvwR6LjhQmN6x2PRZKMrP2",
  resultAuthority: "B6xXoQkbXZp27DiNUZCr36N54xe69Bp5uzWUsWeLMYqV",
  treasury: "So11111111111111111111111111111111111111112",
  entryAmountBaseUnits: 1_000_000n,
  payoutDeliveryFeeBps: 0,
  reviveEnabled: false,
  reviveAmountBaseUnits: 0n,
  participationRebateBps: 1_000,
  payoutBps: [5_500, 3_000, 1_500] as const,
  minimumPlayers: 6,
  maximumPlayers: 10,
  fundingDeadlineUnixSeconds: 1_787_000_000n,
  roundDurationSeconds: 600n,
  reviveWindowSeconds: 0n,
  reviveCutoffSeconds: 0n
};

describe("canonical escrow rules hash", () => {
  it("is a stable versioned commitment for the Anchor create-match layout", () => {
    expect(createEscrowRulesHash(INPUT)).toBe("0d4891607fe2107b946aac5785a73bb20d4c205afa0484a3e5ef744082908d1f");
  });

  it("changes when an immutable rule or operational role changes", () => {
    const base = createEscrowRulesHash(INPUT);
    expect(createEscrowRulesHash({ ...INPUT, payoutDeliveryFeeBps: 100 })).not.toBe(base);
    expect(createEscrowRulesHash({ ...INPUT, minimumPlayers: 7 })).not.toBe(base);
    expect(createEscrowRulesHash({ ...INPUT, reviveEnabled: true, reviveAmountBaseUnits: 500_000n, reviveWindowSeconds: 30n, reviveCutoffSeconds: 180n })).not.toBe(base);
    expect(createEscrowRulesHash({ ...INPUT, treasury: "Stake11111111111111111111111111111111111111" })).not.toBe(base);
  });

  it("rejects malformed identifiers and role separation failures", () => {
    expect(() => createEscrowRulesHash({ ...INPUT, matchIdHash: "x".repeat(64) })).toThrow("SHA-256");
    expect(() => createEscrowRulesHash({ ...INPUT, resultAuthority: INPUT.matchController })).toThrow("distinct non-zero");
    expect(() => createEscrowRulesHash({ ...INPUT, maximumPlayers: 70_000 })).toThrow("u16");
  });
});
