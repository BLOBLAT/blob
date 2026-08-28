import { createServer } from "node:http";
import { createPlatformApp } from "./app.js";
import { loadPlatformApiConfig } from "./config.js";
import { createPrismaClient, verifyPrismaConnection } from "./prisma.js";
import { PrismaAuthRepository } from "./prisma-auth-repository.js";
import { PrismaArenaChatAuditRepository } from "./arena-chat-audit.js";
import { PrismaPaidAdmissionRepository } from "./paid-admission-repository.js";
import { PrismaReferralRepository } from "./prisma-referral-repository.js";
import { PrismaReferralEmailRepository } from "./prisma-referral-email-repository.js";
import { ResendReferralEmailSender } from "./referral-email-sender.js";

const config = loadPlatformApiConfig();
const prisma = createPrismaClient(config.databaseUrl);
await verifyPrismaConnection(prisma);
const arenaChatRepository = new PrismaArenaChatAuditRepository(prisma);
const paidAdmissionRepository = new PrismaPaidAdmissionRepository(prisma);
const referralRepository = new PrismaReferralRepository(prisma);
const referralEmailRepository = new PrismaReferralEmailRepository(prisma);
const referralEmailSender = config.referralEmailHashSecret && config.resendApiKey && config.resendFrom
  ? new ResendReferralEmailSender({ apiKey: config.resendApiKey, from: config.resendFrom })
  : undefined;
await arenaChatRepository.pruneExpired(new Date());
const app = createPlatformApp({
  config,
  repository: new PrismaAuthRepository(prisma),
  arenaChatRepository,
  paidAdmissionRepository,
  referralRepository,
  referralEmailRepository,
  referralEmailSender,
  healthCheck: () => verifyPrismaConnection(prisma)
});
const server = createServer(app);
// Bound incomplete HTTP requests before they can occupy Node sockets or
// PostgreSQL-facing request handlers during a slow-request flood. WebSockets
// are owned by the separate game service, not this API.
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 64;
server.maxRequestsPerSocket = 100;
const chatCleanupTimer = setInterval(() => {
  void arenaChatRepository.pruneExpired(new Date()).catch((error: unknown) => {
    console.error("[BLOB platform API] arena chat retention cleanup failed", error);
  });
}, 6 * 60 * 60 * 1_000);
chatCleanupTimer.unref();

server.listen(config.port, "0.0.0.0", () => {
  console.log("[BLOB platform API] listening on port " + config.port);
});

async function shutdown(): Promise<void> {
  clearInterval(chatCleanupTimer);
  server.close();
  await prisma.$disconnect();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
