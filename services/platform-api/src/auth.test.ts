import * as ed25519 from "@noble/ed25519";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { AuthError, AuthService, canonicalizeDisplayName } from "./auth.js";
import type {
  AuthChallengeRecord,
  AuthenticatedUser,
  AuthSessionRecord,
  PlatformAuthRepository
} from "./auth-types.js";
import { encodeBase64 } from "./security.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const OPTIONS = {
  publicOrigin: "https://blob.lat",
  challengeTtlMs: 5 * 60_000,
  sessionTtlMs: 7 * 24 * 60 * 60_000,
  renameCooldownMs: 24 * 60 * 60_000
};

describe("wallet sign-in", () => {
  it("verifies a Solana wallet signature, creates a user, and issues a session", async () => {
    const repository = new InMemoryAuthRepository();
    const auth = new AuthService(repository, OPTIONS);
    const wallet = await createTestWallet();
    const challenge = await auth.issueChallenge(wallet.address, NOW);
    const signature = await ed25519.signAsync(new TextEncoder().encode(challenge.message), wallet.privateKey);

    const session = await auth.verifyChallenge({
      challengeId: challenge.challengeId,
      walletAddress: wallet.address,
      signatureBase64: encodeBase64(signature)
    }, NOW);

    expect(session.user.walletAddress).toBe(wallet.address);
    expect(session.user.displayName).toBe("BLOB-" + wallet.address.slice(-5).toUpperCase());
    expect(session.token).toHaveLength(43);
    expect(await auth.getSession(session.token, NOW)).toMatchObject({ userId: session.user.userId, walletAddress: wallet.address });
  });

  it("rejects a replayed challenge and a signature from another wallet", async () => {
    const repository = new InMemoryAuthRepository();
    const auth = new AuthService(repository, OPTIONS);
    const wallet = await createTestWallet();
    const otherWallet = await createTestWallet();
    const challenge = await auth.issueChallenge(wallet.address, NOW);
    const wrongSignature = await ed25519.signAsync(new TextEncoder().encode(challenge.message), otherWallet.privateKey);

    await expect(auth.verifyChallenge({
      challengeId: challenge.challengeId,
      walletAddress: wallet.address,
      signatureBase64: encodeBase64(wrongSignature)
    }, NOW)).rejects.toMatchObject({ code: "AUTH_SIGNATURE_INVALID" });

    const signature = await ed25519.signAsync(new TextEncoder().encode(challenge.message), wallet.privateKey);
    await auth.verifyChallenge({ challengeId: challenge.challengeId, walletAddress: wallet.address, signatureBase64: encodeBase64(signature) }, NOW);
    await expect(auth.verifyChallenge({ challengeId: challenge.challengeId, walletAddress: wallet.address, signatureBase64: encodeBase64(signature) }, NOW))
      .rejects.toMatchObject({ code: "AUTH_CHALLENGE_INVALID" });
  });

  it("enforces display-name validation and the rename cooldown", async () => {
    const repository = new InMemoryAuthRepository();
    const auth = new AuthService(repository, OPTIONS);
    const wallet = await createTestWallet();
    const session = await authenticate(auth, wallet);

    const renamed = await auth.rename(session.user, "Blob Prime", NOW);
    expect(renamed.displayName).toBe("Blob Prime");
    expect(canonicalizeDisplayName(renamed.displayName)).toBe("BLOB PRIME");
    await expect(auth.rename(renamed, "Next Blob", new Date(NOW.getTime() + 1_000))).rejects.toMatchObject({ code: "PROFILE_RENAME_RATE_LIMITED" });
    await expect(auth.rename(renamed, "<>", new Date(NOW.getTime() + OPTIONS.renameCooldownMs + 1))).rejects.toBeInstanceOf(AuthError);
  });

  it("does not consume a rename cooldown when the canonical display name is unchanged", async () => {
    const repository = new InMemoryAuthRepository();
    const auth = new AuthService(repository, OPTIONS);
    const wallet = await createTestWallet();
    const session = await authenticate(auth, wallet);
    const unchanged = await auth.rename(session.user, "  " + session.user.displayName.toLowerCase() + "  ", NOW);
    expect(unchanged).toEqual(session.user);

    await expect(auth.rename(unchanged, "Blob Prime", NOW)).resolves.toMatchObject({ displayName: "Blob Prime" });
  });
});

async function authenticate(auth: AuthService, wallet: TestWallet) {
  const challenge = await auth.issueChallenge(wallet.address, NOW);
  const signature = await ed25519.signAsync(new TextEncoder().encode(challenge.message), wallet.privateKey);
  return auth.verifyChallenge({ challengeId: challenge.challengeId, walletAddress: wallet.address, signatureBase64: encodeBase64(signature) }, NOW);
}

interface TestWallet {
  address: string;
  privateKey: Uint8Array;
}

async function createTestWallet(): Promise<TestWallet> {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = await ed25519.getPublicKeyAsync(privateKey);
  return { address: base58.encode(publicKey), privateKey };
}

class InMemoryAuthRepository implements PlatformAuthRepository {
  private readonly challenges = new Map<string, AuthChallengeRecord>();
  private readonly usersByWallet = new Map<string, AuthenticatedUser>();
  private readonly sessions = new Map<string, AuthSessionRecord>();

  async createChallenge(challenge: AuthChallengeRecord): Promise<void> {
    this.challenges.set(challenge.id, { ...challenge });
  }

  async findActiveChallenge(challengeId: string, now: Date): Promise<AuthChallengeRecord | null> {
    const challenge = this.challenges.get(challengeId);
    return challenge && !challenge.consumedAt && challenge.expiresAt > now ? { ...challenge } : null;
  }

  async consumeChallenge(challengeId: string, now: Date): Promise<boolean> {
    const challenge = await this.findActiveChallenge(challengeId, now);
    if (!challenge) {
      return false;
    }
    this.challenges.set(challengeId, { ...challenge, consumedAt: now });
    return true;
  }

  async findOrCreateUserWithWallet(input: { displayName: string; displayNameKey: string; walletAddress: string; now: Date }): Promise<{ user: AuthenticatedUser; created: boolean }> {
    const existing = this.usersByWallet.get(input.walletAddress);
    if (existing) {
      return { user: existing, created: false };
    }
    const user = {
      userId: "user-" + (this.usersByWallet.size + 1),
      displayName: input.displayName,
      walletAddress: input.walletAddress,
      renamedAt: null
    };
    this.usersByWallet.set(input.walletAddress, user);
    return { user, created: true };
  }

  async createSession(input: { tokenHash: string; userId: string; walletAddress: string; expiresAt: Date }): Promise<void> {
    const user = this.usersByWallet.get(input.walletAddress);
    if (!user) {
      throw new Error("Test session user was not found.");
    }
    this.sessions.set(input.tokenHash, { id: "session-" + this.sessions.size, tokenHash: input.tokenHash, user, expiresAt: input.expiresAt, revokedAt: null });
  }

  async findActiveSession(tokenHash: string, now: Date): Promise<AuthSessionRecord | null> {
    const session = this.sessions.get(tokenHash);
    return session && !session.revokedAt && session.expiresAt > now ? session : null;
  }

  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session && !session.revokedAt) {
      this.sessions.set(tokenHash, { ...session, revokedAt: now });
    }
  }

  async renameUser(input: { userId: string; displayName: string; displayNameKey: string; renamedAt: Date }): Promise<AuthenticatedUser> {
    const current = [...this.usersByWallet.values()].find((user) => user.userId === input.userId);
    if (!current) {
      throw new Error("Test user was not found.");
    }
    const renamed = { ...current, displayName: input.displayName, renamedAt: input.renamedAt };
    this.usersByWallet.set(renamed.walletAddress, renamed);
    return renamed;
  }

  async recordAuditEvent(): Promise<void> {
    // Tests intentionally use no persistence for audit writes.
  }
}
