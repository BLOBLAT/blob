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

- `main` tracks `origin/main`; verify the current commit with `git status` and
  `git rev-parse HEAD origin/main` rather than relying on a stale handoff SHA.
- Free Mode is live via Vercel (apps/web) and Railway (apps/game-server).
- The game server is authoritative and must never contain wallet keys,
  payment signing, or client-trusted settlement logic.
- packages/shared already has a paid-match state machine and bigint prize
  calculation. This work extends that domain.
- Railway production now contains the separate `platform-api` service and one
  managed PostgreSQL instance. The platform API migrations have been applied
  and both its Railway health endpoint and the game-server health endpoint
  return HTTP 200. This does **not** enable paid entry or token transfers.
- The Railway `api.blob.lat` custom domain has its required DNS records, but
  Railway still reports `VALIDATING_OWNERSHIP` and a direct HTTPS check fails.
  It is not exposed to browsers while invalid. Cloudflare must leave the
  `api` CNAME **DNS only** while Railway validates the certificate; do not
  assume a proxied record can complete that origin-certificate flow.
- Vercel Production currently serves wallet profiles through the same-site
  `/v1/*` rewrite: `VITE_PLATFORM_API_URL=https://blob.lat` is browser-visible
  and `PLATFORM_API_PROXY_ORIGIN` remains server-only. Platform API,
  PostgreSQL, and ticket-signing secrets remain scoped to Railway. The direct
  custom domain becomes the preferred endpoint only after
  `https://api.blob.lat/health` returns HTTP 200.

## Work completed in this session

- Audited the workspace, game, paid-domain, deployment, tests, and available
  local tooling.
- Confirmed Node 22.12.0 and npm 11.8.0 for the JavaScript workspaces.
- The escrow source passed host-side Rust tests and the committed isolated
  localnet smoke test before `b59e4c5`. The smoke script discovers the installed
  Solana CLI and uses only temporary validator state and throwaway keys. The
  current Windows WSL distribution registration must be restored before another
  local SBF smoke run; do not remove its existing WSL virtual disk. No controlled
  deployer key, wallet, devnet deployment, or public-chain transaction exists.
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
- Wallet profile display names are now globally unique after canonical
  case/whitespace normalization. PostgreSQL enforces the invariant, the API
  returns `409 PROFILE_NAME_UNAVAILABLE` for a claimed name, and generated
  anonymous-looking profile defaults retry a collision without exposing a
  wallet suffix in the arena.
- Railway production deployment `683bc940-3b01-47ba-a625-57c8e1d9d15c`
  applied `20260824133000_enforce_unique_display_names` successfully; its
  post-deploy Platform API health check returned HTTP 200.
- Added paid-match terms/finalization checks and a dependency-free Solana RPC
  verifier for finalized exact `transferChecked` USDC deposits. Neither module
  can sign, send, or claim a payment automatically.
- Added focused tests for wallet signature/replay protection, exact paid-pool
  calculations, Rebuy policy, finalization validation, and payment parsing.
- Ran the equivalent split verification successfully: 60 tests passed, all workspace typechecks
  passed, and the web, game-server, and platform API production builds passed.
- The current JavaScript suite has 76 tests passing. The root workspace check
  now executes TypeScript workspaces sequentially, avoiding the Windows
  parallel-compiler memory failure without dropping any package check.
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
  payout logic. Host-side Rust tests are kept current below; target artifacts
  are kept in the OS temporary directory and ignored by Git.
- Corrected `MatchEscrow` account allocation to include all 348 serialized
  payload bytes plus Anchor's eight-byte discriminator. A source-level
  regression test serializes a populated escrow and compares its exact length
  with the allocation constant, preventing an under-allocation during
  `create_match`; the isolated localnet smoke script runs those Rust tests
  before it builds and deploys its throwaway copy.
- Added tests for signed, short-lived, match/round-bound Ed25519 paid-admission
  tickets. The Platform API would retain the private signing key while a future
  paid room receives only the public verification key. These tickets are not
  yet accepted by a Colyseus room because Paid Mode remains disabled until the
  escrow and deployment gates are complete.
- Profile identity tickets now contain a unique ID and are consumed exactly
  once by the arena. Replayed tickets fall back to an anonymous Free Mode name;
  the browser requests a fresh ticket on each connection or reconnect.
- The paid-domain finalizer now rejects malformed result timestamps,
  non-finite/negative competitive statistics, invalid revive IDs, and invalid
  caller-supplied settlement IDs before it hashes a result or emits a
  settlement request.
- Platform API reference validation Base58-decodes every future Solana public
  key to 32 bytes and transaction signature to 64 bytes before it calls an
  RPC endpoint. A string that merely resembles a Solana reference is rejected.
- The paid-record migration now requires a persisted payout split and gives a
  match exactly one durable settlement attempt plus an entry exactly one prize
  place. It was applied by Railway pre-deploy; the API and database health
  check remained successful.
- Future paid admission uses a separate optional
  `PLATFORM_PAID_ADMISSION_TICKET_PRIVATE_KEY_BASE64` Ed25519 signer. The API
  rejects malformed values and refuses to start if it matches the Free Mode
  display-name ticket key. The obsolete HMAC shared-secret configuration was
  removed; setting the future key does not enable Paid Mode.
- Railway deployment watch patterns are scoped per service. A Platform API
  commit deploys only that service; game-server/game-core/protocol changes
  deploy the authoritative arena. Root dependency/configuration changes still
  deliberately deploy both.
- Production browser smoke confirmed the real `blob.lat` Free Mode path:
  authenticated WebSocket connection, server state, a separately labelled
  3–5 Arena Bot roster, and bot labels in the authoritative leaderboard. The
  smoke-test session left the room cleanly.
- Added privacy-minimal live landing-page metrics: a random per-tab presence
  ID is retained only in game-server memory for 75 seconds, and the footer
  renders actual active browser sessions plus connected arena BLOBs. No
  historical visitor analytics, account data, wallet data, IP address, or
  tracking service was added.
- Added a Free Mode-only, server-authoritative Arena Bot roster. Each round
  with a human player gets a deterministic varied set of three to five bots;
  bot AI flees larger BLOBs, hunts safely smaller BLOBs, gathers food, and
  roams through the same simulation/input path. Bots are synchronised as
  `isBot`, visibly labelled in the leaderboard/results, excluded from live
  visitor counts and chat, displaced before a real player is refused at
  capacity, removed between rounds, and forbidden in Paid Mode.
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
- Platform API now returns a deliberate `403 ORIGIN_NOT_ALLOWED` response for
  browser Origins outside its explicit allowlist, rather than an ambiguous
  internal error. It is deployed with a durable-store health check, and Vercel
  production rewrites only `/v1/*` requests through the same-site bridge.
- Added transient room-scoped Arena Chat below the game. It accepts only plain
  text from live room participants, blocks links both before sending and on
  the server, rate-limits and deduplicates messages, and retains at most 80
  in-memory messages. It has no durable history or direct messages.
- Restricted the escrow cancellation path to `Funding` only, so the match
  controller cannot replace an already-live paid round with blanket refunds.
- Matched the shared paid-match state machine to that same invariant: only
  pre-game `FUNDING`, `READY`, and `STARTING` states can reach `REFUNDING`;
  `LIVE` and `FINALIZING` can only settle a result.
- Added an immutable maximum-15-minute pre-game funding deadline to paid terms
  and the escrow. It is included in the rules hash; the controller cannot
  start a paid round or accept a new entry after it, while anyone can
  transition a never-started escrow to individual refunds after expiry. The
  controller, result authority, and treasury must now be distinct roles.
- Ran `cargo test --manifest-path programs/blob-escrow/Cargo.toml --locked`:
  11 escrow host-side tests passed. Build output was kept in and removed from
  the Windows temporary directory.
- Added and passed `programs/blob-escrow/scripts/localnet-smoke.sh`: the
  program builds against Solana's SBF runtime and is deployed and queried on
  an ephemeral local validator. The checked-in `Cargo.lock` intentionally pins
  compatible indirect crates because the Solana 2.3 platform toolchain embeds
  Rust/Cargo 1.84; newer registry releases requiring Rust edition 2024 or
  Rust 1.85 cannot be used by that compiler.
- Reduced `SettleMatch` account deserialization pressure with boxed Anchor
  account wrappers. The prior local SBF build reported a 5952-byte stack frame
  exceeding Solana's 4096-byte maximum; the successful rebuild has no such
  warning. The public account interface and all authorization constraints are
  unchanged.

## Next safe steps

1. Keep the `api` Cloudflare CNAME **DNS only**, then monitor
   `https://api.blob.lat/health` until Railway presents a valid certificate.
   Do not interrupt the working same-site bridge before that exact check
   returns HTTP 200.
2. Test a Phantom Wallet Standard sign-in, profile rename, profile ticket,
   and anonymous Free Mode fallback from a real browser. Once the direct
   health endpoint is valid, replace the temporary Vercel values with
   `VITE_PLATFORM_API_URL=https://api.blob.lat`, remove
   `PLATFORM_API_PROXY_ORIGIN`, and redeploy.
3. Create a controlled deployment key outside the repository, then replace the
   placeholder program ID and test on devnet. Actual mint, program, multisig,
   and RPC values remain external.

## External actions that will eventually be required

- Cloudflare DNS access is required only to ensure the already-created
  `api.blob.lat` CNAME remains DNS-only while Railway issues its certificate;
  do not alter the target or remove the verification record.
- A production Solana RPC provider endpoint and credentials.
- A KMS/HSM or managed signing configuration for restricted settlement
  attestations.
- Multisig members and treasury address.
- Independent smart-contract audit before mainnet.
- Legal/compliance decisions for paid competitive play.

No real USDC, secrets, database credentials, contract deployment, or mainnet
transaction has been created in this repository.
