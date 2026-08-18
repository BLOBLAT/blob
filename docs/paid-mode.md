# Paid Mode foundation

Paid Mode is not exposed in the public BLOB interface and does not accept
funds yet. This document describes the implemented boundary and the conditions
required before it can be enabled.

## Rules fixed in code

- Asset: native USDC on Solana, six decimal base units.
- Standard **Skill** match: no paid revive.
- **Rebuy Arena**: a separately disclosed ruleset, one 0.50 USDC revive per
  player; it is available for 30 seconds after an authoritative death and
  closes for the final 60 seconds of the round.
- The final gross pool is confirmed entries plus confirmed revives.
- Platform fee is exactly 5% of that final pool.
- The remaining 95% is paid by a configuration-driven 60/30/10 default split.
- All arithmetic uses `bigint` atomic USDC units and basis points; no float is
  used for money.

`services/platform-api/src/paid-match.ts` verifies the immutable rules,
participant set, authoritative final ranking, final pool, and payout plan.
It produces an idempotent settlement request; it cannot transfer tokens.

`services/platform-api/src/solana-payment-verifier.ts` independently checks a
finalized Solana JSON-RPC `transferChecked` instruction for the exact signer,
mint, escrow token account, and base-unit amount. A browser-submitted
signature is therefore only a claim until this verification passes and its
unique signature is durably recorded.

## Authority flow

```text
Wallet -> signed BLOB login message -> platform API session
Wallet -> user-approved USDC transaction -> Solana finality verification
Verified entry -> paid-match admission token -> authoritative game server
Authoritative result -> immutable result hash -> settlement request
Audited escrow program / multisig -> fee + winner payout transactions
```

The browser cannot choose a match result, rank, entry confirmation, revive
permit, pool, fee, or payout. The game server cannot hold keys or initiate a
chain transfer. A revive permit may be issued only after both an authoritative
death event and a verified payment, and it must be consumed by the room once.

The platform API signs a short-lived, HMAC-protected admission ticket only
after the entry is durably verified. A future paid room verifies its match ID,
round ID, expiration, and signature with the server-to-server
`PLATFORM_GAME_SERVER_SHARED_SECRET`; it must also mark the underlying entry
as consumed. The ticket neither grants payment credit nor changes combat or
ranking authority.

## Required before enabling paid play

1. Provision PostgreSQL for `services/platform-api` and apply the reviewed
   baseline Prisma migration in
   `services/platform-api/prisma/migrations/20260819000000_init` with
   `npm run prisma:migrate:deploy --workspace=@blob/platform-api`.
2. Deploy the platform API as a separate persistent service with an HTTPS
   origin, `DATABASE_URL`, `PLATFORM_PUBLIC_ORIGIN`, and the exact
   comma-separated `PLATFORM_WEB_ORIGIN` allowlist.
3. Configure `VITE_PLATFORM_API_URL` in Vercel and redeploy the web client.
4. Decide and configure the production Solana RPC endpoint, native USDC mint,
   audited escrow program ID, escrow derivation, treasury, and multisig
   signers. These are intentionally not committed.
5. Implement and test the Anchor escrow program on devnet, then complete an
   independent security audit, operational incident/reconciliation procedure,
   and applicable legal review before any mainnet USDC is accepted.

Do not enable paid entry, revive, or payouts merely because a wallet can sign
in. Wallet login is proof of address control, not payment authorization.
