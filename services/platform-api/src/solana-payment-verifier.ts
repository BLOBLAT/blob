import { base58 } from "@scure/base";

/**
 * Minimal, dependency-free Solana JSON-RPC verifier for a completed SPL USDC
 * transfer. It performs no signing and cannot move funds. The caller must
 * persist a unique transaction signature before admitting a player.
 */
export interface VerifySolanaUsdcTransferInput {
  signature: string;
  senderWalletAddress: string;
  expectedMint: string;
  expectedDestinationTokenAccount: string;
  expectedAmountBaseUnits: bigint;
}

export interface VerifiedSolanaUsdcTransfer {
  signature: string;
  slot: number;
  finalizedAt: Date;
}

export interface SolanaRpcVerifierOptions {
  rpcUrl: string;
  fetch?: typeof fetch;
}

export class SolanaPaymentVerifier {
  private readonly fetch: typeof fetch;

  constructor(private readonly options: SolanaRpcVerifierOptions) {
    if (!isHttpsUrl(options.rpcUrl)) {
      throw new Error("SOLANA_RPC_URL must be an HTTPS URL.");
    }
    this.fetch = options.fetch ?? fetch;
  }

  async verifyFinalizedUsdcTransfer(input: VerifySolanaUsdcTransferInput): Promise<VerifiedSolanaUsdcTransfer> {
    assertPositiveAmount(input.expectedAmountBaseUnits);
    assertTransactionSignature(input.signature);
    assertSolanaAddress(input.senderWalletAddress, "sender wallet");
    assertSolanaAddress(input.expectedMint, "USDC mint");
    assertSolanaAddress(input.expectedDestinationTokenAccount, "destination token account");

    const transaction = await this.getTransaction(input.signature);
    const slot = transaction?.slot;
    const blockTime = transaction?.blockTime;
    const finalizedAtMs = typeof blockTime === "number" ? blockTime * 1_000 : NaN;
    if (!transaction || transaction.meta?.err !== null || typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0
      || typeof blockTime !== "number" || !Number.isSafeInteger(blockTime) || blockTime < 0 || !Number.isSafeInteger(finalizedAtMs)) {
      throw new SolanaPaymentVerificationError("PAYMENT_NOT_FINALIZED", "USDC payment is not finalized successfully.");
    }
    if (!hasSigner(transaction.transaction?.message?.accountKeys, input.senderWalletAddress)) {
      throw new SolanaPaymentVerificationError("PAYMENT_SENDER_INVALID", "The claimed wallet did not sign this payment.");
    }
    const instructions = collectParsedInstructions(transaction);
    const expectedAmount = input.expectedAmountBaseUnits.toString();
    const matchingSources = instructions
      .map((instruction) => getExpectedUsdcTransferSource(instruction, input, expectedAmount))
      .filter((source): source is string => source !== null);
    if (matchingSources.length !== 1 || !isSourceTokenAccountOwnedBySender(transaction, matchingSources[0], input)) {
      throw new SolanaPaymentVerificationError("PAYMENT_TRANSFER_INVALID", "The finalized transaction does not contain the expected USDC transfer.");
    }
    return { signature: input.signature, slot, finalizedAt: new Date(finalizedAtMs) };
  }

  private async getTransaction(signature: string): Promise<RpcTransaction | null> {
    let response: Response;
    try {
      response = await this.fetch(this.options.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "blob-payment-verification",
          method: "getTransaction",
          params: [signature, { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]
        })
      });
    } catch {
      throw new SolanaPaymentVerificationError("RPC_UNAVAILABLE", "Could not reach the Solana verifier.");
    }
    if (!response.ok) {
      throw new SolanaPaymentVerificationError("RPC_UNAVAILABLE", "Could not reach the Solana verifier.");
    }
    const payload = await response.json().catch(() => null) as { result?: RpcTransaction | null; error?: unknown } | null;
    if (!payload || payload.error) {
      throw new SolanaPaymentVerificationError("RPC_INVALID_RESPONSE", "Solana verifier returned an invalid response.");
    }
    return payload.result ?? null;
  }
}

export class SolanaPaymentVerificationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

interface RpcTransaction {
  slot?: number;
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    innerInstructions?: Array<{ instructions?: unknown[] }>;
    preTokenBalances?: Array<{ accountIndex?: unknown; mint?: unknown; owner?: unknown }>;
  };
  transaction?: { message?: { accountKeys?: unknown[]; instructions?: unknown[] } };
}

function collectParsedInstructions(transaction: RpcTransaction): unknown[] {
  return [
    ...(transaction.transaction?.message?.instructions ?? []),
    ...(transaction.meta?.innerInstructions ?? []).flatMap((entry) => entry.instructions ?? [])
  ];
}

function hasSigner(accountKeys: unknown[] | undefined, walletAddress: string): boolean {
  return Boolean(accountKeys?.some((account) => {
    const record = account as { pubkey?: unknown; signer?: unknown };
    return record.pubkey === walletAddress && record.signer === true;
  }));
}

function getExpectedUsdcTransferSource(
  instruction: unknown,
  input: VerifySolanaUsdcTransferInput,
  expectedAmount: string
): string | null {
  const record = instruction as {
    programId?: unknown;
    parsed?: { type?: unknown; info?: Record<string, unknown> };
  };
  if (record.parsed?.type !== "transferChecked") {
    return null;
  }
  const info = record.parsed.info;
  const tokenAmount = info?.tokenAmount as { amount?: unknown; decimals?: unknown } | undefined;
  const source = info?.source;
  const isExpectedTransfer = record.programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    && info?.authority === input.senderWalletAddress
    && info.destination === input.expectedDestinationTokenAccount
    && info.mint === input.expectedMint
    && tokenAmount?.decimals === 6
    && tokenAmount?.amount === expectedAmount;
  return isExpectedTransfer && typeof source === "string" ? source : null;
}

function isSourceTokenAccountOwnedBySender(
  transaction: RpcTransaction,
  sourceTokenAccount: string,
  input: VerifySolanaUsdcTransferInput
): boolean {
  const accountKeys = transaction.transaction?.message?.accountKeys;
  return Boolean(transaction.meta?.preTokenBalances?.some((balance) => {
    const accountIndex = balance.accountIndex;
    return balance.owner === input.senderWalletAddress
      && balance.mint === input.expectedMint
      && typeof accountIndex === "number"
      && Number.isSafeInteger(accountIndex)
      && accountIndex >= 0
      && accountKeyAddress(accountKeys?.[accountIndex]) === sourceTokenAccount;
  }));
}

function accountKeyAddress(account: unknown): string | undefined {
  if (typeof account === "string") {
    return account;
  }
  const record = account as { pubkey?: unknown };
  return typeof record.pubkey === "string" ? record.pubkey : undefined;
}

const MAX_SPL_TOKEN_AMOUNT = 18_446_744_073_709_551_615n;

function assertPositiveAmount(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint" || value <= 0n || value > MAX_SPL_TOKEN_AMOUNT) {
    throw new SolanaPaymentVerificationError(
      "PAYMENT_AMOUNT_INVALID",
      "Expected USDC amount must be a positive SPL-token base-unit amount."
    );
  }
}

function assertTransactionSignature(value: unknown): void {
  assertBase58Value(value, "transaction signature", 64);
}

function assertSolanaAddress(value: unknown, label: string): void {
  assertBase58Value(value, label, 32);
}

function assertBase58Value(value: unknown, label: string, expectedByteLength: number): void {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,128}$/.test(value)) {
    throw new SolanaPaymentVerificationError("PAYMENT_REFERENCE_INVALID", "The " + label + " is invalid.");
  }
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(value);
  } catch {
    throw new SolanaPaymentVerificationError("PAYMENT_REFERENCE_INVALID", "The " + label + " is invalid.");
  }
  if (decoded.length !== expectedByteLength) {
    throw new SolanaPaymentVerificationError("PAYMENT_REFERENCE_INVALID", "The " + label + " is invalid.");
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
