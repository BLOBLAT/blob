import * as ed25519 from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import { issueGameTicket } from "./game-ticket.js";

describe("game identity tickets", () => {
  it("signs a short-lived assertion that excludes wallet and session credentials", async () => {
    const privateKey = ed25519.utils.randomSecretKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const issued = await issueGameTicket({
      user: {
        userId: "user-42",
        displayName: "Blob Prime",
        walletAddress: "wallet-address-must-not-appear",
        renamedAt: null
      },
      privateKey,
      ttlMs: 60_000,
      now: new Date("2026-08-20T12:00:00.000Z")
    });
    const [payload, signature] = issued.ticket.split(".");
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();
    expect(Buffer.from(payload!, "base64url").toString("utf8")).toBe(JSON.stringify({
      v: 1,
      sub: "user-42",
      name: "Blob Prime",
      iat: Date.UTC(2026, 7, 20, 12, 0, 0),
      exp: Date.UTC(2026, 7, 20, 12, 1, 0)
    }));
    expect(await ed25519.verifyAsync(
      Buffer.from(signature!, "base64url"),
      new TextEncoder().encode(payload!),
      publicKey
    )).toBe(true);
  });
});
