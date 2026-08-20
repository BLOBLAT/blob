# Paid mode implementation status

This is the concise handoff file for future Codex sessions. Update it whenever
a paid-mode milestone changes.

## Goal

Build BLOB's non-custodial Solana native-USDC paid-match foundation while
preserving the deployed authoritative Free Mode. Paid resurrection is an
explicit Rebuy Arena ruleset, not a hidden mechanic in standard Skill matches.

## Locked product decisions

- Settlement asset: native USDC on Solana only.
- Platform fee: 5% of the final confirmed pool.
- Prize pool: 95% of the final confirmed pool.
- Default payout split: 60% / 30% / 10%, calculated in atomic units.
- Rebuy cost: 0.50 USDC.
- Rebuy limit: one per player per match.
- Rebuy is unavailable in the final 60 seconds and expires 30 seconds after
  an authoritative death.
- Free Mode remains wallet-free and unchanged in competitive authority.

## Current repository and deployment baseline

- `main` tracks `origin/main`; commit the repository-side profile, chat, and
  deployment changes before operating production services.
- Free Mode is live via Vercel (apps/web) and Railway (apps/game-server).
- The game server is authoritative and must never contain wallet keys,
  payment signing, or client-trusted settlement logic.
- packages/shared already has a paid-match state machine and bigint prize
  calculation. This work extends that domain.
- Railway production now contains the separate `platform-api` service and one
  managed PostgreSQL instance. The platform API migrations have been applied
  and both its Railway health endpoint and the game-server health endpoint
  return HTTP 200. This does **not** enable paid entry or token transfers.
- Railway has a pending `api.blob.lat` custom domain. Its Cloudflare CNAME and
  TXT ownership records have not yet been confirmed, so the browser must not
  receive `VITE_PLATFORM_API_URL` until `https://api.blob.lat/health` is
  healthy.

## Work completed in this session

- Audited the workspace, game, paid-domain, deployment, tests, and available
  local tooling.
- Confirmed Node 22.12.0 and npm 11.8.0 for the JavaScript workspaces.
- The escrow source passes its host-side Rust tests with the locally installed
  Rust/Cargo toolchain. This Windows environment still lacks Anchor, Solana
  CLI, WSL, a validator, a keypair, wallet, devnet deployment, and chain
  transaction; do not claim an on-chain build from this machine without
  installing and verifying those tools first.
- Queried current package versions: Wallet Standard 1.1.1, Solana Wallet
  Standard features 1.4.0, Prisma 7.9.1, noble ed25519 3.1.0.
- Extended packages/shared with native-USDC constants, explicit SKILL vs
  REBUY rulesets, revive eligibility, pool calculation including revives, and
  revive/permit domain contracts.
- Added the `@blob/platform-api` workspace with a Prisma PostgreSQL schema,
  health endpoint, strict origin handling, opaque HTTP-only sessions, real
  Ed25519 Solana wallet-signature verification, and rate-limited display-name
  updates.
- Added Wallet Standard client discovery, explicit wallet selection, one-time
  message sign-in, profile UI, and Free Mode name reuse. The UI remains honest
  when the profile API or a compatible wallet is unavailable.
- Added paid-match terms/finalization checks and a dependency-free Solana RPC
  verifier for finalized exact `transferChecked` USDC deposits. Neither module
  can sign, send, or claim a payment automatically.
- Added focused tests for wallet signature/replay protection, exact paid-pool
  calculations, Rebuy policy, finalization validation, and payment parsing.
- Ran `npm run check` successfully: 58 tests passed, all workspace typechecks
  passed, and the web, game-server, and platform API production builds passed.
- `npm audit --omit=dev` currently reports three high findings through
  Prisma 7.9.1's `@prisma/config` -> `deepmerge-ts`. Its only offered fix is
  the breaking downgrade to Prisma 6.12.0, so it was not applied blindly.
- Applied the committed PostgreSQL migrations to the managed Railway database
  during `platform-api` deployment. The API refuses readiness until it can
  query that durable store.
- Added `programs/blob-escrow`, an isolated Anchor 0.32.1 native-USDC escrow
  source. It has platform-mint/authority configuration, immutable
  match/round/rules/result hashes, exact entry/revive contribution accounting,
  controller-gated start/cancel, one-revive Rebuy enforcement, an immutable
  ten-minute round with a 30-second death window and final-minute cutoff,
  exact refunds, and on-chain 5% fee plus immutable configuration-validated
  payout logic. Host-side Rust tests pass (9/9); target artifacts are kept
  in the OS temporary directory and ignored by Git.
- Added tests for signed, short-lived, match/round-bound paid admission
  tickets. These tickets are not yet accepted by a Colyseus room because Paid
  Mode remains disabled until the escrow and deployment gates are complete.
- Added privacy-minimal live landing-page metrics: a random per-tab presence
  ID is retained only in game-server memory for 75 seconds, and the footer
  renders actual active browser sessions plus connected arena BLOBs. No
  historical visitor analytics, account data, wallet data, IP address, or
  tracking service was added.
- Aligned the off-chain paid terms validator with the escrow program before
  entry acceptance: canonical disabled Skill-match Rebuy fields are all zero;
  the active ruleset fixes the 10-minute round, 5% fee, max 32 players, exactly
  three positive payouts, and one 0.50 USDC Rebuy with 30-second/final-minute
  timing. The Solana RPC verifier also requires a six-decimal legacy SPL
  `transferChecked` instruction, matching the on-chain mint guard.
- Added and deployed an append-only Prisma migration that persists the immutable
  `roundDurationMs` and revive spawn-protection values alongside canonical
  zero Standard Skill revive fields.

- Added API-signed, short-lived display-name tickets: the Platform API holds
  the private Ed25519 key and the game server holds only its public key. A
  browser cannot submit an authoritative arena name or wallet address.
- Added transient room-scoped Arena Chat below the game. It accepts only plain
  text from live room participants, blocks links both before sending and on
  the server, rate-limits and deduplicates messages, and retains at most 80
  in-memory messages. It has no durable history or direct messages.
- Restricted the escrow cancellation path to `Funding` only, so the match
  controller cannot replace an already-live paid round with blanket refunds.
- Matched the shared paid-match state machine to that same invariant: only
  pre-game `FUNDING`, `READY`, and `STARTING` states can reach `REFUNDING`;
  `LIVE` and `FINALIZING` can only settle a result.
- Ran `cargo test --manifest-path programs/blob-escrow/Cargo.toml --locked`:
  10 escrow host-side tests passed. Build output was kept in and removed from
  the Windows temporary directory.

## Next safe steps

1. Add the exact CNAME and TXT records shown in Railway for `api.blob.lat`,
   wait for the Railway certificate to become active, then verify its health
   endpoint over HTTPS.
2. Configure `VITE_PLATFORM_API_URL=https://api.blob.lat` in Vercel
   Production and redeploy. Test a Phantom Wallet Standard sign-in, profile
   rename, profile ticket, and anonymous Free Mode fallback from a real
   browser.
3. Install the official Solana CLI under WSL or a clean Linux build runner for
   SBF/local-validator and Anchor integration tests. Create the controlled
   deployment key outside the repository, then replace the placeholder program
   ID and test on devnet. Actual mint, program, multisig, and RPC values
   remain external.

## External actions that will eventually be required

- Cloudflare DNS access for the already-created `api.blob.lat` Railway custom
  domain and Vercel access to set the public API URL after it is healthy.
- A production Solana RPC provider endpoint and credentials.
- A KMS/HSM or managed signing configuration for restricted settlement
  attestations.
- Multisig members and treasury address.
- Independent smart-contract audit before mainnet.
- Legal/compliance decisions for paid competitive play.

No real USDC, secrets, database credentials, contract deployment, or mainnet
transaction has been created in this repository.
