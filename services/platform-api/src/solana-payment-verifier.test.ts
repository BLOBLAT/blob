import { describe, expect, it } from "vitest";
import { SolanaPaymentVerificationError, SolanaPaymentVerifier } from "./solana-payment-verifier.js";

const PAYER = "4Nd1m3sW3vJ3zN9WZ1xQ2u5d7i9K6p4YvTq8eR1sA2bC";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DESTINATION = "9xQeWvG816bUx9EPfEZgC3Jk6zR9aM2Qq8F4JZ2xAazC";
const SIGNATURE = "3vQB7B6MrGQZaxCuFg4oh".padEnd(88, "1");

describe("Solana USDC verification", () => {
  it("accepts exactly one finalized transferChecked instruction from the claimed signer", async () => {
    const verifier = createVerifier(createTransaction());
    await expect(verifier.verifyFinalizedUsdcTransfer(input())).resolves.toMatchObject({ signature: SIGNATURE, slot: 321 });
  });

  it("rejects a successful transaction with a wrong amount or unsigned claimed wallet", async () => {
    const wrongAmount = createVerifier(createTransaction("999999"));
    await expect(wrongAmount.verifyFinalizedUsdcTransfer(input())).rejects.toMatchObject({ code: "PAYMENT_TRANSFER_INVALID" });
    const unsigned = createVerifier({ ...createTransaction(), transaction: { message: { accountKeys: [{ pubkey: PAYER, signer: false }], instructions: [] } } });
    await expect(unsigned.verifyFinalizedUsdcTransfer(input())).rejects.toBeInstanceOf(SolanaPaymentVerificationError);
  });

  it("rejects a transaction that failed or has not reached finalized transaction data", async () => {
    const failed = createVerifier({ ...createTransaction(), meta: { err: { InstructionError: [0, "Custom"] } } });
    await expect(failed.verifyFinalizedUsdcTransfer(input())).rejects.toMatchObject({ code: "PAYMENT_NOT_FINALIZED" });
  });
});

function input() {
  return {
    signature: SIGNATURE,
    senderWalletAddress: PAYER,
    expectedMint: USDC_MINT,
    expectedDestinationTokenAccount: DESTINATION,
    expectedAmountBaseUnits: 1_000_000n
  };
}

function createVerifier(transaction: unknown): SolanaPaymentVerifier {
  return new SolanaPaymentVerifier({
    rpcUrl: "https://rpc.example.test",
    fetch: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "blob-payment-verification", result: transaction }), { status: 200 })
  });
}

function createTransaction(amount = "1000000") {
  return {
    slot: 321,
    meta: { err: null },
    transaction: {
      message: {
        accountKeys: [{ pubkey: PAYER, signer: true }],
        instructions: [{
          parsed: {
            type: "transferChecked",
            info: {
              authority: PAYER,
              destination: DESTINATION,
              mint: USDC_MINT,
              tokenAmount: { amount }
            }
          }
        }]
      }
    }
  };
}
