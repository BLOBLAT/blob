export interface PlatformApiConfig {
  databaseUrl: string;
  port: number;
  nodeEnv: "development" | "test" | "production";
  publicOrigin: string;
  allowedWebOrigins: ReadonlySet<string>;
  sessionCookieName: string;
  sessionTtlMs: number;
  challengeTtlMs: number;
  renameCooldownMs: number;
  authChallengeRateLimit: number;
  authVerifyRateLimit: number;
  /**
   * Per-process ceiling shared by each public wallet-auth route. This bounds
   * distinct-wallet abuse while an external edge/WAF remains the primary
   * distributed protection.
   */
  authGlobalRateLimit: number;
  /**
   * Short global protection window. Keeping this separate from the per-wallet
   * window prevents a small burst of random-wallet requests from locking out
   * every legitimate wallet for ten minutes.
   */
  globalRateLimitWindowMs: number;
  authRateLimitWindowMs: number;
  gameTicketPrivateKey: Uint8Array | undefined;
  gameTicketTtlMs: number;
  /** Limits profile-ticket signing per authenticated user and process-wide. */
  gameTicketRateLimit: number;
  gameTicketGlobalRateLimit: number;
  /** Reserved for a future paid-room admission signer; it never enables paid play by itself. */
  paidAdmissionTicketPrivateKey: Uint8Array | undefined;
  /** Public half of the future game-server-only paid-admission consume signer. */
  paidAdmissionConsumerPublicKey: Uint8Array | undefined;
  /** Public half of the game-server-only arena-chat audit signing key. */
  arenaChatAuditPublicKey: Uint8Array | undefined;
  /** Accepted chat retention window. Cleanup is owned by platform-api. */
  arenaChatRetentionDays: number;
}

const LOCAL_WEB_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];

export function loadPlatformApiConfig(environment: NodeJS.ProcessEnv = process.env): PlatformApiConfig {
  const nodeEnv = environment.NODE_ENV === "production"
    ? "production"
    : environment.NODE_ENV === "test"
      ? "test"
      : "development";
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to start the platform API.");
  }

  const publicOrigin = normalizeOrigin(environment.PLATFORM_PUBLIC_ORIGIN ?? (nodeEnv === "production" ? "" : "http://127.0.0.1:5173"));
  if (!publicOrigin) {
    throw new Error("PLATFORM_PUBLIC_ORIGIN is required in production.");
  }
  if (nodeEnv === "production" && !publicOrigin.startsWith("https://")) {
    throw new Error("PLATFORM_PUBLIC_ORIGIN must use HTTPS in production.");
  }

  const configuredOrigins = environment.PLATFORM_WEB_ORIGIN
    ?.split(",")
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);
  const allowedWebOrigins = new Set(configuredOrigins?.length ? configuredOrigins : nodeEnv === "production" ? [] : LOCAL_WEB_ORIGINS);
  if (nodeEnv === "production" && allowedWebOrigins.size === 0) {
    throw new Error("PLATFORM_WEB_ORIGIN is required in production.");
  }
  if (nodeEnv === "production" && [...allowedWebOrigins].some((origin) => !origin.startsWith("https://"))) {
    throw new Error("PLATFORM_WEB_ORIGIN must contain only HTTPS origins in production.");
  }
  const sessionCookieName = environment.PLATFORM_SESSION_COOKIE_NAME
    ?? (nodeEnv === "production" ? "__Host-blob_session" : "blob_session");
  if (nodeEnv === "production" && !/^__Host-[A-Za-z0-9_-]+$/.test(sessionCookieName)) {
    throw new Error("PLATFORM_SESSION_COOKIE_NAME must use the __Host- prefix in production.");
  }
  const gameTicketPrivateKey = decodeEd25519PrivateKey(
    environment.PLATFORM_GAME_TICKET_PRIVATE_KEY_BASE64,
    "PLATFORM_GAME_TICKET_PRIVATE_KEY_BASE64",
  );
  if (nodeEnv === "production" && !gameTicketPrivateKey) {
    throw new Error("PLATFORM_GAME_TICKET_PRIVATE_KEY_BASE64 is required in production.");
  }
  const paidAdmissionTicketPrivateKey = decodeEd25519PrivateKey(
    environment.PLATFORM_PAID_ADMISSION_TICKET_PRIVATE_KEY_BASE64,
    "PLATFORM_PAID_ADMISSION_TICKET_PRIVATE_KEY_BASE64",
  );
  if (gameTicketPrivateKey && paidAdmissionTicketPrivateKey
    && timingSafeEqual(Buffer.from(gameTicketPrivateKey), Buffer.from(paidAdmissionTicketPrivateKey))) {
    throw new Error("PLATFORM_PAID_ADMISSION_TICKET_PRIVATE_KEY_BASE64 must differ from PLATFORM_GAME_TICKET_PRIVATE_KEY_BASE64.");
  }
  const paidAdmissionConsumerPublicKey = decodeArenaChatAuditPublicKey(environment.BLOB_PAID_ADMISSION_CONSUMER_PUBLIC_KEY_BASE58);
  if (environment.BLOB_PAID_ADMISSION_CONSUMER_PUBLIC_KEY_BASE58 && !paidAdmissionConsumerPublicKey) {
    throw new Error("BLOB_PAID_ADMISSION_CONSUMER_PUBLIC_KEY_BASE58 must be a base58 Ed25519 public key.");
  }
  const arenaChatAuditPublicKey = decodeArenaChatAuditPublicKey(environment.BLOB_ARENA_CHAT_AUDIT_PUBLIC_KEY_BASE58);
  if (environment.BLOB_ARENA_CHAT_AUDIT_PUBLIC_KEY_BASE58 && !arenaChatAuditPublicKey) {
    throw new Error("BLOB_ARENA_CHAT_AUDIT_PUBLIC_KEY_BASE58 must be a base58 Ed25519 public key.");
  }

  return {
    databaseUrl,
    port: parsePort(environment.PORT),
    nodeEnv,
    publicOrigin,
    allowedWebOrigins,
    sessionCookieName,
    sessionTtlMs: parsePositiveInteger(environment.PLATFORM_SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1_000, "PLATFORM_SESSION_TTL_MS"),
    challengeTtlMs: parsePositiveInteger(environment.PLATFORM_CHALLENGE_TTL_MS, 5 * 60 * 1_000, "PLATFORM_CHALLENGE_TTL_MS"),
    renameCooldownMs: parsePositiveInteger(environment.PLATFORM_RENAME_COOLDOWN_MS, 24 * 60 * 60 * 1_000, "PLATFORM_RENAME_COOLDOWN_MS"),
    authChallengeRateLimit: parsePositiveInteger(environment.PLATFORM_AUTH_CHALLENGE_RATE_LIMIT, 6, "PLATFORM_AUTH_CHALLENGE_RATE_LIMIT"),
    authVerifyRateLimit: parsePositiveInteger(environment.PLATFORM_AUTH_VERIFY_RATE_LIMIT, 12, "PLATFORM_AUTH_VERIFY_RATE_LIMIT"),
    authGlobalRateLimit: parsePositiveInteger(environment.PLATFORM_AUTH_GLOBAL_RATE_LIMIT, 180, "PLATFORM_AUTH_GLOBAL_RATE_LIMIT"),
    authRateLimitWindowMs: parsePositiveInteger(environment.PLATFORM_AUTH_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1_000, "PLATFORM_AUTH_RATE_LIMIT_WINDOW_MS"),
    globalRateLimitWindowMs: parsePositiveInteger(environment.PLATFORM_GLOBAL_RATE_LIMIT_WINDOW_MS, 60_000, "PLATFORM_GLOBAL_RATE_LIMIT_WINDOW_MS"),
    gameTicketPrivateKey,
    gameTicketTtlMs: parsePositiveInteger(environment.PLATFORM_GAME_TICKET_TTL_MS, 5 * 60 * 1_000, "PLATFORM_GAME_TICKET_TTL_MS"),
    gameTicketRateLimit: parsePositiveInteger(environment.PLATFORM_GAME_TICKET_RATE_LIMIT, 15, "PLATFORM_GAME_TICKET_RATE_LIMIT"),
    gameTicketGlobalRateLimit: parsePositiveInteger(environment.PLATFORM_GAME_TICKET_GLOBAL_RATE_LIMIT, 180, "PLATFORM_GAME_TICKET_GLOBAL_RATE_LIMIT"),
    paidAdmissionTicketPrivateKey,
    paidAdmissionConsumerPublicKey,
    arenaChatAuditPublicKey,
    arenaChatRetentionDays: parsePositiveInteger(environment.BLOB_CHAT_RETENTION_DAYS, 90, "BLOB_CHAT_RETENTION_DAYS"),
  };
}

function decodeEd25519PrivateKey(value: string | undefined, variableName: string): Uint8Array | undefined {
  if (!value) {
    return undefined;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(variableName + " must be base64.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    throw new Error(variableName + " must decode to a 32-byte Ed25519 private key.");
  }
  return new Uint8Array(decoded);
}

function normalizeOrigin(value: string): string {
  const candidate = value.trim().replace(/\/+$/, "");
  if (!candidate) {
    return "";
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

function parsePort(value: string | undefined): number {
  const port = parseInteger(value ?? "3000");
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 3000;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = parseInteger(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(name + " must be a positive integer.");
  }
  return parsed;
}

function parseInteger(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}
import { timingSafeEqual } from "node:crypto";
import { decodeArenaChatAuditPublicKey } from "./arena-chat-audit.js";
