import { describe, expect, it } from "vitest";
import {
  createMatchInstructionDiscriminator,
  serializeCreateMatchInstructionData
} from "./escrow-create-match-abi.js";
import type { EscrowCreateMatchPlan } from "./escrow-instruction-plan.js";

const PLAN: EscrowCreateMatchPlan = {
  matchIdHash: "11".repeat(32),
  roundIdHash: "22".repeat(32),
  onchainRulesHash: "33".repeat(32),
  entryAmountBaseUnits: 1_000_000n,
  payoutDeliveryFeeBps: 100,
  reviveEnabled: true,
  reviveAmountBaseUnits: 500_000n,
  participationRebateBps: 1_000,
  payoutBps: [5_500, 3_000, 1_500],
  minimumPlayers: 6,
  maximumPlayers: 32,
  fundingDeadlineUnixSeconds: 1_787_000_000n,
  roundDurationSeconds: 600n,
  reviveWindowSeconds: 30n,
  reviveCutoffSeconds: 180n
};

describe("create_match Anchor ABI", () => {
  it("uses the Anchor discriminator and a fixed-size, little-endian argument layout", () => {
    const data = serializeCreateMatchInstructionData(PLAN);

    expect(data).toHaveLength(167);
    expect(data.subarray(0, 8)).toEqual(createMatchInstructionDiscriminator());
    expect(data.subarray(8, 40).toString("hex")).toBe(PLAN.matchIdHash);
    expect(data.subarray(40, 72).toString("hex")).toBe(PLAN.roundIdHash);
    expect(data.subarray(72, 104).toString("hex")).toBe(PLAN.onchainRulesHash);
    expect(data.readBigUInt64LE(104)).toBe(1_000_000n);
    expect(data.readUInt16LE(112)).toBe(100);
    expect(data.readUInt8(114)).toBe(1);
    expect(data.readBigUInt64LE(115)).toBe(500_000n);
    expect(data.readUInt16LE(123)).toBe(1_000);
    expect(data.readUInt16LE(125)).toBe(5_500);
    expect(data.readUInt16LE(127)).toBe(3_000);
    expect(data.readUInt16LE(129)).toBe(1_500);
    expect(data.readUInt16LE(131)).toBe(6);
    expect(data.readUInt16LE(133)).toBe(32);
    expect(data.readBigInt64LE(135)).toBe(1_787_000_000n);
    expect(data.readBigInt64LE(143)).toBe(600n);
    expect(data.readBigInt64LE(151)).toBe(30n);
    expect(data.readBigInt64LE(159)).toBe(180n);
  });

  it("fails closed for values that cannot be represented by the chain ABI", () => {
    expect(() => serializeCreateMatchInstructionData({ ...PLAN, matchIdHash: "not-a-hash" }))
      .toThrow("must be 32-byte SHA-256 hex");
    expect(() => serializeCreateMatchInstructionData({ ...PLAN, minimumPlayers: -1 }))
      .toThrow("must fit in u16");
    expect(() => serializeCreateMatchInstructionData({ ...PLAN, entryAmountBaseUnits: -1n }))
      .toThrow("must fit in u64");
  });
});
