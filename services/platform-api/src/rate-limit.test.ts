import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "./rate-limit.js";

describe("fixed-window auth rate limiter", () => {
  it("blocks repeated requests until the configured window expires", () => {
    const limiter = new FixedWindowRateLimiter(2, 10_000);
    expect(limiter.consume("wallet", 1_000)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.consume("wallet", 1_500)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.consume("wallet", 2_000)).toEqual({ allowed: false, retryAfterSeconds: 9 });
    expect(limiter.consume("wallet", 11_000)).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("keeps its in-memory key set bounded under random-wallet abuse", () => {
    const limiter = new FixedWindowRateLimiter(1, 10_000, 2);
    limiter.consume("first", 1_000);
    limiter.consume("second", 2_000);
    limiter.consume("third", 3_000);
    expect(limiter.consume("first", 3_001)).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });
});
