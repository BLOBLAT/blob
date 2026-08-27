import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { AuthError, AuthService } from "./auth.js";
import type { PlatformAuthRepository } from "./auth-types.js";
import type { PlatformApiConfig } from "./config.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { GameTicketDisplayNameError, issueGameTicket } from "./game-ticket.js";
import { verifyArenaChatAuditRequest, type ArenaChatAuditRepository } from "./arena-chat-audit.js";
import { verifyPaidAdmissionConsumeRequest } from "./paid-admission-consumer.js";
import type { PrismaPaidAdmissionRepository } from "./paid-admission-repository.js";
import { ReferralError, ReferralService, type ReferralDashboard, type ReferralRepository } from "./referrals.js";
import { verifyReferralQualificationRequest } from "./referral-qualification.js";

class OriginNotAllowedError extends Error {}

const challengeRequestSchema = z.object({
  walletAddress: z.string().min(32).max(64)
}).strict();

const verifyRequestSchema = z.object({
  challengeId: z.string().min(32).max(256),
  walletAddress: z.string().min(32).max(64),
  signatureBase64: z.string().min(80).max(256)
}).strict();

const profileRequestSchema = z.object({
  displayName: z.string().min(1).max(64)
}).strict();

const referralAttributionRequestSchema = z.object({
  code: z.string().min(1).max(32)
}).strict();

export interface PlatformAppOptions {
  config: PlatformApiConfig;
  repository: PlatformAuthRepository;
  arenaChatRepository?: ArenaChatAuditRepository;
  paidAdmissionRepository?: Pick<PrismaPaidAdmissionRepository, "consume">;
  referralRepository?: ReferralRepository;
  /** The production entrypoint supplies a durable-store readiness probe. */
  healthCheck: () => Promise<void>;
}

export function createPlatformApp(options: PlatformAppOptions): express.Express {
  const app = express();
  const challengeRateLimiter = new FixedWindowRateLimiter(
    options.config.authChallengeRateLimit,
    options.config.authRateLimitWindowMs
  );
  const verifyRateLimiter = new FixedWindowRateLimiter(
    options.config.authVerifyRateLimit,
    options.config.authRateLimitWindowMs
  );
  const globalChallengeRateLimiter = new FixedWindowRateLimiter(
    options.config.authGlobalRateLimit,
    options.config.globalRateLimitWindowMs,
    1
  );
  const globalVerifyRateLimiter = new FixedWindowRateLimiter(
    options.config.authGlobalRateLimit,
    options.config.globalRateLimitWindowMs,
    1
  );
  const gameTicketRateLimiter = new FixedWindowRateLimiter(
    options.config.gameTicketRateLimit,
    options.config.authRateLimitWindowMs
  );
  const globalGameTicketRateLimiter = new FixedWindowRateLimiter(
    options.config.gameTicketGlobalRateLimit,
    options.config.globalRateLimitWindowMs,
    1
  );
  const cachedHealthCheck = createCachedHealthCheck(options.healthCheck);
  const auth = new AuthService(options.repository, {
    publicOrigin: options.config.publicOrigin,
    challengeTtlMs: options.config.challengeTtlMs,
    sessionTtlMs: options.config.sessionTtlMs,
    renameCooldownMs: options.config.renameCooldownMs
  });
  const referrals = options.referralRepository
    ? new ReferralService(options.referralRepository, {
      referrer: options.config.referralReferrerPoints,
      referee: options.config.referralRefereePoints,
    })
    : undefined;

  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (options.config.nodeEnv === "production") {
      response.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    }
    next();
  });
  const browserCors = cors({
    origin: true,
    credentials: true,
    methods: ["GET", "PATCH", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    optionsSuccessStatus: 204
  });
  app.use((request, response, next) => {
    const origin = request.get("Origin");
    if (!origin) {
      next();
      return;
    }
    if (!options.config.allowedWebOrigins.has(origin)) {
      next(new OriginNotAllowedError("Origin is not allowed to access the platform API."));
      return;
    }
    browserCors(request, response, next);
  });

  // This endpoint is only for the Railway-private game service. It deliberately
  // uses the exact raw body for Ed25519 verification before any JSON parser
  // can alter it. Browsers neither call nor read this audit stream.
  app.post("/internal/arena-chat/messages", express.raw({ type: "application/json", limit: "2kb" }), asyncRoute(async (request, response) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body : undefined;
    if (!rawBody || !options.arenaChatRepository) {
      response.status(503).json({ error: "AUDIT_UNAVAILABLE" });
      return;
    }
    const verified = await verifyArenaChatAuditRequest({
      rawBody,
      signatureHeader: request.get("X-BLOB-Arena-Audit-Signature") ?? undefined,
      publicKey: options.config.arenaChatAuditPublicKey,
      retentionDays: options.config.arenaChatRetentionDays
    });
    if (!verified.success) {
      response.status(verified.error === "AUDIT_UNAVAILABLE" ? 503 : verified.error === "AUDIT_UNAUTHORIZED" ? 401 : 400)
        .json({ error: verified.error });
      return;
    }
    await options.arenaChatRepository.store(verified.record);
    console.info(JSON.stringify({
      service: "blob-platform-api",
      event: "arena_chat_recorded",
      messageId: verified.record.id,
      roomId: verified.record.roomId
    }));
    response.status(201).json({ status: "recorded" });
  }));
  // Reserved for a future separate Paid Room. This raw signed request is not
  // a browser API and remains unavailable unless a consumer key is configured.
  app.post("/internal/paid-admissions/consume", express.raw({ type: "application/json", limit: "4kb" }), asyncRoute(async (request, response) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body : undefined;
    if (!rawBody || !options.paidAdmissionRepository) {
      response.status(503).json({ error: "ADMISSION_UNAVAILABLE" });
      return;
    }
    const verified = await verifyPaidAdmissionConsumeRequest({
      rawBody,
      signatureHeader: request.get("X-BLOB-Paid-Admission-Signature") ?? undefined,
      publicKey: options.config.paidAdmissionConsumerPublicKey,
    });
    if (!verified.success) {
      response.status(verified.error === "ADMISSION_UNAVAILABLE" ? 503 : verified.error === "ADMISSION_UNAUTHORIZED" ? 401 : 400)
        .json({ error: verified.error });
      return;
    }
    await options.paidAdmissionRepository.consume(verified.payload);
    console.info(JSON.stringify({
      service: "blob-platform-api",
      event: "paid_admission_consumed",
      entryId: verified.payload.claims.entryId,
      matchId: verified.payload.claims.matchId,
    }));
    response.status(204).end();
  }));
  // A Free Mode browser never calls this route. The persistent game service
  // signs the compact completion fact after its authoritative round result is
  // fixed, allowing referral points without trusting a client score or wallet.
  app.post("/internal/referrals/qualifications", express.raw({ type: "application/json", limit: "2kb" }), asyncRoute(async (request, response) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body : undefined;
    if (!rawBody || !referrals) {
      response.status(503).json({ error: "REFERRAL_QUALIFICATION_UNAVAILABLE" });
      return;
    }
    const verified = await verifyReferralQualificationRequest({
      rawBody,
      signatureHeader: request.get("X-BLOB-Referral-Qualification-Signature") ?? undefined,
      publicKey: options.config.referralQualificationPublicKey,
    });
    if (!verified.success) {
      response.status(verified.error === "REFERRAL_QUALIFICATION_UNAVAILABLE" ? 503 : verified.error === "REFERRAL_QUALIFICATION_UNAUTHORIZED" ? 401 : 400)
        .json({ error: verified.error });
      return;
    }
    const outcome = await referrals.qualify({
      profileUserId: verified.record.profileUserId,
      matchId: verified.record.matchId,
      roundId: verified.record.roundId,
      sourceEventId: verified.record.eventId,
      completedAt: new Date(verified.record.completedAt),
    });
    console.info(JSON.stringify({
      service: "blob-platform-api",
      event: "referral_qualification_processed",
      matchId: verified.record.matchId,
      roundId: verified.record.roundId,
      outcome,
    }));
    response.status(201).json({ status: outcome });
  }));
  app.use(express.json({ limit: "16kb", strict: true, type: "application/json" }));
  app.use(cookieParser());

  app.get("/health", asyncRoute(async (_request, response) => {
    try {
      await cachedHealthCheck();
      response.status(200).json({ service: "blob-platform-api", status: "ok" });
    } catch (error) {
      console.error("[BLOB platform API] health check failed", error);
      response.status(503).json({ service: "blob-platform-api", status: "unavailable" });
    }
  }));

  app.post("/v1/auth/challenge", asyncRoute(async (request, response) => {
    const body = challengeRequestSchema.parse(request.body);
    if (!consumeRateLimit(response, challengeRateLimiter, "challenge:" + body.walletAddress)
      || !consumeRateLimit(response, globalChallengeRateLimiter, "challenge:global")) {
      return;
    }
    const challenge = await auth.issueChallenge(body.walletAddress);
    response.status(201).json({
      challengeId: challenge.challengeId,
      message: challenge.message,
      expiresAt: challenge.expiresAt.toISOString()
    });
  }));

  app.post("/v1/auth/verify", asyncRoute(async (request, response) => {
    const body = verifyRequestSchema.parse(request.body);
    if (!consumeRateLimit(response, verifyRateLimiter, "verify:" + body.walletAddress)
      || !consumeRateLimit(response, globalVerifyRateLimiter, "verify:global")) {
      return;
    }
    const session = await auth.verifyChallenge(body);
    writeSessionCookie(response, options.config, session.token, session.expiresAt);
    response.status(200).json({ user: toPublicUser(session.user), expiresAt: session.expiresAt.toISOString() });
  }));

  app.post("/v1/auth/logout", asyncRoute(async (request, response) => {
    await auth.logout(request.cookies[options.config.sessionCookieName]);
    clearSessionCookie(response, options.config);
    response.status(204).end();
  }));

  app.get("/v1/me", asyncRoute(async (request, response) => {
    const user = await requireUser(auth, options.config, request);
    response.status(200).json({ user: toPublicUser(user) });
  }));

  app.get("/v1/me/referral", asyncRoute(async (request, response) => {
    const user = await requireUser(auth, options.config, request);
    if (!referrals) {
      response.status(503).json({ error: "REFERRALS_UNAVAILABLE", message: "The referral program is temporarily unavailable." });
      return;
    }
    const dashboard = await referrals.getDashboard(user.userId);
    response.status(200).json({ referral: toPublicReferralDashboard(dashboard, options.config.publicOrigin) });
  }));

  app.post("/v1/me/referral/attribution", asyncRoute(async (request, response) => {
    const user = await requireUser(auth, options.config, request);
    if (!referrals) {
      response.status(503).json({ error: "REFERRALS_UNAVAILABLE", message: "The referral program is temporarily unavailable." });
      return;
    }
    const body = referralAttributionRequestSchema.parse(request.body);
    const outcome = await referrals.captureAttribution({ refereeUserId: user.userId, code: body.code });
    response.status(200).json({ status: outcome });
  }));

  app.get("/v1/me/game-ticket", asyncRoute(async (request, response) => {
    const user = await requireUser(auth, options.config, request);
    if (!options.config.gameTicketPrivateKey) {
      response.status(503).json({ error: "GAME_IDENTITY_UNAVAILABLE", message: "Arena profile identity is unavailable." });
      return;
    }
    if (!consumeRateLimit(response, gameTicketRateLimiter, "game-ticket:" + user.userId)
      || !consumeRateLimit(response, globalGameTicketRateLimiter, "game-ticket:global")) {
      return;
    }
    const issued = await issueGameTicket({
      user,
      privateKey: options.config.gameTicketPrivateKey,
      ttlMs: options.config.gameTicketTtlMs
    });
    response.status(200).json({ ticket: issued.ticket, expiresAt: issued.expiresAt.toISOString() });
  }));

  app.patch("/v1/me/profile", asyncRoute(async (request, response) => {
    const user = await requireUser(auth, options.config, request);
    const body = profileRequestSchema.parse(request.body);
    const renamed = await auth.rename(user, body.displayName);
    response.status(200).json({ user: toPublicUser(renamed) });
  }));

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (isRequestTooLargeError(error)) {
      response.status(413).json({ error: "REQUEST_TOO_LARGE", message: "Request data is too large." });
      return;
    }
    if (error instanceof OriginNotAllowedError) {
      response.status(403).json({ error: "ORIGIN_NOT_ALLOWED", message: "This browser origin is not allowed to access the platform API." });
      return;
    }
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "REQUEST_INVALID", message: "Request data is invalid." });
      return;
    }
    if (error instanceof AuthError) {
      const status = error.code === "AUTH_REQUIRED"
        ? 401
        : error.code === "PROFILE_RENAME_RATE_LIMITED"
          ? 429
          : error.code === "PROFILE_NAME_UNAVAILABLE"
            ? 409
            : 400;
      response.status(status).json({ error: error.code, message: error.message });
      return;
    }
    if (error instanceof GameTicketDisplayNameError) {
      response.status(409).json({ error: "PROFILE_NAME_CHANGE_REQUIRED", message: error.message });
      return;
    }
    if (error instanceof ReferralError) {
      response.status(error.code === "REFERRAL_SELF_NOT_ALLOWED" ? 409 : 400).json({ error: error.code, message: error.message });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "REQUEST_INVALID", message: "Request data is invalid." });
      return;
    }
    console.error("[BLOB platform API] request failed", error);
    response.status(500).json({ error: "INTERNAL_ERROR", message: "The request could not be completed." });
  });

  return app;
}

function isRequestTooLargeError(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "type" in error
    && (error as { type?: unknown }).type === "entity.too.large";
}

function consumeRateLimit(response: Response, limiter: FixedWindowRateLimiter, key: string): boolean {
  const decision = limiter.consume(key);
  if (decision.allowed) {
    return true;
  }
  response.setHeader("Retry-After", decision.retryAfterSeconds.toString());
  response.status(429).json({ error: "RATE_LIMITED", message: "Please wait before trying again." });
  return false;
}

/**
 * Railway and load-balancer probes hit /health frequently. Coalescing and
 * briefly caching the durable-store probe avoids turning that public endpoint
 * into an unbounded PostgreSQL query amplifier during an HTTP flood.
 */
function createCachedHealthCheck(healthCheck: () => Promise<void>, successTtlMs = 5_000, failureTtlMs = 1_000): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  let cachedUntil = 0;
  let cachedError: unknown;

  return async () => {
    const now = Date.now();
    if (cachedUntil > now) {
      if (cachedError) {
        throw cachedError;
      }
      return;
    }
    if (!inFlight) {
      inFlight = healthCheck()
        .then(() => {
          cachedError = undefined;
          cachedUntil = Date.now() + successTtlMs;
        })
        .catch((error: unknown) => {
          cachedError = error;
          cachedUntil = Date.now() + failureTtlMs;
          throw error;
        })
        .finally(() => {
          inFlight = undefined;
        });
    }
    return inFlight;
  };
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    void handler(request, response).catch(next);
  };
}

async function requireUser(auth: AuthService, config: PlatformApiConfig, request: Request) {
  const user = await auth.getSession(request.cookies[config.sessionCookieName]);
  if (!user) {
    throw new AuthError("AUTH_REQUIRED", "Connect and sign in with a wallet first.");
  }
  return user;
}

function writeSessionCookie(response: Response, config: PlatformApiConfig, token: string, expiresAt: Date): void {
  response.cookie(config.sessionCookieName, token, {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt
  });
}

function clearSessionCookie(response: Response, config: PlatformApiConfig): void {
  response.clearCookie(config.sessionCookieName, {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "lax",
    path: "/"
  });
}

function toPublicUser(user: { userId: string; displayName: string; walletAddress: string; renamedAt: Date | null }) {
  return {
    id: user.userId,
    displayName: user.displayName,
    walletAddress: user.walletAddress,
    renamedAt: user.renamedAt?.toISOString() ?? null
  };
}

function toPublicReferralDashboard(dashboard: ReferralDashboard, publicOrigin: string) {
  return {
    code: dashboard.code,
    inviteUrl: publicOrigin + "/?ref=" + dashboard.code,
    totalPoints: dashboard.totalPoints.toString(),
    invitedCount: dashboard.invitedCount,
    qualifiedCount: dashboard.qualifiedCount,
    referralBound: dashboard.referralBound,
    recentEntries: dashboard.recentEntries.map((entry) => ({
      delta: entry.delta.toString(),
      reason: entry.reason,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}
