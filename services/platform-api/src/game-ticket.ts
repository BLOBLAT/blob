import * as ed25519 from "@noble/ed25519";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "./auth-types.js";

export const GAME_TICKET_VERSION = 1;

export interface IssuedGameTicket {
  ticket: string;
  expiresAt: Date;
}

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
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + input.ttlMs);
  const payload = {
    v: GAME_TICKET_VERSION,
    sub: input.user.userId,
    name: input.user.displayName,
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
