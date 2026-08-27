import { ArenaInputRejectionReason } from "@blob/game-core";
import { describe, expect, it } from "vitest";
import {
  InputAbuseGuard,
  MAX_INVALID_INPUTS_PER_WINDOW,
  MAX_RATE_LIMITED_INPUTS_PER_WINDOW,
} from "./inputAbuseGuard.js";

describe("InputAbuseGuard", () => {
  it("escalates repeated malformed input but ignores normal inactive-player rejections", () => {
    const guard = new InputAbuseGuard();
    expect(guard.recordSimulationRejection("player", ArenaInputRejectionReason.ROUND_NOT_ACTIVE, 1)).toBeUndefined();

    for (let index = 0; index < MAX_INVALID_INPUTS_PER_WINDOW - 1; index += 1) {
      expect(guard.recordMalformed("player", 100 + index).disconnect).toBe(false);
    }
    expect(guard.recordMalformed("player", 200)).toEqual({ category: "INVALID", count: MAX_INVALID_INPUTS_PER_WINDOW, disconnect: true });
  });

  it("keeps rate-limit escalation deliberately tolerant and expires a violation window", () => {
    const guard = new InputAbuseGuard();
    for (let index = 0; index < MAX_RATE_LIMITED_INPUTS_PER_WINDOW - 1; index += 1) {
      expect(guard.recordSimulationRejection("player", ArenaInputRejectionReason.RATE_LIMITED, 1_000 + index)?.disconnect).toBe(false);
    }
    expect(guard.recordSimulationRejection("player", ArenaInputRejectionReason.RATE_LIMITED, 1_200)).toEqual({ category: "RATE", count: MAX_RATE_LIMITED_INPUTS_PER_WINDOW, disconnect: true });
    expect(guard.recordMalformed("player", 12_000)).toEqual({ category: "INVALID", count: 1, disconnect: false });
  });
});
