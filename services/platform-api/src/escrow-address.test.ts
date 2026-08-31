import { describe, expect, it } from "vitest";
import { deriveEscrowAddressPlan, deriveEscrowEntryAddressPlan } from "./escrow-address.js";

const PROGRAM_ID = "Stake11111111111111111111111111111111111111";
const NATIVE_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("escrow account derivation", () => {
  it("is deterministic and ties a token account to the match, mint, and program", () => {
    const first = deriveEscrowAddressPlan({
      programId: PROGRAM_ID,
      matchId: "paid-match-test-01",
      nativeUsdcMint: NATIVE_USDC_MINT,
    });
    expect(first).toEqual({
      programId: PROGRAM_ID,
      platformConfigAddress: "CPLTjtdjKyezoriNgtpT1XcXjNwmAnV1Vv6s3t9qygVg",
      matchEscrowAddress: "778Fi51M9ZapG4PHmNPNKYsgMRns5wReaNwrZtkhifu9",
      escrowTokenAccountAddress: "JDt2fCTVYuY85oK7ARHc4pGP4R72p75PdXcRrVJiZGeq",
      platformConfigBump: 254,
      matchEscrowBump: 254,
    });
    expect(deriveEscrowAddressPlan({
      programId: PROGRAM_ID,
      matchId: "paid-match-test-01",
      nativeUsdcMint: NATIVE_USDC_MINT,
    })).toEqual(first);
    expect(deriveEscrowAddressPlan({
      programId: PROGRAM_ID,
      matchId: "paid-match-test-02",
      nativeUsdcMint: NATIVE_USDC_MINT,
    }).escrowTokenAccountAddress).not.toBe(first.escrowTokenAccountAddress);
  });

  it("rejects an invalid or intentionally undeployed program identity", () => {
    expect(() => deriveEscrowAddressPlan({
      programId: "not-a-public-key",
      matchId: "paid-match-test-01",
      nativeUsdcMint: NATIVE_USDC_MINT,
    })).toThrow("valid Solana public key");
    expect(() => deriveEscrowAddressPlan({
      programId: "11111111111111111111111111111111",
      matchId: "paid-match-test-01",
      nativeUsdcMint: NATIVE_USDC_MINT,
    })).toThrow("has not been configured for deployment");
  });

  it("derives the only entry PDA and standard USDC account for an enrolled wallet", () => {
    expect(deriveEscrowEntryAddressPlan({
      programId: PROGRAM_ID,
      matchEscrowAddress: "778Fi51M9ZapG4PHmNPNKYsgMRns5wReaNwrZtkhifu9",
      playerAddress: "7YttLkH3UQJfB73uExyGfEKvwR6LjhQmN6x2PRZKMrP2",
      nativeUsdcMint: NATIVE_USDC_MINT,
    })).toEqual({
      programId: PROGRAM_ID,
      matchEscrowAddress: "778Fi51M9ZapG4PHmNPNKYsgMRns5wReaNwrZtkhifu9",
      entryAddress: "6BaVZmas64fipk4Ps7PzFz4Mr4wDGjsrrwP3RmMZtgu9",
      playerTokenAccountAddress: "HfsN2VG4cqwiA7rYNzgR7EgE4bjrqYaBfmqJLgEaMEnM",
      entryBump: 255,
    });
  });
});
