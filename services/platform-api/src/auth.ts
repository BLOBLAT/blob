import * as ed25519 from "@noble/ed25519";
import { base58 } from "@scure/base";
import {
  canonicalizeDisplayName as canonicalizeProfileDisplayName,
  validateDisplayName
} from "@blob/validation";
import { createOpaqueToken, decodeBase64, sha256 } from "./security.js";
import { DisplayNameConflictError } from "./auth-types.js";
import type {
  AuthenticatedUser,
  IssuedAuthChallenge,
  PlatformAuthRepository,
  VerifiedAuthSession
} from "./auth-types.js";

export { DISPLAY_NAME_PATTERN } from "@blob/validation";

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

    const createdUser = await this.findOrCreateWalletUser(challenge.walletAddress, now);
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
    const validatedName = validateDisplayName(displayName);
    if (!validatedName.success) {
      throw new AuthError(
        validatedName.code,
        validatedName.code === "DISPLAY_NAME_RESERVED"
          ? "That display name is reserved."
          : "Display name must use 3-16 letters, numbers, spaces, underscores, or hyphens."
      );
    }
    const { displayName: normalizedDisplayName, displayNameKey } = validatedName.data;
    if (displayNameKey === canonicalizeDisplayName(user.displayName)) {
      return user;
    }
    if (user.renamedAt && now.getTime() - user.renamedAt.getTime() < this.options.renameCooldownMs) {
      throw new AuthError("PROFILE_RENAME_RATE_LIMITED", "Display name can only be changed once per day.");
    }
    let renamed: AuthenticatedUser;
    try {
      renamed = await this.repository.renameUser({
        userId: user.userId,
        displayName: normalizedDisplayName,
        displayNameKey,
        renamedAt: now
      });
    } catch (error) {
      if (error instanceof DisplayNameConflictError) {
        throw new AuthError("PROFILE_NAME_UNAVAILABLE", "That display name is already in use.");
      }
      throw error;
    }
    await this.repository.recordAuditEvent({
      userId: user.userId,
      action: "profile_renamed",
      entityType: "user",
      entityId: user.userId
    });
    return renamed;
  }

  private async findOrCreateWalletUser(walletAddress: string, now: Date): Promise<{ user: AuthenticatedUser; created: boolean }> {
    let displayName = createDefaultDisplayName(walletAddress);
    // A default name is privacy-preserving and has more than enough entropy
    // for normal use. Retrying a database conflict still makes the invariant
    // absolute under a deliberately generated hash collision or concurrent
    // account creation.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.repository.findOrCreateUserWithWallet({
          displayName,
          displayNameKey: canonicalizeDisplayName(displayName),
          walletAddress,
          now
        });
      } catch (error) {
        if (!(error instanceof DisplayNameConflictError) || attempt === 3) {
          throw error;
        }
        displayName = createFallbackDisplayName();
      }
    }
    throw new AuthError("PROFILE_NAME_UNAVAILABLE", "A unique display name could not be assigned.");
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
  const validatedName = validateDisplayName(displayName);
  if (!validatedName.success) {
    throw new AuthError(
      validatedName.code,
      validatedName.code === "DISPLAY_NAME_RESERVED"
        ? "That display name is reserved."
        : "Display name must use 3-16 letters, numbers, spaces, underscores, or hyphens."
    );
  }
}

export function canonicalizeDisplayName(displayName: string): string {
  return canonicalizeProfileDisplayName(displayName);
}

function createDefaultDisplayName(walletAddress: string): string {
  // Do not derive the public arena name from an easily visible wallet suffix.
  // Eleven hexadecimal digest characters fit the 16-character profile limit
  // and make accidental collisions exceptionally unlikely before the durable
  // uniqueness constraint provides the final guarantee.
  return "BLOB-" + sha256(walletAddress).slice(0, 11).toUpperCase();
}

function createFallbackDisplayName(): string {
  return "BLOB-" + createOpaqueToken(12).slice(0, 11).toUpperCase();
}
