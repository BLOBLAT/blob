import * as ed25519 from "@noble/ed25519";
import { type ArenaChatAuditRecord } from "@blob/validation";

const REQUEST_TIMEOUT_MS = 2_500;
const DEFAULT_RETENTION_DAYS = 90;

export interface ArenaChatPersistence {
  persist(record: ArenaChatAuditRecord): Promise<boolean>;
  readonly enabled: boolean;
}

/**
 * The game process has no database credentials. In production it writes an
 * accepted message through a signed, private-service request before Colyseus
 * broadcasts it. The platform API holds only the corresponding public key.
 */
export class SignedArenaChatAuditClient implements ArenaChatPersistence {
  readonly enabled = true;

  constructor(
    private readonly origin: string,
    private readonly privateKey: Uint8Array,
    private readonly send: typeof fetch = fetch,
  ) {}

  async persist(record: ArenaChatAuditRecord): Promise<boolean> {
    const body = Buffer.from(JSON.stringify(record));
    const signature = await ed25519.signAsync(body, this.privateKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.send(this.origin + "/internal/arena-chat/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BLOB-Arena-Audit-Signature": Buffer.from(signature).toString("base64")
        },
        body,
        signal: controller.signal
      });
      return response.status === 201;
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error
        ? error.cause.message
        : undefined;
      console.warn("[BLOB game server] chat audit persistence unavailable", {
        error: error instanceof Error ? error.message : "unknown",
        cause
      });
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

class UnavailableArenaChatPersistence implements ArenaChatPersistence {
  readonly enabled = false;

  async persist(): Promise<boolean> {
    return false;
  }
}

/** Local development has no durable service by default; production never
 * silently relays unrecorded chat. */
class DevelopmentArenaChatPersistence implements ArenaChatPersistence {
  readonly enabled = true;

  async persist(): Promise<boolean> {
    return true;
  }
}

export function createArenaChatPersistence(environment: NodeJS.ProcessEnv = process.env): ArenaChatPersistence {
  const origin = normalizeOrigin(environment.PLATFORM_CHAT_AUDIT_ORIGIN);
  const privateKey = decodePrivateKey(environment.BLOB_ARENA_CHAT_AUDIT_PRIVATE_KEY_BASE64);
  if (origin && privateKey) {
    return new SignedArenaChatAuditClient(origin, privateKey);
  }
  if (origin || privateKey) {
    console.error("[BLOB game server] chat audit configuration is incomplete; chat will remain unavailable.");
    return new UnavailableArenaChatPersistence();
  }
  if (environment.NODE_ENV !== "production") {
    return new DevelopmentArenaChatPersistence();
  }
  console.error("[BLOB game server] chat audit is not configured; chat will remain unavailable.");
  return new UnavailableArenaChatPersistence();
}

export function resolveChatRetentionDays(environment: NodeJS.ProcessEnv = process.env): number {
  const value = environment.BLOB_CHAT_RETENTION_DAYS;
  if (value === undefined) {
    return DEFAULT_RETENTION_DAYS;
  }
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : DEFAULT_RETENTION_DAYS;
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
