# Paid Mode foundation

Paid Mode is not open for entry and does not accept funds. The public site has
a deliberately password-gated **USDC Mode private preview** so the wallet
profile and the intended competitive rules can be reviewed without presenting
a transfer, pool, entry, revive, or payout action. Its browser-only gate is
not authentication and must never be treated as a security boundary.

The preview clearly states that entries are disabled. It may link to the
Terms & Risk Disclosure and collect a browser-only preview acknowledgement,
but that is not a paid-match acceptance record. Any future paid entry must
collect and durably record a separate, time-stamped acceptance of the final
rules before it requests a transaction.

## Rules fixed in code

- Asset: native USDC on Solana, six decimal base units.
- Entry amount: exactly one immutable native-USDC tier per match: **0.10, 1,
  5, or 10 USDC**. Different tiers never share a pool, and the browser cannot
  supply an arbitrary amount.
- A paid arena needs at least six confirmed participants.
- Standard **Skill** match: no paid revive.
- **Rebuy Arena**: a separately disclosed ruleset, one 0.50 USDC revive per
  player; it is available for 30 seconds after an authoritative death and
  closes when three minutes or less remain in the round.
- The final gross pool is confirmed entries plus confirmed revives.
- Platform fee is exactly 10% of that final pool.
- Each verified rank 4 and lower can claim a 10% partial rebate of the
  original entry; revives do not increase that rebate.
- After reserving those rebates, the top-three prize pool uses a
  configuration-driven 55/30/15 default split.
- A separately disclosed **payout delivery fee** may be deducted only from the
  gross podium prizes. It is an immutable match term, defaults to **0%**, and
  is capped at 1%; it is tracked as a separate amount and is not part of the
  fixed 10% platform fee. Participation rebates are never charged this fee.
- Solana network transaction fees are denominated in SOL and are separate from
  every USDC pool calculation. Users must see the exact wallet transaction
  before signing; BLOB never asks for a seed phrase or private key.
- All arithmetic uses `bigint` atomic USDC units and basis points; no float is
  used for money.
- Before any terms can be persisted, the platform domain rejects values that
  the escrow program would reject: exactly three positive payout places
  (1/2/3) totaling 10,000 basis points, the fixed 10% fee and 10% participation
  rebate, six to 32 players,
  the current ten-minute round, and a funding deadline no later than that
  term's immutable funding window (which itself is capped at 15 minutes).
- A Standard Skill policy is represented by canonical zero Rebuy fields. A
  Rebuy Arena policy is exactly one 0.50 USDC revive, a 30-second death window,
  and a final-three-minute cutoff. This prevents a late on-chain configuration
  failure after an entry has been accepted.

`services/platform-api/src/paid-match.ts` verifies the immutable rules,
participant set, authoritative final ranking, final pool, and payout plan.
It produces an idempotent settlement request; it cannot transfer tokens.

## Implemented escrow-program boundary

`programs/blob-escrow` is a separate Anchor 0.32.1 program source. It is
outside the npm workspaces and is not imported by Free Mode, the browser, or
the Colyseus server. Its currently committed program ID is intentionally the
non-deployable all-zero system address; no program has been deployed.

The program's one-time `PlatformConfig` PDA is initialized by a governance
authority and fixes a six-decimal legacy SPL native-USDC mint, future-match controller,
independent result authority, and treasury owner. Each newly created escrow
copies all four public keys along with immutable match ID hash, round ID hash,
rules hash, fee, payout, and Rebuy configuration. Changing future platform
roles cannot change an existing escrow. The governance authority and all three
operational public keys are ineligible to enter the match, so neither a
governance key, controller, result-attestation authority, nor fee-recipient
owner can appear in the funded player or winner roster.

The implemented instructions are deliberately narrow:

- `enter_match` creates one PDA entry per wallet and transfers exactly the
  immutable entry amount to the match PDA's native-USDC token account, but
  rejects every contribution at or after the immutable funding deadline.
- `start_match` is controller-only and records the authoritative on-chain
  round end timestamp after the configured minimum funded count is reached,
  but only before its immutable 15-minute maximum funding deadline.
- `expire_funding` is permissionless after the recorded funding deadline. It
  moves a never-started match to per-player refunds, so an unavailable
  controller cannot leave pre-game USDC locked indefinitely.
- `purchase_revive` needs both the player and result-authority signatures,
  records an unreusable authoritative death hash, accepts exactly one 0.50
  USDC contribution only for a disclosed Rebuy match, and enforces that the
  death occurred inside that escrow's live round, the 30-second death window,
  and final-three-minute cutoff.
- `settle_match` requires the independent result authority after the round
  ends, accepts only three distinct enrolled winners, records a non-empty
  immutable final-result hash, and derives the 10% fee, rank-4-and-lower 10%
  entry-rebate reserve, gross top-three split, any separately disclosed
  podium-only delivery fee, and net winner payouts from immutable match rules
  (55/30/15 is the current default).
- `claim_participation_rebate` is a post-settlement pull claim for an enrolled
  non-podium player. It cannot pay a podium entry or exceed the reserve fixed
  from participant count and original entries.
- `cancel_match` and `claim_refund` support controller-initiated, per-player
  exact contribution refunds only while the match is still funding. An active
  match cannot be cancelled into a blanket refund: after start it must settle
  through the result-authority path. No browser can redirect a refund or
  payout to a different token-account owner.

The result authority is an oracle boundary, not the game server. Production
must use governance-controlled, auditable signing (for example a multisig or
restricted signing service) and bind it to the server's immutable result.
The game server must never receive a private key.

`services/platform-api/src/solana-payment-verifier.ts` independently checks a
finalized Solana JSON-RPC `transferChecked` instruction for the exact signer,
source token-account owner, mint, escrow token account, and base-unit amount.
The source account must be reported as owned by the signer in finalized token
balance metadata; delegated or unproven source accounts fail closed. A browser-submitted
signature is therefore only a claim until this verification passes and its
unique signature is durably recorded. Before it calls RPC, the verifier
Base58-decodes public keys to exactly 32 bytes and transaction signatures to
exactly 64 bytes; strings that merely resemble Solana references are rejected.
It uses the finalized transaction's chain `blockTime`, never API wall-clock
time, for funding-deadline decisions and rejects a transaction without a valid
block time.

The internal `PrismaPaidEntryPaymentRepository` atomically records that
verified receipt with the exact reserved entry. It permits funding only while
the match is in `FUNDING` and the finalized chain time precedes the immutable
deadline; the unique Solana signature and unique entry-to-transaction relation
make both duplicate and cross-entry reuse fail closed. It has no browser or
HTTP route, and does not submit transfers. As a second boundary check before
opening its database transaction, it Base58-decodes the supplied wallet and
signature to their exact Solana byte lengths; an internal caller cannot turn a
placeholder string into a durable payment receipt.

Before a transfer is verified, `PrismaPaidEntryReservationRepository` creates
that exact `RESERVED` entry in a serializable transaction. Its internal caller
supplies authenticated Platform API user/wallet IDs, not browser-selected
identities; the repository proves wallet ownership, enforces the immutable
entry amount and match capacity, rejects the funding deadline, and permits an
idempotent retry only when every binding matches. This creates no payment route
and does not build, sign, or submit a wallet transaction.

Before that funding stage, the internal `PrismaPaidMatchTermsRepository`
persists the server-created immutable match terms as `DRAFT`; an exact retry
reuses that record, while a divergent rules hash or any differing immutable
term fails closed. A future controlled orchestration service may move the
record through the defined paid lifecycle, but no browser can create terms or
select a mint, escrow, fee, or payout split.

`PrismaPaidMatchLifecycleRepository` is the corresponding internal
transactional transition boundary. It applies only the shared state-machine
edges, records each transition in the audit log, and uses a compare-and-set
write with one serializable-conflict retry so concurrent callers cannot both
advance a match. It requires the
complete verified roster before `READY`, then requires every funded entry to
consume a one-time admission ticket before `LIVE`; `startsAt` is fixed from
server time in that final transition. It rejects funding-expired starts and
cannot create a `LIVE -> REFUNDING` path. It has no browser or public API
route.

## Authority flow

```text
Wallet -> signed BLOB login message -> platform API session
Wallet -> user-approved USDC transaction -> Solana finality verification
Verified entry -> paid-match admission token -> authoritative game server
Authoritative result -> immutable result hash -> settlement request
Audited escrow program / multisig -> fixed fee + disclosed delivery fee + net winner payouts
```

The browser cannot choose a match result, rank, entry confirmation, revive
permit, pool, fee, or payout. The game server cannot hold keys or initiate a
chain transfer. A revive permit may be issued only after both an authoritative
death event and a verified payment, and it must be consumed by the room once.

The shared arena simulation also rejects `PAID` configuration unless the
orchestrator supplies distinct, bounded server-created `matchId` and `roundId`
values before the countdown. Those exact values must be the values persisted
in immutable terms and bound into admission tickets. Once that Paid simulation
has finalized its result, it will not start another round under the same terms.
This prevents a future Paid Room from falling back to client-selected or
per-countdown generated identifiers; Free Mode retains its independent
server-generated lifecycle.

The platform API signs a short-lived Ed25519 admission ticket only after the
entry is durably verified. The issuer and verifier require bounded internal
IDs, an exact SHA-256 rules hash, a UUID nonce, and a 10-second-to-five-minute
issued/expiry window. Its private signing key remains in the Platform API; a
future paid room receives only the matching public verification key, verifies
those claims plus match ID/round ID/signature, and marks the underlying entry
as consumed. It carries internal entry/player identifiers but no wallet
address. The ticket neither grants payment credit nor changes combat or ranking
authority.

The future paid-admission signer is configured separately as
`PLATFORM_PAID_ADMISSION_TICKET_PRIVATE_KEY_BASE64`. It must be a different
32-byte Ed25519 key from `PLATFORM_GAME_TICKET_PRIVATE_KEY_BASE64`, which is
reserved for Free Mode display-name tickets. No HMAC shared secret is used or
accepted for paid admission, and setting this future key alone does not expose
Paid Mode. The Platform API rejects a configuration that reuses the
profile-ticket key.

`@blob/paid-match-runtime` is a server-only building block for the future
isolated Paid Room. It can admit a transport session only after the existing
backend-only admission consumer has verified and atomically consumed that
entry's ticket. It maps the session to the internal player ID, uses the shared
simulation with the exact immutable match/round IDs, excludes bots, disables
automatic respawn, and emits only a wallet-free authoritative result. It
rejects Free-like limits or a non-ten-minute round. It has no listener,
browser entrypoint, Railway service, wallet key, or enabled release path.
`PaidArenaTransportAdapter` exposes only ticket-gated join, bounded intent,
authoritative ticks, and a private idempotent result-sink handoff; a future
Colyseus room may adapt that interface without receiving payment authority.

`PrismaPaidAdmissionRepository` stores only a SHA-256 hash of each issued
ticket, its server-controlled issue/expiry time, and the terminal consumed
entry state. A live ticket cannot be issued twice; only an expired unused
ticket may be replaced. A future authenticated internal game-server call must
verify the Ed25519 ticket first and then atomically consume its matching hash
while the match is `STARTING`. Finalization accepts both verified and consumed
entries. This state exists before the transport is enabled; no browser route
or Paid Room currently invokes it.

The implemented (but disabled) consume route is a separate Railway-private
raw-body request, signed by a third Ed25519 service-identity pair. Platform
API holds only
`BLOB_PAID_ADMISSION_CONSUMER_PUBLIC_KEY_BASE58`; the future Paid Room holds
the matching private key. This is neither a wallet key nor a settlement key.
It authenticates the caller while the Platform API still validates the stored
ticket hash and immutable entry/match bindings. Do not configure it on the
Free Mode room or in Vite. Without that public key, the endpoint fails closed
with `503 ADMISSION_UNAVAILABLE`; configuring the key alone does not enable
Paid Mode.

`@blob/paid-admission-client` is the intentionally backend-only client for
that future Paid Room. Before it sends the signed consume request, it verifies
the Platform API's Ed25519 ticket locally against a separately configured
ticket-issuer public key and requires an exact expected match and round. It
then validates bounded claims, signs the exact raw JSON body with the caller
key, and accepts only a `204` consume response. It is not an app, has no
browser entrypoint, and is not deployed by `railway.toml`.

Before it creates a settlement request, the paid domain validates the complete
server result: valid timestamp, every funded participant exactly once,
contiguous ranks, and non-negative safe-integer competitive statistics. It
also validates every confirmed revive/death and caller-supplied settlement ID.
Malformed values cannot enter the immutable result hash or an idempotency key.
The Platform API's internal finalization repository then writes the frozen
`MatchResult`, its canonical statistics/pool/payout payload, three
result-bound `Payout` records, and one result-bound `SettlementAttempt` in a
single PostgreSQL transaction. A result is linked to one `matchId`, `roundId`,
rules hash, and result hash; a retry of identical input reuses the same
settlement ID. A divergent result, a missing verified entry, a mismatched
wallet/entry binding, or a non-live match is rejected before any settlement
adapter could act. Result payloads deliberately contain no wallet address;
durable entry records provide that mapping only inside the Platform API.

The PostgreSQL schema also requires a persisted payout split and enforces one
settlement attempt per match, one prize place per enrolled entry, and one
arena player ID per paid entry. A retry cannot create a competing settlement
or pay one entry twice.

Before it persists that immutable result, the Platform API also requires a
durable `startsAt` and verifies that the server-produced result timestamp is
not before the configured ten-minute round end or in the future. This is a
second off-chain chronology guard; the escrow program independently enforces
its on-chain round-end timestamp before settlement.

## Required before enabling paid play

1. Provision PostgreSQL for `services/platform-api` and apply the reviewed
   baseline Prisma migration in
   `services/platform-api/prisma/migrations/20260819000000_init` with
   `npm run prisma:migrate:deploy --workspace=@blob/platform-api`.
2. Deploy the Platform API as a separate persistent service with an HTTPS
   origin, `DATABASE_URL`, `PLATFORM_PUBLIC_ORIGIN`, and the exact
   comma-separated `PLATFORM_WEB_ORIGIN` allowlist. Give the API a same-site
   HTTPS domain such as `https://api.blob.lat` before connecting it directly to
   the browser: its opaque HTTP-only session cookie must not rely on a
   third-party Railway hostname, which modern browsers can block. While that
   direct-domain certificate is provisioned, the Vercel `/v1/*` same-site
   rewrite may bridge to the API through a server-only
   `PLATFORM_API_PROXY_ORIGIN`; the browser must use `https://blob.lat`, never
   the Railway hostname. Keep `PLATFORM_PUBLIC_ORIGIN=https://blob.lat`
   because that is the human-facing origin embedded in the wallet sign-in
   message.
3. Configure `VITE_PLATFORM_API_URL` in Vercel and redeploy the web client.
4. Decide and configure the production Solana RPC endpoint, native USDC mint,
   audited escrow program ID, escrow derivation, treasury, and multisig
   signers. These are intentionally not committed.
5. Replace the non-deployable placeholder ID using a controlled deployment
   keypair outside this repository, compile/test the Anchor escrow program in
   WSL on localnet and devnet, then complete an independent security audit,
   operational incident/reconciliation procedure, and applicable legal review
   before any mainnet USDC is accepted.

Do not enable paid entry, revive, or payouts merely because a wallet can sign
in. Wallet login is proof of address control, not payment authorization.
