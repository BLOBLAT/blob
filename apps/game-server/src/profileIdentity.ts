import * as ed25519 from "@noble/ed25519";
import { base58 } from "@scure/base";
import type { ValidatedPlayerJoinOptions } from "@blob/validation";

const PROFILE_TICKET_VERSION = 1;
const MAX_TICKET_LIFETIME_MS = 10 * 60_000;
const DISPLAY_NAME_PATTERN = /^[A-Za-z0-9 _-]{3,16}$/;

interface ProfileTicketPayload {
  v: number;
  sub: string;
  name: string;
  iat: number;
  exp: number;
}

export interface ResolvedPlayerIdentity {
  name: string;
  profileUserId?: string;
}

/**
 * Verifies an assertion from the isolated platform API. The game server only
 * receives a public key, so it cannot create a profile identity itself.
 */
export class ProfileTicketVerifier {
  private constructor(private readonly publicKey: Uint8Array | undefined) {}

  static fromBase58(value: string | undefined): ProfileTicketVerifier {
    if (!value) {
      return new ProfileTicketVerifier(undefined);
    }
    let decoded: Uint8Array;
    try {
      decoded = base58.decode(value);
    } catch {
      throw new Error("BLOB_PROFILE_TICKET_PUBLIC_KEY must be a base58 Ed25519 public key.");
    }
    if (decoded.length !== 32) {
      throw new Error("BLOB_PROFILE_TICKET_PUBLIC_KEY must be 32 bytes.");
    }
    return new ProfileTicketVerifier(decoded);
  }

  async resolve(sessionId: string, join: ValidatedPlayerJoinOptions, now = Date.now()): Promise<ResolvedPlayerIdentity> {
    const verified = this.publicKey && join.profileTicket
      ? await this.verify(join.profileTicket, now)
      : undefined;
    return verified
      ? { name: verified.name, profileUserId: verified.sub }
      : { name: createAnonymousPlayerName(sessionId) };
  }

  private async verify(ticket: string, now: number): Promise<ProfileTicketPayload | undefined> {
    const [encodedPayload, encodedSignature, extra] = ticket.split(".");
    if (!encodedPayload || !encodedSignature || extra !== undefined || encodedPayload.length > 700 || encodedSignature.length > 128) {
      return undefined;
    }
    const signature = decodeBase64Url(encodedSignature);
    if (!signature || signature.length !== 64) {
      return undefined;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    } catch {
      return undefined;
    }
    if (!isProfileTicketPayload(payload, now)) {
      return undefined;
    }
    try {
      return await ed25519.verifyAsync(signature, new TextEncoder().encode(encodedPayload), this.publicKey!)
        ? payload
        : undefined;
    } catch {
      return undefined;
    }
  }
}

function isProfileTicketPayload(value: unknown, now: number): value is ProfileTicketPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as Record<string, unknown>;
  const iat = payload.iat;
  const exp = payload.exp;
  return payload.v === PROFILE_TICKET_VERSION
    && typeof payload.sub === "string" && payload.sub.length >= 1 && payload.sub.length <= 128
    && typeof payload.name === "string" && DISPLAY_NAME_PATTERN.test(payload.name)
    && typeof iat === "number" && Number.isSafeInteger(iat)
    && typeof exp === "number" && Number.isSafeInteger(exp)
    && iat <= now + 30_000
    && exp > now
    && exp - iat > 0
    && exp - iat <= MAX_TICKET_LIFETIME_MS;
}

function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  const bytes = Buffer.from(value, "base64url");
  return bytes.length ? new Uint8Array(bytes) : undefined;
}

function createAnonymousPlayerName(sessionId: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return "BLOB-" + (hash >>> 0).toString(36).toUpperCase().padStart(5, "0").slice(-5);
}
