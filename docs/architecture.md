# BLOB architecture

## Implemented baseline

The repository is an npm-workspace monorepo. Local Free Mode is implemented as a Phaser browser client plus a Colyseus authoritative game server. It is real multiplayer: clients use Colyseus `joinOrCreate` to enter the same room, receive state synchronized from the server, and send validated direction intent only.

The room uses the deterministic `packages/game-core` simulation for the fixed tick, bounded movement, food, growth, eating, death, respawn, ranking, and match lifecycle. The browser never computes or submits an authoritative position, score, kill, rank, or match result.

## Implemented round and mode model

The authoritative simulation has one explicit Free Mode lifecycle: WAITING, MATCHMAKING, COUNTDOWN, ACTIVE, FINISHED, RESULTS, then WAITING again. The game core generates unique matchId and roundId values server-side at countdown, calculates a bounded world from round population, tracks personal gameplay statistics, and finalizes an immutable ranking at the end of the active round.

The room schema exposes only synchronized server state: phase, remaining time, world dimensions, players, food, active leaderboard, and finalized result. It also emits transient server events for joins, food collection, eliminations, deaths, round start, round finish, match finalization, and bounded arena chat. The Phaser client uses those state fields for rendering; it never treats a local timer, camera coordinate, or animation as authority.

FREE and PAID are mode values for one shared simulation. Free Mode enables
server-configured respawn. `services/platform-api` now owns a separate
PostgreSQL schema, Wallet Standard/Solana message authentication, opaque
sessions, profile display names, paid-match term hashing, bigint pool and
payout planning, and independently verified finalized USDC transfer claims.
`programs/blob-escrow` is an isolated Anchor 0.32.1 native-USDC escrow source
with host-side Rust tests. It fixes platform configuration, entry/refund
amounts, Rebuy timing, the 5% fee and immutable per-match payout split, and the finalized
result hash on-chain. It remains unexposed to paid play: there is no live paid
room, deployed program, configured program ID, or token transfer. The service
can consume an immutable result without giving payment code control of
gameplay.

Wallet profiles remain outside the real-time server: Wallet Standard signs a
one-time challenge to `services/platform-api`, which creates an opaque cookie
session in PostgreSQL. When a player enters an arena, the browser asks that API
for a five-minute Ed25519-signed identity ticket. The game server verifies it
with `BLOB_PROFILE_TICKET_PUBLIC_KEY`, accepts only its internal user ID and
display name, and never receives a wallet address, session cookie, private
key, or payment state. A missing, invalid, or expired ticket simply produces a
server-assigned anonymous BLOB name, so Free Mode remains available.

Arena Chat uses the already-authoritative Colyseus room. It is intentionally
transient: each room keeps at most 80 messages in process memory and replays
that small buffer to a newly joined client. It accepts plain text from only a
connected player, strips control/zero-width characters, rejects URL patterns
at the server boundary, rate-limits and suppresses duplicate messages, and
uses server-owned player names. It has no database persistence, DMs, wallet
addresses, raw HTML, bots, or fabricated messages.

## Target boundaries

| Boundary | Responsibility | Must not own |
| --- | --- | --- |
| Browser client (`apps/web`) | Phaser rendering, mouse intent, presentation, and Colyseus session transport | Competitive state, collision decisions, scores, balances, and settlement decisions |
| Game server (`apps/game-server`) | Deterministic authoritative simulation, validation, collisions, deaths, respawns, score, match result, and privacy-minimal live presence | Wallet custody, blockchain transactions, historical analytics, and client-trusted decisions |
| Shared game core (`packages/game-core`) | Pure server-consumed simulation and central game configuration | Browser authority or payment/chain logic |
| Protocol and validation (`packages/protocol`, `packages/validation`) | Shared contracts and runtime validation of untrusted payloads | Simulation authority or business logic |
| Matchmaking (`services/matchmaking`, planned) | Queues, skill/ruleset selection, capacity allocation, and server assignment | Simulation and prize calculation |
| Platform API (`services/platform-api`) | Wallet proof, profiles, durable match/payment/audit records, term hashing, and chain verification | Real-time simulation authority, game keys, or browser-trusted payments |
| Escrow program (`programs/blob-escrow`) | Immutable native-USDC match terms, deposited token custody, authority-gated revives, refunds, and deterministic payout execution | Gameplay simulation, browser trust, private keys, or automatic result selection |
| Database | Accounts, durable match summaries, audit records, and server-produced statistics | Real-time simulation authority |
| Payment layer | Entry authorization, stablecoin-provider integration, payouts, and audit trail | Gameplay rules and match-result generation |
| Blockchain adapter | Chain-specific transaction and settlement integration behind an internal interface | Game mechanics and direct client authority |
| Admin layer | Moderation, support, operational visibility, and auditable overrides | Silent or unaudited outcome changes |

The frontend is never authoritative for competitive results. A future shared protocol package may define versioned input and snapshot messages, but it cannot contain authority logic that allows a browser to determine an outcome.

## Data flow

```text
player input
  -> validated real-time transport
  -> authoritative game server and deterministic simulation
  -> immutable match and round result
  -> durable record, auditable result hash, and later: settlement adapters
```

For paid modes, entry authorization occurs before matchmaking; settlement consumes completed, server-produced results after the match. Neither payment success nor token ownership changes simulation rules.

## Technology choices

- **Workspace manager:** npm workspaces, already available with Node.js and sufficient for the initial small codebase.
- **Web application:** TypeScript, Vite, and Phaser 3.90.0 for browser rendering/input.
- **Real-time transport:** Colyseus core with its WebSocket transport and built-in `joinOrCreate` matchmaking. No custom socket or matchmaking framework is used.
- **Validation:** Zod validates join names and each movement intent at the game-server boundary.
- **Profiles and paid orchestration:** PostgreSQL/Prisma and a separate
  Platform API are deployed independently from the game server. Browser
  profile calls use the same-site Vercel `/v1/*` bridge while the direct
  `api.blob.lat` certificate is provisioned; this does not enable Paid Mode.
- **Escrow:** isolated Anchor 0.32.1 source with host-side tests; its native
  USDC mint, governance keys, program ID, deployment, and audit remain
  intentionally external and incomplete.

## Security baseline

- Clients are untrusted and must send intent/input, never results.
- Validate message schema, rate, session identity, and allowed state transitions at each server boundary.
- Run deterministic server simulation so results can be reproduced and investigated.
- Store a minimal audit trail for competitive matches and future settlement decisions.
- Keep secrets outside source control. Only committed `.env.example` files may document required variables.
- The development game server accepts only configured local web origins, caps payload size through Colyseus transport defaults, and retains only the newest validated movement intent per player.
