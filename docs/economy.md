# BLOB economy domain

## Implemented

`packages/shared` defines the pure paid-match configuration and prize calculator. The default future configuration is:

| Setting | Value |
| --- | --- |
| Entry amount | `1_000_000n` USDC base units (1 USDC) |
| Minimum entry amount | `10_000n` USDC base units (0.01 USDC) |
| Minimum paid players | 6 confirmed participants |
| Platform fee | `1000n` basis points (10% of all confirmed contributions) |
| Participation rebate | `1000n` basis points (10% of original entry for every final rank 4+) |
| First place | `5500n` basis points (55% of the remaining prize pool) |
| Second place | `3000n` basis points (30%) |
| Third place | `1500n` basis points (15%) |

Every amount is a `bigint` integer base-unit value. Persisted paid-match terms reject entry fees below 0.01 USDC, invalid player counts, negative/invalid fees, duplicate placements, and distributions that do not total exactly 10,000 basis points. The minimum prevents integer rounding from creating a zero atomic payout for a required top-three place.

For `N` participants, original entry `E`, and confirmed revive contributions `R`, the intended accounting is:

```text
gross pool = N × E + R
platform fee = 10% × gross pool
rebate reserve = (N - 3) × (10% × E)
top-three prize pool = gross pool - platform fee - rebate reserve
```

The rebate is a partial return of the original entry only: it does not include a revive payment and does not guarantee that a player avoids a net loss. Division remainders are assigned deterministically to first place, so `platform fee + participation-rebate reserve + all top-three prizes = gross pool` exactly. For example, ten players entering at 10 USDC create a 100 USDC gross pool: 10 USDC fee, 7 × 1 USDC rebates, and an 83 USDC top-three pool split as 45.65 / 24.90 / 12.45 USDC.

## Not implemented

No player funds, balances, accepted deposits, prize pools, confirmed
transactions, payouts, USDC transfers, or live paid matches exist. Wallet
sign-in/profile support and the isolated, non-deployed escrow-program source
exist elsewhere in the repository, but neither is a payment feature and
neither can accept, custody, or transfer USDC. The calculator is a domain
primitive, not a claim that any payment occurred.

The same package also defines typed MatchEntry, AuthoritativeMatchResult, SettlementRequest, and SettlementResult boundaries. A future payment or blockchain service may consume a finalized server result through those interfaces, but the game server does not transfer funds or hold private keys.
