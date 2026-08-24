import * as ed25519 from "@noble/ed25519";
import {
  paidAdmissionClaimsSchema,
  paidAdmissionConsumePayloadSchema,
  type PaidAdmissionClaims,
} from "@blob/validation";

export type { PaidAdmissionClaims } from "@blob/validation";

const REQUEST_TIMEOUT_MS = 2_500;
const MAX_ENCODED_PAYLOAD_LENGTH = 2_048;
const MAX_ENCODED_SIGNATURE_LENGTH = 128;
const MAX_TICKET_LENGTH = MAX_ENCODED_PAYLOAD_LENGTH + MAX_ENCODED_SIGNATURE_LENGTH + 1;
const MIN_TICKET_TTL_MS = 10_000;
const MAX_TICKET_TTL_MS = 5 * 60_000;

export interface PaidAdmissionVerificationInput {
  token: string;
  expectedMatchId: string;
  expectedRoundId: string;
  now?: Date;
}

export interface PaidAdmissionConsumer {
  consume(input: PaidAdmissionVerificationInput): Promise<PaidAdmissionClaims>;
}

/**
 * Server-only bridge used by the future isolated Paid Room. The caller's
 * private key signs the exact bytes received by Platform API; no shared
 * secret, wallet key, browser credential, or gameplay authority is involved.
 */
export class SignedPaidAdmissionConsumer implements PaidAdmissionConsumer {
  private readonly origin: string;

  constructor(
    origin: string,
    private readonly privateKey: Uint8Array,
    private readonly ticketIssuerPublicKey: Uint8Array,
    private readonly send: typeof fetch = fetch,
  ) {
    const normalizedOrigin = normalizePrivateOrigin(origin);
    if (!normalizedOrigin || privateKey.length !== 32 || ticketIssuerPublicKey.length !== 32) {
      throw new PaidAdmissionConsumerError("ADMISSION_CONSUMER_CONFIG_INVALID", "Paid admission consumer configuration is invalid.");
    }
    this.origin = normalizedOrigin;
  }

  async consume(input: PaidAdmissionVerificationInput): Promise<PaidAdmissionClaims> {
    const verificationNow = input.now ?? new Date();
    const claims = await verifyPaidAdmissionTicket({
      token: input.token,
      publicKey: this.ticketIssuerPublicKey,
      expectedMatchId: input.expectedMatchId,
      expectedRoundId: input.expectedRoundId,
      now: verificationNow,
    });
    const payload = { token: input.token, claims };
    assertPayload(payload, verificationNow.getTime());
    const body = Buffer.from(JSON.stringify(payload));
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
      return claims;
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

/**
 * Validates the ticket before the isolated Paid Room can consume its durable
 * admission. This is intentionally local defence in depth: the Platform API
 * repeats the hash/binding validation when it atomically consumes the entry.
 */
export async function verifyPaidAdmissionTicket(input: {
  token: string;
  publicKey: Uint8Array;
  expectedMatchId: string;
  expectedRoundId: string;
  now?: Date;
}): Promise<PaidAdmissionClaims> {
  if (!(input.publicKey instanceof Uint8Array) || input.publicKey.length !== 32) {
    throw new PaidAdmissionConsumerError("ADMISSION_TICKET_KEY_INVALID", "Paid admission ticket verification key is invalid.");
  }
  const now = input.now ?? new Date();
  if (!Number.isSafeInteger(now.getTime()) || input.token.length > MAX_TICKET_LENGTH) {
    throw new PaidAdmissionConsumerError("ADMISSION_TICKET_INVALID", "Paid admission ticket is invalid.");
  }
  const [payload, signature, ...extra] = input.token.split(".");
  if (!payload || !signature || extra.length !== 0
    || payload.length > MAX_ENCODED_PAYLOAD_LENGTH
    || signature.length > MAX_ENCODED_SIGNATURE_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(payload)
    || !/^[A-Za-z0-9_-]+$/.test(signature)) {
    throw new PaidAdmissionConsumerError("ADMISSION_TICKET_INVALID", "Paid admission ticket is invalid.");
  }
  const signatureBytes = Buffer.from(signature, "base64url");
  if (signatureBytes.length !== 64) {
    throw new PaidAdmissionConsumerError("ADMISSION_TICKET_INVALID", "Paid admission ticket is invalid.");
  }
  try {
    if (!await ed25519.verifyAsync(signatureBytes, new TextEncoder().encode(payload), input.publicKey)) {
      throw new PaidAdmissionConsumerError("ADMISSION_TICKET_INVALID", "Paid admission ticket is invalid.");
    }
  } catch (error) {
    if (error instanceof PaidAdmissionConsumerError) throw error;
    throw new PaidAdmissionConsumerError("ADMISSION_TICKET_INVALID", "Paid admission ticket is invalid.");
  }
  let untrustedClaims: unknown;
  try {
    untrustedClaims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new PaidAdmissionConsumerError("ADMISSION_TICKET_INVALID", "Paid admission ticket is invalid.");
  }
  const parsed = paidAdmissionClaimsSchema.safeParse(untrustedClaims);
  const claims = parsed.success ? parsed.data : undefined;
  if (!claims
    || claims.matchId !== input.expectedMatchId
    || claims.roundId !== input.expectedRoundId
    || claims.issuedAt > now.getTime()
    || claims.expiresAt <= now.getTime()
    || claims.expiresAt - claims.issuedAt < MIN_TICKET_TTL_MS
    || claims.expiresAt - claims.issuedAt > MAX_TICKET_TTL_MS) {
    throw new PaidAdmissionConsumerError("ADMISSION_TICKET_INVALID", "Paid admission ticket is expired or does not match this round.");
  }
  return claims;
}

function assertPayload(input: { token: string; claims: PaidAdmissionClaims }, nowMs = Date.now()): void {
  const parsed = paidAdmissionConsumePayloadSchema.safeParse(input);
  if (!parsed.success || parsed.data.claims.expiresAt <= nowMs) {
    throw new PaidAdmissionConsumerError("ADMISSION_CONSUMER_PAYLOAD_INVALID", "Paid admission payload is invalid.");
  }
}

function normalizePrivateOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:"
      || !url.hostname.endsWith(".railway.internal")
      || url.port === "0"
      || url.pathname !== "/"
      || url.search
      || url.hash
      || url.username
      || url.password) {
      return undefined;
    }
    // URL.origin removes an optional trailing slash while preserving an
    // explicit internal service port. It keeps the signed request path exact.
    return url.origin;
  } catch {
    return undefined;
  }
}
