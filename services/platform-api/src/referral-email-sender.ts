import type { ReferralEmailSender } from "./referral-email.js";

export interface ResendEmailConfig {
  apiKey: string;
  from: string;
}

/** A tiny server-only Resend adapter. No email provider SDK or key reaches Vite. */
export class ResendReferralEmailSender implements ReferralEmailSender {
  constructor(
    private readonly config: ResendEmailConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  async sendVerification(input: { email: string; code: string; expiresAt: Date; idempotencyKey: string }): Promise<void> {
    const response = await this.request("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + this.config.apiKey,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        from: this.config.from,
        to: [input.email],
        subject: "Your BLOB referral verification code",
        text: `Your BLOB referral verification code is ${input.code}. It expires at ${input.expiresAt.toISOString()}. If you did not request this, ignore this email. BLOB will never ask for a seed phrase or private key.`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error("Resend delivery request failed with status " + response.status);
    }
  }
}
