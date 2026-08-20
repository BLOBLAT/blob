import * as ed25519 from "@noble/ed25519";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { ProfileTicketVerifier } from "./profileIdentity.js";

const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);

describe("profile identity ticket verification", () => {
  it("accepts only a valid, current signed profile assertion", async () => {
    const privateKey = ed25519.utils.randomSecretKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const verifier = ProfileTicketVerifier.fromBase58(base58.encode(publicKey));
    const ticket = await signTicket(privateKey, {
      v: 1,
      sub: "user-7",
      name: "Blob Prime",
      iat: NOW,
      exp: NOW + 60_000
    });

    await expect(verifier.resolve("session-one", { name: "Forged Name", profileTicket: ticket }, NOW))
      .resolves.toEqual({ name: "Blob Prime", profileUserId: "user-7" });
  });

  it("falls back to a server-assigned anonymous name for forged or expired tickets", async () => {
    const privateKey = ed25519.utils.randomSecretKey();
    const verifier = ProfileTicketVerifier.fromBase58(base58.encode(await ed25519.getPublicKeyAsync(privateKey)));
    const expiredTicket = await signTicket(privateKey, {
      v: 1,
      sub: "user-7",
      name: "Blob Prime",
      iat: NOW - 61_000,
      exp: NOW - 1
    });
    const identity = await verifier.resolve("session-two", { name: "Pretending", profileTicket: expiredTicket }, NOW);
    expect(identity.profileUserId).toBeUndefined();
    expect(identity.name).toMatch(/^BLOB-[A-Z0-9]+$/);
  });
});

async function signTicket(privateKey: Uint8Array, payload: object): Promise<string> {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = await ed25519.signAsync(new TextEncoder().encode(encoded), privateKey);
  return encoded + "." + Buffer.from(signature).toString("base64url");
}
