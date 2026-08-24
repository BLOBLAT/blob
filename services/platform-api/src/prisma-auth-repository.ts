import type {
  AuthChallengeRecord,
  AuthenticatedUser,
  AuthSessionRecord,
  PlatformAuthRepository
} from "./auth-types.js";
import { DisplayNameConflictError } from "./auth-types.js";
import type { PrismaClient } from "./generated/prisma/client.js";

export class PrismaAuthRepository implements PlatformAuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createChallenge(challenge: AuthChallengeRecord): Promise<void> {
    await this.prisma.authChallenge.create({
      data: {
        id: challenge.id,
        walletAddress: challenge.walletAddress,
        nonce: challenge.nonce,
        nonceHash: challenge.nonceHash,
        messageHash: challenge.messageHash,
        expiresAt: challenge.expiresAt,
        createdAt: challenge.createdAt
      }
    });
  }

  async findActiveChallenge(challengeId: string, now: Date): Promise<AuthChallengeRecord | null> {
    const challenge = await this.prisma.authChallenge.findFirst({
      where: {
        id: challengeId,
        consumedAt: null,
        expiresAt: { gt: now }
      }
    });
    return challenge ? {
      id: challenge.id,
      walletAddress: challenge.walletAddress,
      nonce: challenge.nonce,
      nonceHash: challenge.nonceHash,
      messageHash: challenge.messageHash,
      expiresAt: challenge.expiresAt,
      createdAt: challenge.createdAt,
      consumedAt: challenge.consumedAt
    } : null;
  }

  async consumeChallenge(challengeId: string, now: Date): Promise<boolean> {
    const updated = await this.prisma.authChallenge.updateMany({
      where: {
        id: challengeId,
        consumedAt: null,
        expiresAt: { gt: now }
      },
      data: { consumedAt: now }
    });
    return updated.count === 1;
  }

  async findOrCreateUserWithWallet(input: {
    displayName: string;
    displayNameKey: string;
    walletAddress: string;
    now: Date;
  }): Promise<{ user: AuthenticatedUser; created: boolean }> {
    const existing = await this.prisma.wallet.findUnique({
      where: { address: input.walletAddress },
      include: { user: true }
    });
    if (existing) {
      return {
        user: {
          userId: existing.user.id,
          displayName: existing.user.displayName,
          walletAddress: existing.address,
          renamedAt: existing.user.renamedAt
        },
        created: false
      };
    }
    let wallet: {
      address: string;
      user: { id: string; displayName: string; renamedAt: Date | null };
    };
    try {
      wallet = await this.prisma.wallet.upsert({
        where: { address: input.walletAddress },
        update: {},
        create: {
          address: input.walletAddress,
          verifiedAt: input.now,
          user: {
            create: {
              displayName: input.displayName,
              displayNameKey: input.displayNameKey,
              createdAt: input.now
            }
          }
        },
        include: { user: true }
      });
    } catch (error) {
      if (isDisplayNameKeyConflict(error)) {
        throw new DisplayNameConflictError("Display name is already in use.");
      }
      throw error;
    }
    return {
      user: {
        userId: wallet.user.id,
        displayName: wallet.user.displayName,
        walletAddress: wallet.address,
        renamedAt: wallet.user.renamedAt
      },
      created: existing === null
    };
  }

  async createSession(input: { tokenHash: string; userId: string; walletAddress: string; expiresAt: Date }): Promise<void> {
    await this.prisma.session.create({
      data: input
    });
  }

  async findActiveSession(tokenHash: string, now: Date): Promise<AuthSessionRecord | null> {
    const session = await this.prisma.session.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: now }
      },
      include: { user: true }
    });
    return session ? {
      id: session.id,
      tokenHash: session.tokenHash,
      user: {
        userId: session.user.id,
        displayName: session.user.displayName,
        walletAddress: session.walletAddress,
        renamedAt: session.user.renamedAt
      },
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt
    } : null;
  }

  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: {
        tokenHash,
        revokedAt: null
      },
      data: { revokedAt: now }
    });
  }

  async renameUser(input: {
    userId: string;
    displayName: string;
    displayNameKey: string;
    renamedAt: Date;
  }): Promise<AuthenticatedUser> {
    let user: { id: string; displayName: string; renamedAt: Date | null };
    try {
      user = await this.prisma.user.update({
        where: { id: input.userId },
        data: {
          displayName: input.displayName,
          displayNameKey: input.displayNameKey,
          renamedAt: input.renamedAt
        }
      });
    } catch (error) {
      if (isDisplayNameKeyConflict(error)) {
        throw new DisplayNameConflictError("Display name is already in use.");
      }
      throw error;
    }
    const wallet = await this.prisma.wallet.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" }
    });
    if (!wallet) {
      throw new Error("Authenticated user has no wallet.");
    }
    return {
      userId: user.id,
      displayName: user.displayName,
      walletAddress: wallet.address,
      renamedAt: user.renamedAt
    };
  }

  async recordAuditEvent(input: {
    userId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        userId: input.userId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: input.metadata ?? {}
      }
    });
  }
}

function isDisplayNameKeyConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== "P2002") {
    return false;
  }
  const target = candidate.meta?.target;
  const fields = Array.isArray(target)
    ? target.filter((value): value is string => typeof value === "string")
    : typeof target === "string"
      ? [target]
      : [];
  return fields.some((field) => field.includes("displayNameKey"));
}
