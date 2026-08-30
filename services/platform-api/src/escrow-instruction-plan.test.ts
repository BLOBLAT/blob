import { describe, expect, it } from "vitest";
import { DEFAULT_PAID_MATCH_CONFIGURATION, PaidRuleset } from "@blob/shared";
import { createEscrowCreateMatchPlan, hashEscrowIdentifier } from "./escrow-instruction-plan.js";
import { createPaidMatchTerms } from "./paid-match.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ESCROW = "9xQeWvG816bUx9EPfEZgC3Jk6zR9aM2Qq8F4JZ2xAazC";
const ROLES = {
  platformAuthority: "4Nd1m3sW3vJ3zN9WZ1xQ2u5d7i9K6p4YvTq8eR1sA2bC",
  matchController: "7YttLkH3UQJfB73uExyGfEKvwR6LjhQmN6x2PRZKMrP2",
  resultAuthority: "B6xXoQkbXZp27DiNUZCr36N54xe69Bp5uzWUsWeLMYqV",
  treasury: "So11111111111111111111111111111111111111112"
};
const NOW = new Date("2026-08-31T02:30:00.000Z");

describe("escrow create-match plan", () => {
  it("maps durable server terms into exactly the on-chain creation fields", () => {
    const terms = createPaidMatchTerms({
      usdcMint: USDC_MINT,
      escrowAddress: ESCROW,
      now: NOW,
      fundingDeadline: new Date("2026-08-31T02:35:00.000Z")
    });
    const plan = createEscrowCreateMatchPlan(terms, ROLES);

    expect(plan.matchIdHash).toBe(hashEscrowIdentifier("match", terms.matchId));
    expect(plan.roundIdHash).toBe(hashEscrowIdentifier("round", terms.roundId));
    expect(plan.entryAmountBaseUnits).toBe(DEFAULT_PAID_MATCH_CONFIGURATION.entryAmountBaseUnits);
    expect(plan.payoutBps).toEqual([5_500, 3_000, 1_500]);
    expect(plan.fundingDeadlineUnixSeconds).toBe(1_788_143_700n);
    expect(plan.roundDurationSeconds).toBe(600n);
    expect(plan.onchainRulesHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the on-chain commitment for a changed role or immutable term", () => {
    const terms = createPaidMatchTerms({ usdcMint: USDC_MINT, escrowAddress: ESCROW, now: NOW });
    const base = createEscrowCreateMatchPlan(terms, ROLES);
    expect(createEscrowCreateMatchPlan(terms, { ...ROLES, treasury: "Stake11111111111111111111111111111111111111" }).onchainRulesHash)
      .not.toBe(base.onchainRulesHash);
    expect(createEscrowCreateMatchPlan({ ...terms, fundingDeadline: new Date("2026-08-31T02:34:00.000Z") }, ROLES).onchainRulesHash)
      .not.toBe(base.onchainRulesHash);
  });

  it("rejects fractional timestamps, malformed IDs, and mismatched ruleset policy", () => {
    const terms = createPaidMatchTerms({ usdcMint: USDC_MINT, escrowAddress: ESCROW, now: NOW });
    expect(() => createEscrowCreateMatchPlan({ ...terms, fundingDeadline: new Date("2026-08-31T02:35:00.123Z") }, ROLES))
      .toThrow("whole-second precision");
    expect(() => hashEscrowIdentifier("match", "match id with spaces")).toThrow("identifier is invalid");
    expect(() => createEscrowCreateMatchPlan({
      ...terms,
      ruleset: PaidRuleset.REBUY
    }, ROLES)).toThrow("ruleset and revive policy disagree");
  });
});
