import * as ed25519 from "@noble/ed25519";
import { base58 } from "@scure/base";
import { createOpaqueToken, decodeBase64, sha256 } from "./security.js";
import type {
  AuthenticatedUser,
  IssuedAuthChallenge,
  PlatformAuthRepository,
  VerifiedAuthSession
} from "./auth-types.js";

export const DISPLAY_NAME_PATTERN = /^[A-Za-z0-9 _-]{3,16}$/;

export interface AuthServiceOptions {
  publicOrigin: string;
  challengeTtlMs: number;
  sessionTtlMs: number;
  renameCooldownMs: number;
}

export class AuthService {
  constructor(
    private readonly repository: PlatformAuthRepository,
    private readonly options: AuthServiceOptions
  ) {}

  async issueChallenge(walletAddress: string, now = new Date()): Promise<IssuedAuthChallenge> {
    assertWalletAddress(walletAddress);
    const challengeId = createOpaqueToken(24);
    const nonce = createOpaqueToken(24);
    const expiresAt = new Date(now.getTime() + this.options.challengeTtlMs);
    const message = createSiwsMessage({
      publicOrigin: this.options.publicOrigin,
      walletAddress,
      nonce,
      issuedAt: now,
      expiresAt
    });
    await this.repository.createChallenge({
      id: challengeId,
      walletAddress,
      nonce,
      nonceHash: sha256(nonce),
      messageHash: sha256(message),
      expiresAt,
      createdAt: now,
      consumedAt: null
    });
    return { challengeId, message, expiresAt };
  }

  async verifyChallenge(input: {
    challengeId: string;
    walletAddress: string;
    signatureBase64: string;
  }, now = new Date()): Promise<VerifiedAuthSession> {
    assertWalletAddress(input.walletAddress);
    const challenge = await this.repository.findActiveChallenge(input.challengeId, now);
    if (!challenge || challenge.walletAddress !== input.walletAddress) {
      throw new AuthError("AUTH_CHALLENGE_INVALID", "The sign-in request is invalid or expired.");
    }
    if (sha256(challenge.nonce) !== challenge.nonceHash) {
      throw new AuthError("AUTH_CHALLENGE_INVALID", "The sign-in request is invalid or expired.");
    }
    const message = createSiwsMessage({
      publicOrigin: this.options.publicOrigin,
      walletAddress: challenge.walletAddress,
      nonce: challenge.nonce,
      issuedAt: challenge.createdAt,
      expiresAt: challenge.expiresAt
    });
    if (sha256(message) !== challenge.messageHash) {
      throw new AuthError("AUTH_CHALLENGE_INVALID", "The sign-in request is invalid or expired.");
    }
    const signature = decodeBase64(input.signatureBase64, 64);
    if (!signature) {
      throw new AuthError("AUTH_SIGNATURE_INVALID", "The wallet signature is invalid.");
    }
    const verified = await ed25519.verifyAsync(signature, new TextEncoder().encode(message), base58.decode(challenge.walletAddress));
    if (!verified) {
      throw new AuthError("AUTH_SIGNATURE_INVALID", "The wallet signature is invalid.");
    }
    if (!await this.repository.consumeChallenge(challenge.id, now)) {
      throw new AuthError("AUTH_CHALLENGE_USED", "The sign-in request has already been used.");
    }

    const displayName = createDefaultDisplayName(challenge.walletAddress);
    const createdUser = await this.repository.findOrCreateUserWithWallet({
      displayName,
      displayNameKey: canonicalizeDisplayName(displayName),
      walletAddress: challenge.walletAddress,
      now
    });
    const user = createdUser.user;
    if (createdUser.created) {
      await this.repository.recordAuditEvent({
        userId: user.userId,
        action: "wallet_linked",
        entityType: "wallet",
        entityId: challenge.walletAddress
      });
    }

    const token = createOpaqueToken(32);
    const expiresAt = new Date(now.getTime() + this.options.sessionTtlMs);
    await this.repository.createSession({ tokenHash: sha256(token), userId: user.userId, walletAddress: user.walletAddress, expiresAt });
    await this.repository.recordAuditEvent({
      userId: user.userId,
      action: "session_created",
      entityType: "session",
      entityId: sha256(token)
    });
    return { token, expiresAt, user };
  }

  async getSession(token: string | undefined, now = new Date()): Promise<AuthenticatedUser | null> {
    if (!token || token.length < 32) {
      return null;
    }
    const session = await this.repository.findActiveSession(sha256(token), now);
    return session?.user ?? null;
  }

  async logout(token: string | undefined, now = new Date()): Promise<void> {
    if (!token || token.length < 32) {
      return;
    }
    await this.repository.revokeSession(sha256(token), now);
  }

  async rename(user: AuthenticatedUser, displayName: string, now = new Date()): Promise<AuthenticatedUser> {
    assertDisplayName(displayName);
    const normalizedDisplayName = displayName.trim();
    const displayNameKey = canonicalizeDisplayName(normalizedDisplayName);
    if (displayNameKey === canonicalizeDisplayName(user.displayName)) {
      return user;
    }
    if (user.renamedAt && now.getTime() - user.renamedAt.getTime() < this.options.renameCooldownMs) {
      throw new AuthError("PROFILE_RENAME_RATE_LIMITED", "Display name can only be changed once per day.");
    }
    const renamed = await this.repository.renameUser({
      userId: user.userId,
      displayName: normalizedDisplayName,
      displayNameKey,
      renamedAt: now
    });
    await this.repository.recordAuditEvent({
      userId: user.userId,
      action: "profile_renamed",
      entityType: "user",
      entityId: user.userId
    });
    return renamed;
  }
}

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function createSiwsMessage(input: {
  publicOrigin: string;
  walletAddress: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  const host = new URL(input.publicOrigin).host;
  return host
    + " wants you to sign in with your Solana account:\n"
    + input.walletAddress
    + "\n\nSign in to BLOB. This request does not approve a transaction or transfer funds.\n\n"
    + "URI: " + input.publicOrigin
    + "\nVersion: 1"
    + "\nChain ID: solana:mainnet"
    + "\nNonce: " + input.nonce
    + "\nIssued At: " + input.issuedAt.toISOString()
    + "\nExpiration Time: " + input.expiresAt.toISOString();
}

export function assertWalletAddress(walletAddress: string): void {
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(walletAddress);
  } catch {
    throw new AuthError("WALLET_ADDRESS_INVALID", "The wallet address is invalid.");
  }
  if (decoded.length !== 32) {
    throw new AuthError("WALLET_ADDRESS_INVALID", "The wallet address is invalid.");
  }
}

export function assertDisplayName(displayName: string): void {
  if (!DISPLAY_NAME_PATTERN.test(displayName.trim())) {
    throw new AuthError("DISPLAY_NAME_INVALID", "Display name must use 3-16 letters, numbers, spaces, underscores, or hyphens.");
  }
}

export function canonicalizeDisplayName(displayName: string): string {
  return displayName.trim().replace(/\s+/g, " ").toLocaleUpperCase("en-US");
}

function createDefaultDisplayName(walletAddress: string): string {
  return "BLOB-" + walletAddress.slice(-5).toUpperCase();
}
