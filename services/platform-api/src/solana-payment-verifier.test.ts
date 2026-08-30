import { describe, expect, it } from "vitest";
import { SolanaPaymentVerificationError, SolanaPaymentVerifier } from "./solana-payment-verifier.js";

const PAYER = "4Nd1m3sW3vJ3zN9WZ1xQ2u5d7i9K6p4YvTq8eR1sA2bC";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DESTINATION = "9xQeWvG816bUx9EPfEZgC3Jk6zR9aM2Qq8F4JZ2xAazC";
const SOURCE_TOKEN_ACCOUNT = "8YFR1sA2bC4Nd1m3sW3vJ3zN9WZ1xQ2u5d7i9K6p4YvTq";
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

  it("rejects a transfer that is not a six-decimal legacy SPL USDC instruction", async () => {
    const wrongDecimals = createVerifier(createTransaction("1000000", 9));
    await expect(wrongDecimals.verifyFinalizedUsdcTransfer(input())).rejects.toMatchObject({ code: "PAYMENT_TRANSFER_INVALID" });
    const wrongProgram = createVerifier(createTransaction("1000000", 6, "TokenzQdYndQqF8HhXjYTa2tTe9mipM9K6o6nqR3GmW"));
    await expect(wrongProgram.verifyFinalizedUsdcTransfer(input())).rejects.toMatchObject({ code: "PAYMENT_TRANSFER_INVALID" });
  });

  it("rejects an ambiguous transaction containing the expected transfer more than once", async () => {
    const duplicate = createTransaction();
    const original = duplicate.transaction.message.instructions[0]!;
    duplicate.transaction.message.instructions.push(structuredClone(original));

    await expect(createVerifier(duplicate).verifyFinalizedUsdcTransfer(input()))
      .rejects.toMatchObject({ code: "PAYMENT_TRANSFER_INVALID" });
  });

  it("rejects a delegated or unproven source token account even when the claimed wallet signed", async () => {
    const delegatedAuthority = createTransaction();
    delegatedAuthority.meta.preTokenBalances = [{ accountIndex: 1, mint: USDC_MINT, owner: DESTINATION }];
    await expect(createVerifier(delegatedAuthority).verifyFinalizedUsdcTransfer(input()))
      .rejects.toMatchObject({ code: "PAYMENT_TRANSFER_INVALID" });

    const sourceOwnershipUnavailable = createTransaction();
    sourceOwnershipUnavailable.meta.preTokenBalances = [];
    await expect(createVerifier(sourceOwnershipUnavailable).verifyFinalizedUsdcTransfer(input()))
      .rejects.toMatchObject({ code: "PAYMENT_TRANSFER_INVALID" });
  });

  it("rejects a transaction that failed or has not reached finalized transaction data", async () => {
    const failed = createVerifier({ ...createTransaction(), meta: { err: { InstructionError: [0, "Custom"] } } });
    await expect(failed.verifyFinalizedUsdcTransfer(input())).rejects.toMatchObject({ code: "PAYMENT_NOT_FINALIZED" });
  });

  it("rejects base58-shaped references with the wrong decoded byte length before RPC", async () => {
    let rpcRequests = 0;
    const verifier = new SolanaPaymentVerifier({
      rpcUrl: "https://rpc.example.test",
      fetch: async () => {
        rpcRequests += 1;
        return new Response(JSON.stringify({ result: createTransaction() }), { status: 200 });
      }
    });

    await expect(verifier.verifyFinalizedUsdcTransfer({
      ...input(),
      senderWalletAddress: "1".repeat(33)
    })).rejects.toMatchObject({ code: "PAYMENT_REFERENCE_INVALID" });
    await expect(verifier.verifyFinalizedUsdcTransfer({
      ...input(),
      signature: "1".repeat(88)
    })).rejects.toMatchObject({ code: "PAYMENT_REFERENCE_INVALID" });
    expect(rpcRequests).toBe(0);
  });

  it("rejects invalid token amounts before contacting RPC", async () => {
    let rpcRequests = 0;
    const verifier = new SolanaPaymentVerifier({
      rpcUrl: "https://rpc.example.test",
      fetch: async () => {
        rpcRequests += 1;
        return new Response(JSON.stringify({ result: createTransaction() }), { status: 200 });
      }
    });

    await expect(verifier.verifyFinalizedUsdcTransfer({ ...input(), expectedAmountBaseUnits: 0n }))
      .rejects.toMatchObject({ code: "PAYMENT_AMOUNT_INVALID" });
    await expect(verifier.verifyFinalizedUsdcTransfer({
      ...input(),
      expectedAmountBaseUnits: 18_446_744_073_709_551_616n
    })).rejects.toMatchObject({ code: "PAYMENT_AMOUNT_INVALID" });
    await expect(verifier.verifyFinalizedUsdcTransfer({
      ...input(),
      expectedAmountBaseUnits: 1_000_000 as unknown as bigint
    })).rejects.toMatchObject({ code: "PAYMENT_AMOUNT_INVALID" });
    expect(rpcRequests).toBe(0);
  });

  it("rejects a malformed RPC slot even when the transfer fields match", async () => {
    const verifier = createVerifier({ ...createTransaction(), slot: -1 });
    await expect(verifier.verifyFinalizedUsdcTransfer(input())).rejects.toMatchObject({ code: "PAYMENT_NOT_FINALIZED" });
  });

  it("uses the finalized chain block time and rejects a transaction without one", async () => {
    const verifier = createVerifier(createTransaction());
    await expect(verifier.verifyFinalizedUsdcTransfer(input()))
      .resolves.toMatchObject({ finalizedAt: new Date("2026-06-24T16:33:20.000Z") });
    const missingBlockTime = createVerifier({ ...createTransaction(), blockTime: null });
    await expect(missingBlockTime.verifyFinalizedUsdcTransfer(input()))
      .rejects.toMatchObject({ code: "PAYMENT_NOT_FINALIZED" });
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

function createTransaction(
  amount = "1000000",
  decimals = 6,
  programId = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
) {
  return {
    slot: 321,
    blockTime: 1_782_318_800,
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 1, mint: USDC_MINT, owner: PAYER }]
    },
    transaction: {
      message: {
        accountKeys: [{ pubkey: PAYER, signer: true }, { pubkey: SOURCE_TOKEN_ACCOUNT, signer: false }],
        instructions: [{
          programId,
          parsed: {
            type: "transferChecked",
            info: {
              authority: PAYER,
              source: SOURCE_TOKEN_ACCOUNT,
              destination: DESTINATION,
              mint: USDC_MINT,
              tokenAmount: { amount, decimals }
            }
          }
        }]
      }
    }
  };
}
