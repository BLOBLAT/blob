# Payment and settlement architecture

## Implemented domain boundary

`packages/shared` contains the explicit paid-match state machine:

```text
DRAFT → OPEN → FUNDING → READY → STARTING → LIVE → FINALIZING → SETTLED
                 ↘          ↘           ↘
                       REFUNDING → REFUNDED
```

Invalid transitions throw. A refund is allowed only before a paid round becomes
`LIVE`; it cannot replace a live or finalizing round's result. The package also
defines, but does not implement:

- `EntryPaymentVerifier` for independently verified entry deposits;
- `PayoutSettlementGateway` for winner payouts;
- immutable-shaped entry payment, finalized result, and payout request records;
- unique idempotency keys on every deposit verification and payout request.

The game server is responsible only for producing a finalized authoritative match result. A future match/payment service must consume that record after gameplay; the game simulation must never sign a chain transaction or determine payment eligibility.

## Planned persistence and reconciliation

When paid mode begins, PostgreSQL and Prisma will add durable `Match`, `MatchPlayer`, `Payment`, and `Payout` records before any live-money integration. The database will record state transitions, source transaction references, result IDs, payout idempotency keys, reconciliation state, and explicit refund reasons.

Required future safeguards include duplicate callback protection, optimistic/concurrent transition guards, reconciliation jobs, timeout/cancellation flows, refund records, and immutable final rankings. No adapter should report a deposit or payout as successful until it is independently verified.

## Current implementation boundary

`services/platform-api` now contains a deployable PostgreSQL schema, an
off-chain Solana wallet-signature login/profile flow, native-USDC integer
accounting, a disclosed Rebuy Arena policy, immutable paid-result planning,
and an adapter that independently parses finalized exact SPL
`transferChecked` deposits through an HTTPS Solana RPC endpoint.

It does **not** contain an escrow program, a private key, a seed phrase, a
custodial wallet, a production database, an enabled paid-match route, or a
mechanism to sign/send USDC transfers. A browser's payment signature remains
untrusted until the platform service verifies finality, exact mint,
destination, signer, and amount, then records it with an idempotency key.

See [paid-mode.md](paid-mode.md) for the explicit enabling gates.
