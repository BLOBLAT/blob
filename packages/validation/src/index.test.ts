import { describe, expect, it } from "vitest";
import {
  canonicalizeDisplayName,
  movementIntentSchema,
  playerJoinOptionsSchema,
  validateChatMessage,
  validateDisplayName
} from "./index.js";

describe("player join validation", () => {
  it("accepts a bounded display name", () => {
    expect(playerJoinOptionsSchema.parse({ name: "BLOB-42" })).toEqual({ name: "BLOB-42" });
  });

  it("rejects unsafe or oversized display names", () => {
    expect(playerJoinOptionsSchema.safeParse({ name: "<script>" }).success).toBe(false);
    expect(playerJoinOptionsSchema.safeParse({ name: "A".repeat(17) }).success).toBe(false);
  });
});

describe("profile display-name policy", () => {
  it("normalizes a permitted profile name into a stable uniqueness key", () => {
    expect(validateDisplayName("  Blob\u00a0Prime  ")).toEqual({
      success: true,
      data: { displayName: "Blob Prime", displayNameKey: "BLOB PRIME" }
    });
    expect(canonicalizeDisplayName("Blob   Prime")).toBe("BLOB PRIME");
  });

  it("rejects protected staff, system, payment, and brand-looking names including common bypasses", () => {
    for (const name of [
      "Admin",
      "BLOB-admin",
      "m0d_erator",
      "SUP PORT",
      "Official BLOB",
      "ARENA 4",
      "Phantom",
      "USDC",
      "Treasury",
      "Settlement"
    ]) {
      expect(validateDisplayName(name)).toEqual({ success: false, code: "DISPLAY_NAME_RESERVED" });
    }
  });

  it("keeps generated BLOB names valid while refusing non-ASCII lookalikes", () => {
    expect(validateDisplayName("BLOB-3F84A1C2D5E").success).toBe(true);
    expect(validateDisplayName("Аdmin")).toEqual({ success: false, code: "DISPLAY_NAME_INVALID" });
  });
});

describe("movement input validation", () => {
  it("only accepts finite normalized intent components", () => {
    expect(movementIntentSchema.parse({ x: 1, y: -0.5 })).toEqual({ x: 1, y: -0.5 });
    expect(movementIntentSchema.safeParse({ x: 2, y: 0 }).success).toBe(false);
    expect(movementIntentSchema.safeParse({ x: Number.NaN, y: 0 }).success).toBe(false);
  });
});

describe("arena chat validation", () => {
  it("normalizes a bounded plain-text message", () => {
    expect(validateChatMessage({ text: "  nice\u200B move   blob! " })).toEqual({
      success: true,
      data: { text: "nice move blob!" }
    });
  });

  it("rejects links at the server boundary, including common obfuscation", () => {
    for (const text of ["https://example.com", "www.blob.lat", "join blob[.]gg", "hxxps://bad.site"]) {
      expect(validateChatMessage({ text })).toEqual({ success: false, code: "CHAT_LINKS_NOT_ALLOWED" });
    }
  });

  it("rejects empty, oversized, and malformed chat payloads", () => {
    expect(validateChatMessage({ text: "   " })).toEqual({ success: false, code: "CHAT_INVALID" });
    expect(validateChatMessage({ text: "a".repeat(241) })).toEqual({ success: false, code: "CHAT_INVALID" });
    expect(validateChatMessage({ text: "hello", extra: true })).toEqual({ success: false, code: "CHAT_INVALID" });
  });
});
