import * as ed25519 from "@noble/ed25519";

const REQUEST_TIMEOUT_MS = 2_500;

export interface ReferralQualificationRecord {
  eventId: string;
  profileUserId: string;
  matchId: string;
  roundId: string;
  completedAt: number;
  /** Final authoritative activity—never browser counters. */
  foodCollected: number;
  survivalTimeMs: number;
}

export interface ReferralQualificationPersistence {
  readonly enabled: boolean;
  persist(record: ReferralQualificationRecord): Promise<boolean>;
}

/** A game-server-only signed handoff. It contains no wallet address, browser
 * cookie, points total, or client-provided gameplay result. */
export class SignedReferralQualificationClient implements ReferralQualificationPersistence {
  readonly enabled = true;

  constructor(
    private readonly origin: string,
    private readonly privateKey: Uint8Array,
    private readonly send: typeof fetch = fetch,
  ) {}

  async persist(record: ReferralQualificationRecord): Promise<boolean> {
    const body = Buffer.from(JSON.stringify(record));
    const signature = await ed25519.signAsync(body, this.privateKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.send(new URL("/internal/referrals/qualifications", this.origin).toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BLOB-Referral-Qualification-Signature": Buffer.from(signature).toString("base64"),
        },
        body,
        signal: controller.signal,
      });
      if (response.status !== 201) {
        return false;
      }
      const payload = await response.json().catch(() => undefined) as { status?: unknown } | undefined;
      // Eligibility can be reached later in the same authoritative Free Mode
      // round. Keep the fact retryable until the platform confirms a durable
      // terminal outcome, rather than treating an early progress check as a
      // lost referral.
      return payload?.status !== "INSUFFICIENT_GAMEPLAY" && payload?.status !== "EMAIL_NOT_VERIFIED";
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
      console.warn("[BLOB game server] referral qualification persistence unavailable", {
        error: error instanceof Error ? error.message : "unknown",
        cause,
      });
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

class DisabledReferralQualificationPersistence implements ReferralQualificationPersistence {
  readonly enabled = false;

  async persist(): Promise<boolean> {
    return false;
  }
}

export function createReferralQualificationPersistence(environment: NodeJS.ProcessEnv = process.env): ReferralQualificationPersistence {
  const origin = normalizeOrigin(environment.PLATFORM_REFERRAL_ORIGIN);
  const privateKey = decodePrivateKey(environment.BLOB_REFERRAL_QUALIFICATION_PRIVATE_KEY_BASE64);
  if (origin && privateKey) {
    return new SignedReferralQualificationClient(origin, privateKey);
  }
  if (origin || privateKey) {
    console.error("[BLOB game server] referral qualification configuration is incomplete; no points will be awarded.");
  }
  return new DisabledReferralQualificationPersistence();
}

export function createReferralQualificationEventId(matchId: string, roundId: string, profileUserId: string): string {
  return "free-round:" + matchId + ":" + roundId + ":" + profileUserId;
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function decodePrivateKey(value: string | undefined): Uint8Array | undefined {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 ? new Uint8Array(decoded) : undefined;
}
