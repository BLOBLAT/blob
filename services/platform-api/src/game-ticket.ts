import * as ed25519 from "@noble/ed25519";
import { randomUUID } from "node:crypto";
import { validateDisplayName } from "@blob/validation";
import type { AuthenticatedUser } from "./auth-types.js";

export const GAME_TICKET_VERSION = 1;

export interface IssuedGameTicket {
  ticket: string;
  expiresAt: Date;
}

/** A legacy profile name that no longer satisfies the public-name policy. */
export class GameTicketDisplayNameError extends Error {}

/**
 * Creates a short-lived identity assertion for the authoritative arena. It
 * deliberately contains no wallet address, session token, or payment state.
 */
export async function issueGameTicket(input: {
  user: AuthenticatedUser;
  privateKey: Uint8Array;
  ttlMs: number;
  now?: Date;
}): Promise<IssuedGameTicket> {
  const validatedName = validateDisplayName(input.user.displayName);
  if (!validatedName.success) {
    throw new GameTicketDisplayNameError("Choose a compliant display name before entering the arena.");
  }
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + input.ttlMs);
  const payload = {
    v: GAME_TICKET_VERSION,
    sub: input.user.userId,
    name: validatedName.data.displayName,
    iat: now.getTime(),
    exp: expiresAt.getTime(),
    jti: randomUUID()
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = await ed25519.signAsync(new TextEncoder().encode(encodedPayload), input.privateKey);
  return {
    ticket: encodedPayload + "." + Buffer.from(signature).toString("base64url"),
    expiresAt
  };
}
