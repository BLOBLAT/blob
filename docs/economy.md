# BLOB economy domain

## Implemented

`packages/shared` defines the pure paid-match configuration and prize calculator. The default future configuration is:

| Setting | Value |
| --- | --- |
| Entry amount | `1_000_000n` USDC base units (1 USDC) |
| Platform fee | `500n` basis points (5%) |
| First place | `6000n` basis points (60%) |
| Second place | `2500n` basis points (25%) |
| Third place | `1500n` basis points (15%) |

Every amount is a `bigint` integer base-unit value. The calculator rejects invalid player counts, negative/invalid fees, duplicate placements, and distributions that do not total exactly 10,000 basis points.

Division remainders are assigned deterministically to first place. Returned payouts already include that remainder, so `platform fee + all payouts = gross pool` exactly.

## Not implemented

No player funds, balances, deposits, prize pools, transaction references, payouts, USDC transfers, wallet connection, or blockchain contracts exist in the application. The calculator is a domain primitive, not a claim that any payment occurred.
