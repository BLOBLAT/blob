import { createServer } from "node:http";
import * as ed25519 from "@noble/ed25519";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlatformApp } from "./app.js";
import type { PlatformAuthRepository } from "./auth-types.js";
import type { PlatformApiConfig } from "./config.js";
import type { ReferralRepository } from "./referrals.js";

const servers: ReturnType<typeof createServer>[] = [];
const RECORD = {
  eventId: "free-round:free-match-1:round-1:aa3b4583-48e4-4963-b32d-b18be97e1dc6",
  profileUserId: "aa3b4583-48e4-4963-b32d-b18be97e1dc6",
  matchId: "free-match-1",
  roundId: "round-1",
  completedAt: Date.UTC(2026, 7, 28, 12, 0, 0),
  foodCollected: 20,
  survivalTimeMs: 2 * 60 * 1_000,
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("referral qualification endpoint", () => {
  it("accepts a game-server-signed completion fact and never accepts browser point totals", async () => {
    const privateKey = ed25519.utils.randomSecretKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const qualifyReferral = vi.fn(async (_input: Parameters<ReferralRepository["qualifyReferral"]>[0]) => "QUALIFIED" as const);
    const record = { ...RECORD, completedAt: Date.now() };
    const response = await requestQualification({ publicKey, qualifyReferral }, record, privateKey);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: "QUALIFIED" });
    expect(qualifyReferral).toHaveBeenCalledWith({
      profileUserId: record.profileUserId,
      matchId: record.matchId,
      roundId: record.roundId,
      sourceEventId: record.eventId,
      completedAt: new Date(record.completedAt),
      foodCollected: record.foodCollected,
      survivalTimeMs: record.survivalTimeMs,
      referrerPoints: 100n,
      refereePoints: 25n,
      maxQualificationsPerReferrerPerDay: 10,
    });
  });

  it("rejects an unsigned completion request before the ledger repository is reached", async () => {
    const privateKey = ed25519.utils.randomSecretKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const qualifyReferral = vi.fn(async (_input: Parameters<ReferralRepository["qualifyReferral"]>[0]) => "QUALIFIED" as const);
    const response = await requestQualification({ publicKey, qualifyReferral }, { ...RECORD, completedAt: Date.now() });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "REFERRAL_QUALIFICATION_UNAUTHORIZED" });
    expect(qualifyReferral).not.toHaveBeenCalled();
  });
});

async function requestQualification(
  options: { publicKey: Uint8Array; qualifyReferral: ReferralRepository["qualifyReferral"] },
  record: typeof RECORD,
  privateKey?: Uint8Array,
): Promise<Response> {
  const app = createPlatformApp({
    config: {
      databaseUrl: "postgresql://blob:blob@127.0.0.1:5432/blob?schema=public",
      port: 3000,
      nodeEnv: "test",
      publicOrigin: "http://127.0.0.1:5173",
      allowedWebOrigins: new Set(["http://127.0.0.1:5173"]),
      sessionCookieName: "blob_session",
      sessionTtlMs: 60_000,
      challengeTtlMs: 60_000,
      renameCooldownMs: 60_000,
      authChallengeRateLimit: 2,
      authVerifyRateLimit: 2,
      authGlobalRateLimit: 3,
      authRateLimitWindowMs: 60_000,
      globalRateLimitWindowMs: 60_000,
      gameTicketPrivateKey: undefined,
      gameTicketTtlMs: 60_000,
      gameTicketRateLimit: 2,
      gameTicketGlobalRateLimit: 3,
      paidAdmissionTicketPrivateKey: undefined,
      paidAdmissionConsumerPublicKey: undefined,
      arenaChatAuditPublicKey: undefined,
      referralQualificationPublicKey: options.publicKey,
      arenaChatRetentionDays: 90,
      referralReferrerPoints: 100n,
      referralRefereePoints: 25n,
      referralAttributionWindowMs: 7 * 24 * 60 * 60 * 1_000,
      referralMinimumFoodCollected: 20,
      referralMinimumSurvivalTimeMs: 2 * 60 * 1_000,
      referralMaxQualificationsPerReferrerPerDay: 10,
      referralAttributionRateLimit: 4,
      referralAttributionGlobalRateLimit: 120,
    } satisfies PlatformApiConfig,
    repository: {} as PlatformAuthRepository,
    referralRepository: {
      getDashboard: async () => ({
        code: "ABCD234567",
        totalPoints: 0n,
        invitedCount: 0,
        qualifiedCount: 0,
        referralBound: false,
        recentEntries: [],
      }),
      captureAttribution: async () => "ALREADY_ATTRIBUTED",
      qualifyReferral: options.qualifyReferral,
    } satisfies ReferralRepository,
    healthCheck: async () => undefined,
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start test HTTP server.");
  }
  const body = Buffer.from(JSON.stringify(record));
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (privateKey) {
    headers["X-BLOB-Referral-Qualification-Signature"] = Buffer.from(await ed25519.signAsync(body, privateKey)).toString("base64");
  }
  return fetch("http://127.0.0.1:" + address.port + "/internal/referrals/qualifications", {
    method: "POST",
    headers,
    body,
  });
}
