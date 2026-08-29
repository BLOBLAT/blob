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
    // The code is generated server-side as digits, but escaping keeps this
    // presentation layer safe if that implementation ever changes.
    const code = escapeHtml(input.code);
    const expiresAt = escapeHtml(input.expiresAt.toISOString());
    try {
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
          html: `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#100713;color:#fff8f1;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#100713;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:#210825;border:1px solid #713760;border-radius:20px;overflow:hidden;">
          <tr><td style="padding:34px 32px 12px;color:#ff6394;font-size:13px;font-weight:800;letter-spacing:2px;">BLOB REFERRAL</td></tr>
          <tr><td style="padding:0 32px 8px;color:#fff8f1;font-size:30px;line-height:1.1;font-weight:900;">Verify your email</td></tr>
          <tr><td style="padding:8px 32px 24px;color:#d9cbd7;font-size:16px;line-height:1.55;">Use this code to activate your BLOB referral profile:</td></tr>
          <tr><td align="center" style="padding:0 32px 28px;">
            <div style="display:inline-block;background:#100713;border:2px solid #ff6394;border-radius:14px;padding:17px 21px 15px;color:#ffd54f;font-size:42px;line-height:1;font-weight:900;letter-spacing:0.18em;white-space:nowrap;">${code}</div>
          </td></tr>
          <tr><td style="padding:0 32px 12px;color:#d9cbd7;font-size:14px;line-height:1.55;">This code expires at ${expiresAt}.</td></tr>
          <tr><td style="padding:0 32px 34px;color:#a993a4;font-size:13px;line-height:1.55;">If you did not request this, you can ignore this email. BLOB will never ask for your seed phrase or private key.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        return;
      }
      // Never write the recipient, message, provider response body, or API
      // key to logs. The status is enough to diagnose account/domain issues.
      console.warn("[BLOB platform API] referral email delivery was rejected", {
        provider: "resend",
        status: response.status,
      });
      throw new Error("Resend delivery request failed with status " + response.status);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Resend delivery request failed")) {
        throw error;
      }
      // Fetch timeouts and transport failures also remain non-sensitive.
      console.warn("[BLOB platform API] referral email delivery could not reach provider", {
        provider: "resend",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      throw new Error("Resend delivery request could not be completed");
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
