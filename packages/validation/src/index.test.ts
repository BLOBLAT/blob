import { describe, expect, it } from "vitest";
import { movementIntentSchema, playerJoinOptionsSchema, validateChatMessage } from "./index.js";

describe("player join validation", () => {
  it("accepts a bounded display name", () => {
    expect(playerJoinOptionsSchema.parse({ name: "BLOB-42" })).toEqual({ name: "BLOB-42" });
  });

  it("rejects unsafe or oversized display names", () => {
    expect(playerJoinOptionsSchema.safeParse({ name: "<script>" }).success).toBe(false);
    expect(playerJoinOptionsSchema.safeParse({ name: "A".repeat(17) }).success).toBe(false);
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
