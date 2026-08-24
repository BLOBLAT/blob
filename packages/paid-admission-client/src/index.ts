import * as ed25519 from "@noble/ed25519";
import { paidAdmissionConsumePayloadSchema, type PaidAdmissionClaims } from "@blob/validation";

export type { PaidAdmissionClaims } from "@blob/validation";

const REQUEST_TIMEOUT_MS = 2_500;

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
  const parsed = paidAdmissionConsumePayloadSchema.safeParse(input);
  if (!parsed.success || parsed.data.claims.expiresAt <= Date.now()) {
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
