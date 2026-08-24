# BLOB economy domain

## Implemented

`packages/shared` defines the pure paid-match configuration and prize calculator. The default future configuration is:

| Setting | Value |
| --- | --- |
| Entry amount | `1_000_000n` USDC base units (1 USDC) |
| Minimum entry amount | `10_000n` USDC base units (0.01 USDC) |
| Platform fee | `500n` basis points (5%) |
| First place | `6000n` basis points (60%) |
| Second place | `3000n` basis points (30%) |
| Third place | `1000n` basis points (10%) |

Every amount is a `bigint` integer base-unit value. Persisted paid-match terms reject entry fees below 0.01 USDC, invalid player counts, negative/invalid fees, duplicate placements, and distributions that do not total exactly 10,000 basis points. The minimum prevents integer rounding from creating a zero atomic payout for a required top-three place.

Division remainders are assigned deterministically to first place. Returned payouts already include that remainder, so `platform fee + all payouts = gross pool` exactly.

## Not implemented

No player funds, balances, accepted deposits, prize pools, confirmed
transactions, payouts, USDC transfers, or live paid matches exist. Wallet
sign-in/profile support and the isolated, non-deployed escrow-program source
exist elsewhere in the repository, but neither is a payment feature and
neither can accept, custody, or transfer USDC. The calculator is a domain
primitive, not a claim that any payment occurred.

The same package also defines typed MatchEntry, AuthoritativeMatchResult, SettlementRequest, and SettlementResult boundaries. A future payment or blockchain service may consume a finalized server result through those interfaces, but the game server does not transfer funds or hold private keys.
