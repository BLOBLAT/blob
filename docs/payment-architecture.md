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

## Persistence and reconciliation boundary

`services/platform-api` already owns a reviewed PostgreSQL/Prisma schema and
the deployed database has the baseline migration applied. That schema reserves
durable records for matches, entries, revive requests, chain transactions,
settlement attempts, payouts, and audit events. The public API deliberately
does **not** expose paid-match, entry, revive, or payout routes yet, so this
storage cannot accept or move player funds.

Before any live-money route is enabled, paid state transitions must use those
records with source transaction references, result IDs, payout idempotency
keys, reconciliation state, and explicit refund reasons. Required safeguards
include duplicate callback protection, optimistic/concurrent transition guards,
reconciliation jobs, timeout/cancellation flows, refund records, and immutable
final rankings. No adapter should report a deposit or payout as successful
until it is independently verified.

## Current implementation boundary

`services/platform-api` now contains a deployable PostgreSQL schema, an
off-chain Solana wallet-signature login/profile flow, native-USDC integer
accounting, a disclosed Rebuy Arena policy, immutable paid-result planning,
and an adapter that independently parses finalized exact SPL
`transferChecked` deposits through an HTTPS Solana RPC endpoint.

The Platform API does **not** embed, run, or deploy the separate escrow
program. It also has no private key, seed phrase, custodial wallet, enabled
paid-match route, or mechanism to sign/send USDC transfers. Its deployed
PostgreSQL database currently serves only the safe profile/authentication
foundation and inactive durable schema. A browser's payment signature remains
untrusted until the platform service verifies finality, exact mint,
destination, signer, and amount, then records it with an idempotency key.

See [paid-mode.md](paid-mode.md) for the explicit enabling gates.
