import * as ed25519 from "@noble/ed25519";

const REQUEST_TIMEOUT_MS = 2_500;
const MAX_TOKEN_LENGTH = 2_177;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const RULES_HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PaidAdmissionClaims {
  audience: "blob-game-server";
  entryId: string;
  matchId: string;
  roundId: string;
  playerId: string;
  rulesHash: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface PaidAdmissionConsumer {
  consume(input: { token: string; claims: PaidAdmissionClaims }): Promise<void>;
}

/**
 * Server-only bridge used by the future isolated Paid Room. The caller's
 * private key signs the exact bytes received by Platform API; no shared
 * secret, wallet key, browser credential, or gameplay authority is involved.
 */
export class SignedPaidAdmissionConsumer implements PaidAdmissionConsumer {
  constructor(
    private readonly origin: string,
    private readonly privateKey: Uint8Array,
    private readonly send: typeof fetch = fetch,
  ) {
    if (!isPrivateOrigin(origin) || privateKey.length !== 32) {
      throw new PaidAdmissionConsumerError("ADMISSION_CONSUMER_CONFIG_INVALID", "Paid admission consumer configuration is invalid.");
    }
  }

  async consume(input: { token: string; claims: PaidAdmissionClaims }): Promise<void> {
    assertPayload(input);
    const body = Buffer.from(JSON.stringify(input));
    const signature = await ed25519.signAsync(body, this.privateKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.send(this.origin + "/internal/paid-admissions/consume", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BLOB-Paid-Admission-Signature": Buffer.from(signature).toString("base64")
        },
        body,
        signal: controller.signal
      });
      if (response.status !== 204) {
        throw new PaidAdmissionConsumerError("ADMISSION_CONSUME_REJECTED", "Paid admission was not consumed.");
      }
    } catch (error) {
      if (error instanceof PaidAdmissionConsumerError) throw error;
      throw new PaidAdmissionConsumerError("ADMISSION_CONSUME_UNAVAILABLE", "Paid admission service is unavailable.");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class PaidAdmissionConsumerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function assertPayload(input: { token: string; claims: PaidAdmissionClaims }): void {
  const { claims } = input;
  if (typeof input.token !== "string" || input.token.length === 0 || input.token.length > MAX_TOKEN_LENGTH
    || claims.audience !== "blob-game-server"
    || !IDENTIFIER.test(claims.entryId) || !IDENTIFIER.test(claims.matchId) || !IDENTIFIER.test(claims.roundId) || !IDENTIFIER.test(claims.playerId)
    || !RULES_HASH.test(claims.rulesHash) || !UUID.test(claims.nonce)
    || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)
    || claims.expiresAt <= claims.issuedAt || claims.expiresAt <= Date.now()) {
    throw new PaidAdmissionConsumerError("ADMISSION_CONSUMER_PAYLOAD_INVALID", "Paid admission payload is invalid.");
  }
}

function isPrivateOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}
