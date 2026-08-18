import { createHash, randomBytes } from "node:crypto";

export function createOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

export function decodeBase64(value: string, expectedLength: number): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== expectedLength) {
    return null;
  }
  return new Uint8Array(decoded);
}
