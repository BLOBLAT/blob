import { describe, expect, it, vi } from "vitest";
import { ResendReferralEmailSender } from "./referral-email-sender.js";

describe("ResendReferralEmailSender", () => {
  it("logs only the provider HTTP status when delivery is rejected", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request: typeof fetch = async () => new Response("recipient@example.com", { status: 403 });
    const sender = new ResendReferralEmailSender({ apiKey: "re_test", from: "BLOB <verify@example.com>" }, request);

    await expect(sender.sendVerification({
      email: "player@example.com",
      code: "123456",
      expiresAt: new Date("2026-08-29T00:00:00.000Z"),
      idempotencyKey: "email-test",
    })).rejects.toThrow("status 403");

    expect(warning).toHaveBeenCalledWith(
      "[BLOB platform API] referral email delivery was rejected",
      { provider: "resend", status: 403 },
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain("player@example.com");
    warning.mockRestore();
  });
});
