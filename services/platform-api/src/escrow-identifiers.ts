import { createHash } from "node:crypto";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Domain-separated hash for opaque 32-byte escrow PDA seeds. Match and round
 * identifiers never cross the HTTP boundary as raw PDA seeds.
 */
export function hashEscrowIdentifier(kind: "match" | "round", identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new EscrowIdentifierError("IDENTIFIER_INVALID", "The " + kind + " identifier is invalid.");
  }
  return createHash("sha256")
    .update("blob-escrow-" + kind + "-id-v1\0", "utf8")
    .update(identifier, "utf8")
    .digest("hex");
}

export class EscrowIdentifierError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
