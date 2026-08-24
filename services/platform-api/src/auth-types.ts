export interface AuthChallengeRecord {
  id: string;
  walletAddress: string;
  nonce: string;
  nonceHash: string;
  messageHash: string;
  expiresAt: Date;
  createdAt: Date;
  consumedAt: Date | null;
}

export interface AuthenticatedUser {
  userId: string;
  displayName: string;
  walletAddress: string;
  renamedAt: Date | null;
}

export interface AuthSessionRecord {
  id: string;
  tokenHash: string;
  user: AuthenticatedUser;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** Raised by a durable repository when another account already owns a
 * canonical display name. Keeping this domain error independent of Prisma
 * lets the authentication service return the same safe response in every
 * storage implementation. */
export class DisplayNameConflictError extends Error {}

export interface PlatformAuthRepository {
  createChallenge(challenge: AuthChallengeRecord): Promise<void>;
  findActiveChallenge(challengeId: string, now: Date): Promise<AuthChallengeRecord | null>;
  consumeChallenge(challengeId: string, now: Date): Promise<boolean>;
  findOrCreateUserWithWallet(input: { displayName: string; displayNameKey: string; walletAddress: string; now: Date }): Promise<{ user: AuthenticatedUser; created: boolean }>;
  createSession(input: { tokenHash: string; userId: string; walletAddress: string; expiresAt: Date }): Promise<void>;
  findActiveSession(tokenHash: string, now: Date): Promise<AuthSessionRecord | null>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
  renameUser(input: { userId: string; displayName: string; displayNameKey: string; renamedAt: Date }): Promise<AuthenticatedUser>;
  recordAuditEvent(input: { userId: string | null; action: string; entityType: string; entityId: string; metadata?: Record<string, string | number | boolean> }): Promise<void>;
}

export interface IssuedAuthChallenge {
  challengeId: string;
  message: string;
  expiresAt: Date;
}

export interface VerifiedAuthSession {
  token: string;
  expiresAt: Date;
  user: AuthenticatedUser;
}
