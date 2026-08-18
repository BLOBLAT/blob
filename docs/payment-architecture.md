# Payment and settlement architecture

## Implemented domain boundary

`packages/shared` contains the explicit paid-match state machine:

```text
DRAFT → OPEN → FUNDING → READY → STARTING → LIVE → FINALIZING → SETTLED
                         ↘                     ↘
                       REFUNDING → REFUNDED
```

Invalid transitions throw. The package also defines, but does not implement:

- `EntryPaymentVerifier` for independently verified entry deposits;
- `PayoutSettlementGateway` for winner payouts;
- immutable-shaped entry payment, finalized result, and payout request records;
- unique idempotency keys on every deposit verification and payout request.

The game server is responsible only for producing a finalized authoritative match result. A future match/payment service must consume that record after gameplay; the game simulation must never sign a chain transaction or determine payment eligibility.

## Planned persistence and reconciliation

When paid mode begins, PostgreSQL and Prisma will add durable `Match`, `MatchPlayer`, `Payment`, and `Payout` records before any live-money integration. The database will record state transitions, source transaction references, result IDs, payout idempotency keys, reconciliation state, and explicit refund reasons.

Required future safeguards include duplicate callback protection, optimistic/concurrent transition guards, reconciliation jobs, timeout/cancellation flows, refund records, and immutable final rankings. No adapter should report a deposit or payout as successful until it is independently verified.

## Not implemented

There is no Solana integration, USDC transfer, wallet prompt, secret, key, seed phrase, webhook, database, or production payment flow in this repository.
