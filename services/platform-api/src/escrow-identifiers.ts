import { createHash } from "node:crypto";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Domain-separated hash for opaque 32-byte escrow PDA seeds and canonical
 * authority-attested death identifiers. Those values never cross an escrow
 * instruction as browser-controlled raw text.
 */
export function hashEscrowIdentifier(kind: "match" | "round" | "death", identifier: string): string {
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
