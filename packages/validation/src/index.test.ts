import { describe, expect, it } from "vitest";
import { movementIntentSchema, playerJoinOptionsSchema } from "./index.js";

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
