-- Retain the referral contact address only under application-layer AES-256-GCM
-- encryption. Existing HMAC-only rows remain valid and do not gain an address.

ALTER TABLE "ReferralEmailVerification" ADD COLUMN "encryptedEmail" TEXT;
