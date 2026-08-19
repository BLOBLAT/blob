import { createServer } from "node:http";
import { createPlatformApp } from "./app.js";
import { loadPlatformApiConfig } from "./config.js";
import { createPrismaClient, verifyPrismaConnection } from "./prisma.js";
import { PrismaAuthRepository } from "./prisma-auth-repository.js";

const config = loadPlatformApiConfig();
const prisma = createPrismaClient(config.databaseUrl);
await verifyPrismaConnection(prisma);
const app = createPlatformApp({
  config,
  repository: new PrismaAuthRepository(prisma),
  healthCheck: () => verifyPrismaConnection(prisma)
});
const server = createServer(app);

server.listen(config.port, "0.0.0.0", () => {
  console.log("[BLOB platform API] listening on port " + config.port);
});

async function shutdown(): Promise<void> {
  server.close();
  await prisma.$disconnect();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
