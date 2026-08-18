# BLOB contributor guide

## Product and authority rules

- Prioritize: security, correctness, gameplay, UX, performance, then scale.
- BLOB is server-authoritative. Clients send input only; they never decide positions, collisions, scoring, match outcomes, balances, or leaderboard results.
- Free Mode is a real local multiplayer mode. Never add fake multiplayer, bots presented as people, payments, leaderboards, statistics, or competitive outcomes.
- Keep paid competition isolated from the game simulation. Payment and chain integrations may validate entry and settlement, but must not alter competitive rules or authoritative results.
- Competitive gameplay must remain skill-based: no pay-to-win mechanics and no RNG that decides competitive outcomes.

## Free Mode round conventions

- The authoritative lifecycle is WAITING, MATCHMAKING, COUNTDOWN, ACTIVE, FINISHED, RESULTS, then WAITING. Do not infer phase or time from the browser.

- Keep all round tuning, world sizing, food density, input expiry, combat thresholds, and respawn rules centralized in the game-core configuration.

- Generate matchId and roundId only on the server. Finalized results are immutable server records and are the only possible future settlement input.

- Free Mode may admit a late player to an active round only through the game-core configuration: use a server-selected safe spawn and spawn protection, while keeping that round's world dimensions fixed. Future Paid Mode can retain a next-round queue. Do not fabricate bots to satisfy matchmaking.

- Stopped, released, malformed, over-rate, and stale movement input must become zero intent. Never reintroduce client-side velocity authority.

- The active leaderboard is server-produced and includes living active participants only. HUD food values must be personal collection statistics, never the global food-object count.

- Preserve one shared engine for FREE and PAID configurations. Paid-mode interfaces are future settlement boundaries only; do not add wallet, token, or transfer code to game-core, game-server, or the browser.

## Repository layout

- `apps/web` — public website and Phaser game client. It renders synchronized state and sends intent only.
- `apps/game-server` — Colyseus authoritative real-time server, `/health` endpoint, configured CORS/WebSocket origin checks, and room integration test.
- `packages/protocol` — shared room names, lifecycle, and message/state types.
- `packages/validation` — Zod validation at untrusted boundaries.
- `packages/game-core` — deterministic arena simulation, central tuning constants, and pure game rules.
- `packages/shared` — paid-match state machine, payment interfaces, and `bigint` prize arithmetic.
- `services` — future deployable API, payment, and blockchain boundaries; do not create empty services.
- `docs` — architecture decisions and operating guidance.

See `docs/architecture.md` before introducing a cross-boundary dependency.

## Game and payment conventions

- Use TypeScript for new application and shared-code work.
- Keep browser code presentation- and input-focused. Treat every client message as untrusted at the server boundary.
- Keep competitive simulation deterministic. Do not use client data or random outcomes to decide movement, collisions, food allocation, ranks, or match results.
- Keep gameplay tuning in `packages/game-core`; do not scatter game constants across room or client code.
- Use integer base units (`bigint`) and basis points for all money. Never use JavaScript floating point for fees, pools, payouts, balances, or accounting.
- Payment and chain adapters must remain interfaces/services outside game-core and game-server. Require durable idempotency keys for deposits, payouts, callbacks, and retries.
- Do not add blockchain contracts, real payment processing, cloud infrastructure, secrets, or wallet prompts until their scoped product work begins.
- Add tests with simulation, transport, payment, or settlement behavior. Deterministic simulation tests and real two-client room smoke tests are preferred.
- Update documentation when a boundary, authority rule, or operational command changes.
- The browser obtains its server endpoint only from `VITE_GAME_SERVER_URL` (with a local Vite fallback). Never hardcode a production game-server hostname in browser code.
- The game server must honor `PORT`; configure `BLOB_WEB_ORIGIN` with the exact comma-separated browser origins permitted to use it. Vercel is web-only and must never host the persistent Colyseus process.
- `railway.toml` is the repository-owned Railway configuration for the one persistent game-server service. Keep it rooted at the repository, build from the workspace root, and keep its start command targeting `@blob/game-server`.
- The temporary browser-only private-build gate is centralized in `apps/web/src/accessGate.ts`. Change `ACCESS_GATE_ENABLED` there to `false` to remove it cleanly; never copy its access credential into comments or documentation.
- Treat `docs/deployment.md` as the canonical Vercel, Railway, Cloudflare, custom-domain, and environment-variable runbook. Do not commit dashboard values, `.env` files, host secrets, or deployment-specific preview origins as source defaults.

## Required validation before a commit

1. Run `npm run check` and fix every failure.
2. Run `npm audit --omit=dev` and do not add known avoidable vulnerabilities.
3. Check `git diff --check`, inspect `git status`, and search changed files for credentials, `.env` values, private keys, and build artifacts.
4. Commit only the intended scope. Push only when the task explicitly requests it.

## Commands

From the repository root:

```sh
npm install
npm run dev
npm run check
```

`npm run dev` starts Vite at port 5173 and the Colyseus game server at port 2567. `npm run check` runs type checks, unit/integration tests, and the production web build.
