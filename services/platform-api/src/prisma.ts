import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "./generated/prisma/client.js";

export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl })
  });
}

/** A static query proves the durable store is usable, not merely configured. */
export async function verifyPrismaConnection(prisma: PrismaClient): Promise<void> {
  await prisma.$queryRaw(Prisma.sql`SELECT 1`);
}
