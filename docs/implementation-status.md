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

## Current repository baseline

- main and origin/main were clean at c8dd680 before this work.
- Free Mode is live via Vercel (apps/web) and Railway (apps/game-server).
- The game server is authoritative and must never contain wallet keys,
  payment signing, or client-trusted settlement logic.
- packages/shared already has a paid-match state machine and bigint prize
  calculation. This work extends that domain.

## Work completed in this session

- Audited the workspace, game, paid-domain, deployment, tests, and available
  local tooling.
- Confirmed Node 22.12.0 and npm 11.8.0 are available.
- Confirmed Solana CLI, Rust/Cargo, Anchor, PostgreSQL tooling, and Prisma CLI
  are not installed locally yet.
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
- Ran `npm run check` successfully: 34 tests passed, all workspace typechecks
  passed, and the web, game-server, and platform API production builds passed.
- `npm audit --omit=dev` currently reports three high findings through
  Prisma 7.9.1's `@prisma/config` -> `deepmerge-ts`. Its only offered fix is
  the breaking downgrade to Prisma 6.12.0, so it was not applied blindly.

## Next safe steps

1. Provision a managed PostgreSQL instance, generate/review/apply the initial
   Prisma migration, then deploy `services/platform-api` separately.
2. Configure `VITE_PLATFORM_API_URL` in Vercel after that service is healthy.
3. Install Rust/Solana/Anchor only when beginning the audited escrow-program
   phase; actual mint, program, multisig, and RPC values remain external.

## External actions that will eventually be required

- A managed PostgreSQL DATABASE_URL.
- A production Solana RPC provider endpoint and credentials.
- A KMS/HSM or managed signing configuration for restricted settlement
  attestations.
- Multisig members and treasury address.
- Independent smart-contract audit before mainnet.
- Legal/compliance decisions for paid competitive play.

No real USDC, secrets, database credentials, contract deployment, or mainnet
transaction has been created in this repository.
