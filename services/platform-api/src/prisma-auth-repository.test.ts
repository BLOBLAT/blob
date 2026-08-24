import { describe, expect, it } from "vitest";
import { DisplayNameConflictError } from "./auth-types.js";
import { PrismaAuthRepository } from "./prisma-auth-repository.js";
import type { PrismaClient } from "./generated/prisma/client.js";

describe("Prisma profile-name conflicts", () => {
  it("maps only the canonical display-name unique violation to the profile domain error", async () => {
    const repository = new PrismaAuthRepository({
      user: {
        update: async () => {
          throw { code: "P2002", meta: { target: ["User_displayNameKey_key"] } };
        }
      }
    } as unknown as PrismaClient);

    await expect(repository.renameUser({
      userId: "user-1",
      displayName: "Blob Prime",
      displayNameKey: "BLOB PRIME",
      renamedAt: new Date("2026-08-24T12:00:00.000Z")
    })).rejects.toBeInstanceOf(DisplayNameConflictError);
  });

  it("does not misclassify another Prisma uniqueness violation as a display-name conflict", async () => {
    const uniqueError = { code: "P2002", meta: { target: ["Wallet_address_key"] } };
    const repository = new PrismaAuthRepository({
      user: {
        update: async () => {
          throw uniqueError;
        }
      }
    } as unknown as PrismaClient);

    await expect(repository.renameUser({
      userId: "user-1",
      displayName: "Blob Prime",
      displayNameKey: "BLOB PRIME",
      renamedAt: new Date("2026-08-24T12:00:00.000Z")
    })).rejects.toBe(uniqueError);
  });
});
