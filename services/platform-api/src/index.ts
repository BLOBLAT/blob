import { createServer } from "node:http";
import { createPlatformApp } from "./app.js";
import { loadPlatformApiConfig } from "./config.js";
import { createPrismaClient, verifyPrismaConnection } from "./prisma.js";
import { PrismaAuthRepository } from "./prisma-auth-repository.js";
import { PrismaArenaChatAuditRepository } from "./arena-chat-audit.js";

const config = loadPlatformApiConfig();
const prisma = createPrismaClient(config.databaseUrl);
await verifyPrismaConnection(prisma);
const arenaChatRepository = new PrismaArenaChatAuditRepository(prisma);
await arenaChatRepository.pruneExpired(new Date());
const app = createPlatformApp({
  config,
  repository: new PrismaAuthRepository(prisma),
  arenaChatRepository,
  healthCheck: () => verifyPrismaConnection(prisma)
});
const server = createServer(app);
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
