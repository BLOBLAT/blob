import { describe, expect, it } from "vitest";
import { loadPlatformApiConfig } from "./config.js";

const DATABASE_URL = "postgresql://blob:blob@127.0.0.1:5432/blob?schema=public";
const GAME_TICKET_PRIVATE_KEY = Buffer.alloc(32, 7).toString("base64");

describe("platform API production configuration", () => {
  it("requires HTTPS for every browser origin in production", () => {
    expect(() => loadPlatformApiConfig({
      NODE_ENV: "production",
      DATABASE_URL,
      PLATFORM_PUBLIC_ORIGIN: "https://blob.lat",
      PLATFORM_WEB_ORIGIN: "https://blob.lat,http://localhost:5173",
      PLATFORM_GAME_TICKET_PRIVATE_KEY_BASE64: GAME_TICKET_PRIVATE_KEY
    })).toThrow("PLATFORM_WEB_ORIGIN must contain only HTTPS origins");
  });

  it("rejects malformed numeric configuration instead of truncating it", () => {
    expect(() => loadPlatformApiConfig({
      DATABASE_URL,
      PLATFORM_SESSION_TTL_MS: "60000oops"
    })).toThrow("PLATFORM_SESSION_TTL_MS must be a positive integer");

    expect(loadPlatformApiConfig({ DATABASE_URL, PORT: "3000oops" }).port).toBe(3000);

    expect(() => loadPlatformApiConfig({
      DATABASE_URL,
      PLATFORM_AUTH_GLOBAL_RATE_LIMIT: "0"
    })).toThrow("PLATFORM_AUTH_GLOBAL_RATE_LIMIT must be a positive integer");

    expect(() => loadPlatformApiConfig({
      DATABASE_URL,
      PLATFORM_GAME_TICKET_RATE_LIMIT: "0"
    })).toThrow("PLATFORM_GAME_TICKET_RATE_LIMIT must be a positive integer");
  });

  it("accepts the production BLOB origin allowlist", () => {
    const config = loadPlatformApiConfig({
      NODE_ENV: "production",
      DATABASE_URL,
      PLATFORM_PUBLIC_ORIGIN: "https://blob.lat",
      PLATFORM_WEB_ORIGIN: "https://blob.lat,https://www.blob.lat",
      PLATFORM_GAME_TICKET_PRIVATE_KEY_BASE64: GAME_TICKET_PRIVATE_KEY,
      PORT: "3001"
    });
    expect(config.port).toBe(3001);
    expect([...config.allowedWebOrigins]).toEqual(["https://blob.lat", "https://www.blob.lat"]);
    expect(config.sessionCookieName).toBe("__Host-blob_session");
  });

  it("requires a host-only cookie name in production", () => {
    expect(() => loadPlatformApiConfig({
      NODE_ENV: "production",
      DATABASE_URL,
      PLATFORM_PUBLIC_ORIGIN: "https://blob.lat",
      PLATFORM_WEB_ORIGIN: "https://blob.lat",
      PLATFORM_GAME_TICKET_PRIVATE_KEY_BASE64: GAME_TICKET_PRIVATE_KEY,
      PLATFORM_SESSION_COOKIE_NAME: "blob_session"
    })).toThrow("PLATFORM_SESSION_COOKIE_NAME must use the __Host- prefix");
  });

  it("requires a real signing key in production", () => {
    expect(() => loadPlatformApiConfig({
      NODE_ENV: "production",
      DATABASE_URL,
      PLATFORM_PUBLIC_ORIGIN: "https://blob.lat",
      PLATFORM_WEB_ORIGIN: "https://blob.lat"
    })).toThrow("PLATFORM_GAME_TICKET_PRIVATE_KEY_BASE64 is required in production");
  });

  it("accepts only a separate 32-byte Ed25519 key for future paid admission", () => {
    expect(() => loadPlatformApiConfig({
      DATABASE_URL,
      PLATFORM_PAID_ADMISSION_TICKET_PRIVATE_KEY_BASE64: "not base64!"
    })).toThrow("PLATFORM_PAID_ADMISSION_TICKET_PRIVATE_KEY_BASE64 must be base64");

    const config = loadPlatformApiConfig({
      DATABASE_URL,
      PLATFORM_PAID_ADMISSION_TICKET_PRIVATE_KEY_BASE64: Buffer.alloc(32, 11).toString("base64")
    });
    expect(config.paidAdmissionTicketPrivateKey).toHaveLength(32);

    expect(() => loadPlatformApiConfig({
      NODE_ENV: "production",
      DATABASE_URL,
      PLATFORM_PUBLIC_ORIGIN: "https://blob.lat",
      PLATFORM_WEB_ORIGIN: "https://blob.lat",
      PLATFORM_GAME_TICKET_PRIVATE_KEY_BASE64: GAME_TICKET_PRIVATE_KEY,
      PLATFORM_PAID_ADMISSION_TICKET_PRIVATE_KEY_BASE64: GAME_TICKET_PRIVATE_KEY,
    })).toThrow("PLATFORM_PAID_ADMISSION_TICKET_PRIVATE_KEY_BASE64 must differ");

    expect(() => loadPlatformApiConfig({
      DATABASE_URL,
      BLOB_PAID_ADMISSION_CONSUMER_PUBLIC_KEY_BASE58: "not-base58!"
    })).toThrow("BLOB_PAID_ADMISSION_CONSUMER_PUBLIC_KEY_BASE58 must be a base58 Ed25519 public key");
  });

  it("accepts only integer server-side referral awards", () => {
    const config = loadPlatformApiConfig({
      DATABASE_URL,
      BLOB_REFERRAL_REFERRER_POINTS: "100",
      BLOB_REFERRAL_REFEREE_POINTS: "25",
    });
    expect(config.referralReferrerPoints).toBe(100n);
    expect(config.referralRefereePoints).toBe(25n);
    expect(() => loadPlatformApiConfig({
      DATABASE_URL,
      BLOB_REFERRAL_REFERRER_POINTS: "1.5",
    })).toThrow("BLOB_REFERRAL_REFERRER_POINTS must be a non-negative integer");
    expect(() => loadPlatformApiConfig({
      DATABASE_URL,
      BLOB_REFERRAL_MIN_FOOD_COLLECTED: "0",
    })).toThrow("BLOB_REFERRAL_MIN_FOOD_COLLECTED must be a positive integer");
    expect(() => loadPlatformApiConfig({
      DATABASE_URL,
      BLOB_REFERRAL_MAX_QUALIFICATIONS_PER_REFERRER_PER_DAY: "10.5",
    })).toThrow("BLOB_REFERRAL_MAX_QUALIFICATIONS_PER_REFERRER_PER_DAY must be a positive integer");
  });

  it("fails closed unless the complete server-only referral email configuration is present", () => {
    expect(() => loadPlatformApiConfig({
      DATABASE_URL,
      PLATFORM_REFERRAL_EMAIL_HMAC_SECRET_BASE64: Buffer.alloc(32, 5).toString("base64"),
    })).toThrow("must be configured together");

    const config = loadPlatformApiConfig({
      DATABASE_URL,
      PLATFORM_REFERRAL_EMAIL_HMAC_SECRET_BASE64: Buffer.alloc(32, 5).toString("base64"),
      PLATFORM_REFERRAL_EMAIL_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 6).toString("base64"),
      RESEND_API_KEY: "re_test_only_non_production_key",
      BLOB_REFERRAL_EMAIL_FROM: "BLOB <verify@blob.lat>",
    });
    expect(config.referralEmailHashSecret).toHaveLength(32);
    expect(config.referralEmailEncryptionKey).toHaveLength(32);
    expect(config.resendFrom).toBe("BLOB <verify@blob.lat>");
  });
});
