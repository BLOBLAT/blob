# BLOB economy domain

## Implemented

`packages/shared` defines the pure paid-match configuration and prize calculator. The default future configuration is:

| Setting | Value |
| --- | --- |
| Supported entry amounts | `100_000n` / `1_000_000n` / `5_000_000n` / `10_000_000n` USDC base units (0.10 / 1 / 5 / 10 USDC) |
| Default future entry amount | `1_000_000n` USDC base units (1 USDC) |
| Minimum paid players | 6 confirmed participants |
| Platform fee | `1000n` basis points (10% of all confirmed contributions) |
| Participation rebate | `1000n` basis points (10% of original entry for every final rank 4+) |
| First place | `5500n` basis points (55% of the remaining prize pool) |
| Second place | `3000n` basis points (30%) |
| Third place | `1500n` basis points (15%) |

Every amount is a `bigint` integer base-unit value. Persisted paid-match terms accept only the disclosed 0.10 / 1 / 5 / 10 USDC tiers and reject unsupported entry amounts, invalid player counts, negative/invalid fees, duplicate placements, and distributions that do not total exactly 10,000 basis points. The lowest tier is high enough to prevent required top-three prizes from rounding down to zero atomic USDC.

For `N` participants, original entry `E`, and confirmed revive contributions `R`, the intended accounting is:

```text
gross pool = N × E + R
platform fee = 10% × gross pool
rebate reserve = (N - 3) × (10% × E)
top-three gross prize pool = gross pool - platform fee - rebate reserve
payout delivery fee = disclosed percentage of each top-three gross prize
top-three net prizes = top-three gross prize pool - payout delivery fee
```

The rebate is a partial return of the original entry only: it does not include a revive payment and does not guarantee that a player avoids a net loss. Division remainders are assigned deterministically to first place, so `platform fee + participation-rebate reserve + payout-delivery fees + all net top-three prizes = gross pool` exactly. The future default delivery fee is zero and its maximum is 1% of each gross podium payout; it does not apply to rank-4-and-lower rebates. The native SOL network fee is separate and is paid by the transaction fee payer, not silently deducted by this calculation. For example, ten players entering at 10 USDC create a 100 USDC gross pool: 10 USDC platform fee, 7 × 1 USDC rebates, and an 83 USDC top-three gross pool split as 45.65 / 24.90 / 12.45 USDC before any disclosed delivery fee.

## Not implemented

No player funds, balances, accepted deposits, prize pools, confirmed
transactions, payouts, USDC transfers, or live paid matches exist. Wallet
sign-in/profile support and the isolated, non-deployed escrow-program source
exist elsewhere in the repository, but neither is a payment feature and
neither can accept, custody, or transfer USDC. The calculator is a domain
primitive, not a claim that any payment occurred.

The same package also defines typed MatchEntry, AuthoritativeMatchResult, SettlementRequest, and SettlementResult boundaries. A future payment or blockchain service may consume a finalized server result through those interfaces, but the game server does not transfer funds or hold private keys.
