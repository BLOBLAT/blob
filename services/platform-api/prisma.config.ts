import { defineConfig } from "prisma/config";

/**
 * Prisma needs a datasource value even for code generation. The fallback is
 * local-only and the API itself refuses to start without DATABASE_URL.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations"
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/blob?schema=public"
  }
});
