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
- Public wallet authentication now applies both per-wallet and aggregate
  process-local limits for challenge and verification routes. The aggregate
  default bounds distinct-address challenge abuse to 120 requests per route
  per ten-minute window on the single Platform API replica; it is an explicit
  safety brake, not a substitute for future edge/WAF enforcement.
- Issuing a one-time Free Mode profile-identity ticket is also bounded to 15
  requests per authenticated profile and 240 across the process per ten-minute
  window. A threshold response only makes that join anonymous; it never blocks
  the real Free Mode arena or exposes a wallet address to Colyseus.
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
- GitHub Actions now runs the escrow crate's locked native Rust tests only
  when escrow source or its workflow changes. It is an isolated compile/test
  gate; it has no wallet, Solana RPC, deployment, or production credentials.
  Its first run (`32715817480`) completed successfully for commit `4f28fcb`.
- Added tests for signed, short-lived, match/round-bound Ed25519 paid-admission
  tickets. The Platform API would retain the private signing key while a future
  paid room receives only the public verification key. These tickets are not
  yet accepted by a Colyseus room because Paid Mode remains disabled until the
  escrow and deployment gates are complete.
- Hardened that verifier to reject even correctly signed tickets with future
  issuance times, lifetimes outside 10 seconds to five minutes, malformed
  internal identifiers, non-UUID nonces, or a non-SHA-256 rules hash.
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
- Added the same 0.01 USDC minimum entry amount to shared paid terms and the
  Anchor escrow. With the immutable three-player minimum and positive
  top-three payout basis points, it prevents any required prize place from
  rounding down to zero atomic USDC before a match can be funded.
- Added and deployed an append-only Prisma migration that persists the immutable
  `roundDurationMs` and revive spawn-protection values alongside canonical
  zero Standard Skill revive fields.

- Added API-signed, short-lived display-name tickets: the Platform API holds
  the private Ed25519 key and the game server holds only its public key. A
  browser cannot submit an authoritative arena name or wallet address.
- Added the internal immutable paid-result persistence boundary: a canonical
  server-produced result, its exact three-place payout plan, and one
  settlement-attempt record are written together only for matching durable
  terms and verified player entries. Identical retries reuse the same derived
  settlement ID; conflicting results fail closed. It has no public route and
  cannot sign, send, or accept a USDC transfer.
- Railway deployment `8bab46b7-67bd-48b0-8d41-d29ff8fda90a` successfully
  applied migration `20260824150000_persist_immutable_paid_results`; its
  post-deploy Platform API health check returned HTTP 200.
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

## Continuation handoff — 2026-08-24

This section records the product work and current continuation boundary. The
protected-name policy and the first durable Arena Chat audit path are now
implemented. Keep the authoritative Free Mode and the existing wallet/profile
boundary intact while extending it.

### Deployed chat-audit checkpoint

The durable chat implementation was pushed as `85ba50a` and deployed to the
production `blob` and `platform-api` Railway services. Railway applied
`20260824190000_add_arena_chat_audit`; both public `/health` endpoints returned
HTTP 200. A production Colyseus smoke test sent a safe text message and
received the server's accepted message only after the Platform API returned
the audit `201` response. The independent audit key pair exists only in the
corresponding Railway service variables and was never committed or printed.

The working private-route setting on `blob` is:

```sh
PLATFORM_CHAT_AUDIT_ORIGIN=http://platform-api.railway.internal:8080
```

`8080` is the Platform API listener port on the current Railway deployment; if
the Platform API's Railway `PORT` changes, update this single value to match.
The prior reference form using `${{platform-api.PORT}}` did not resolve to a
reachable listener and failed closed as designed.

If private audit variables are absent in production, the new game-server code
fails only **chat** closed with `CHAT_AUDIT_UNAVAILABLE`; authoritative gameplay
continues. Local development intentionally retains the existing bounded
in-memory chat behaviour unless the audit bridge is configured.

### Verified current behaviour

- Do not rely on a hard-coded revision in this handoff. Confirm `HEAD` still
  equals `origin/main` before assuming any deployment or implementation detail
  remains current.
- A signed-in wallet creates one durable `User` and `Wallet` record in the
  Platform API PostgreSQL database. `User.displayNameKey` has a database
  uniqueness constraint, so an authenticated display name belongs to one
  profile and survives reconnects/browser changes. Rename is rate limited.
- The game server ignores the browser-supplied join name. It accepts a profile
  name only from a short-lived, one-time Ed25519 ticket signed by the Platform
  API; otherwise it assigns a server-generated anonymous `BLOB-…` name. A
  wallet address never enters Colyseus state or chat.
- Arena Chat remains room-scoped for delivery and retains only 80 live
  messages in the authoritative process. In production, an accepted normalized
  message is Ed25519-signed by the game server and persisted through a
  Railway-private Platform API endpoint before it is broadcast. PostgreSQL
  stores the message/name snapshot, room/match/round, time, and either a
  profile user ID or a one-way anonymous arena identifier—never a wallet,
  cookie, IP, raw HTML, or a public archive. Platform API purges expired
  records (90 days by default). Links, email/phone/contact strings, likely
  wallet addresses, scam phrases, malformed payloads, flooding, and duplicate
  sends are rejected server-side. There is still intentionally no direct
  message feature, moderator role, report queue, or mute UI.
- The direct `api.blob.lat` certificate is still stuck in Railway
  `VALIDATING_OWNERSHIP` despite its propagated CNAME/TXT, no CAA record, and
  no DNSSEC delegation. Do not remove the working Vercel same-site `/v1/*`
  bridge while that remains true.

### Approved direction to implement next

1. **Centralised profile-name policy — implemented.** The present ASCII 3–16
   character scope remains in place (it avoids Unicode homoglyph
   impersonation). `@blob/validation` now NFKC-normalizes, collapses
   whitespace, case-folds for the PostgreSQL uniqueness key, and derives a
   protected-name comparison skeleton that defeats separator and common ASCII
   leetspeak bypasses such as `BLOB-admin`, `m0d_erator`, and `SUP PORT`. It
   runs at rename, game-ticket issuing, and game-ticket verification.
2. **Reserved system and staff-looking names — implemented for new or renamed
   profiles.** The policy rejects protected roles and
   namespaces, including at minimum: `admin`, `administrator`, `mod`,
   `moderator`, `staff`, `support`, `help`, `team`, `official`, `verified`,
   `owner`, `founder`, `developer`, `dev`, `operator`, `security`, `system`,
   `server`, `bot`, `arena bot`, `blob admin`, `blob moderator`, `blob mod`,
   `blob support`, `blob staff`, `blob official`, `railway`, `vercel`,
   `cloudflare`, `phantom`, `solana`, `usdc`, `treasury`, `escrow`, `wallet`,
   `payment`, `payout`, and `settlement`. Do not create a privileged role by
   name; real staff authorisation must be separate, server-side, and audited.
   A signed legacy ticket carrying a newly reserved name fails closed and the
   arena uses an anonymous server-generated BLOB name instead.
3. **Protect the existing user population during migration.** Before changing
   the database uniqueness key, write a migration strategy and tests for
   historical collisions. An existing invalid/reserved public name must never
   silently turn into someone else's name. Mark it `rename required` or fall
   back to a server-generated presentation name until its owner selects a
   compliant replacement; do not delete users or wallets.
4. **Add durable chat as an audit log, not a public global archive — implemented.** Preserve
   the real-time Colyseus room as the only chat transport. After its server
   validation succeeds, persist the normalized message to Platform API
   PostgreSQL before broadcasting it. Store message ID, room/match/round,
   server timestamp, a snapshot of the display name, internal profile user ID
   when present, and a non-wallet anonymous arena-session identifier when not.
   Never store wallet addresses, session cookies, IP addresses, or raw HTML in
   chat records. Historical messages retain the original name snapshot even
   after a profile rename.
5. **Use an internal authenticated game-server → Platform API path — implemented.** Prefer
   Railway private networking plus a dedicated Ed25519 audit-event signer:
   the game server receives only the private signing key, the Platform API
   receives only its public verifier key. Both keys stay in Railway variables,
   never in Vite or Git. If the API/database is unavailable, reject only the
   chat message with an explicit unavailable state; never stall, crash, or
   make Free Mode movement depend on chat persistence.
6. **Implement minimal deterministic moderation before durable chat is
   enabled — partly implemented.** Retain the current normalisation/link checks and extend them to
   email/phone/crypto-address solicitation, control/invisible character
   stripping, flood/repetition limits, a reviewed server-side prohibited-term
   list, user/session temporary mutes, soft hide/removal status, and an
   append-only moderation audit trail. Do not send player text to an external
   AI moderation provider without an explicit privacy decision. Add a
   rate-limited `report message` action and retain reports for staff review.
7. **Use bounded retention and a deliberate staff boundary.** Recommended
   initial policy: 90-day retained audit messages and moderation actions,
   followed by automatic purge; no public message-search/history endpoint.
   Expose only the current room's bounded live history to players. Any future
   admin/moderator console must use a separately authenticated role grant and
   log every hide, mute, deletion, and export; a public display name must
   never grant privileges.
8. **Test the whole boundary.** Add database migration/repository tests,
   reserved-name and bypass tests, ticket tests, two-client room tests proving
   links/spam/prohibited content are rejected, durable records are written
   once before broadcast, persistence failure cannot affect gameplay, muted
   users cannot evade a mute by reconnecting, and old chat name snapshots do
   not change after rename. Run `npm run check`, `npm audit --omit=dev`,
   `git diff --check`, plus an actual browser two-window smoke test before a
   deployment.

### External gates still required for live paid USDC

Do not enable a paid queue, payment UI, or transfer flow merely because the
profile/chat work is complete. Mainnet activation still requires a controlled
program ID and deployer outside the repository, devnet/localnet escrow
integration evidence, multisig/treasury and restricted attestation custody,
an independent contract audit, a production Solana RPC provider, operational
reconciliation/incident procedures, and legal/compliance approval for paid
competitive play.
