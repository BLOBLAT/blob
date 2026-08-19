import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { AuthError, AuthService } from "./auth.js";
import type { PlatformAuthRepository } from "./auth-types.js";
import type { PlatformApiConfig } from "./config.js";

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

export interface PlatformAppOptions {
  config: PlatformApiConfig;
  repository: PlatformAuthRepository;
  /** The production entrypoint supplies a durable-store readiness probe. */
  healthCheck: () => Promise<void>;
}

export function createPlatformApp(options: PlatformAppOptions): express.Express {
  const app = express();
  const auth = new AuthService(options.repository, {
    publicOrigin: options.config.publicOrigin,
    challengeTtlMs: options.config.challengeTtlMs,
    sessionTtlMs: options.config.sessionTtlMs,
    renameCooldownMs: options.config.renameCooldownMs
  });

  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    next();
  });
  app.use(cors({
    origin(origin, callback) {
      if (!origin || options.config.allowedWebOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed to access the platform API."));
    },
    credentials: true,
    methods: ["GET", "PATCH", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    optionsSuccessStatus: 204
  }));
  app.use(express.json({ limit: "16kb", strict: true, type: "application/json" }));
  app.use(cookieParser());

  app.get("/health", asyncRoute(async (_request, response) => {
    try {
      await options.healthCheck();
      response.status(200).json({ service: "blob-platform-api", status: "ok" });
    } catch (error) {
      console.error("[BLOB platform API] health check failed", error);
      response.status(503).json({ service: "blob-platform-api", status: "unavailable" });
    }
  }));

  app.post("/v1/auth/challenge", asyncRoute(async (request, response) => {
    const body = challengeRequestSchema.parse(request.body);
    const challenge = await auth.issueChallenge(body.walletAddress);
    response.status(201).json({
      challengeId: challenge.challengeId,
      message: challenge.message,
      expiresAt: challenge.expiresAt.toISOString()
    });
  }));

  app.post("/v1/auth/verify", asyncRoute(async (request, response) => {
    const body = verifyRequestSchema.parse(request.body);
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

  app.patch("/v1/me/profile", asyncRoute(async (request, response) => {
    const user = await requireUser(auth, options.config, request);
    const body = profileRequestSchema.parse(request.body);
    const renamed = await auth.rename(user, body.displayName);
    response.status(200).json({ user: toPublicUser(renamed) });
  }));

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "REQUEST_INVALID", message: "Request data is invalid." });
      return;
    }
    if (error instanceof AuthError) {
      const status = error.code === "AUTH_REQUIRED" ? 401 : error.code === "PROFILE_RENAME_RATE_LIMITED" ? 429 : 400;
      response.status(status).json({ error: error.code, message: error.message });
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
