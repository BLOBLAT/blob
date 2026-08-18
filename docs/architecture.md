# BLOB architecture

## Implemented baseline

The repository is an npm-workspace monorepo. Local Free Mode is implemented as a Phaser browser client plus a Colyseus authoritative game server. It is real multiplayer: clients use Colyseus `joinOrCreate` to enter the same room, receive state synchronized from the server, and send validated direction intent only.

The room uses the deterministic `packages/game-core` simulation for the fixed tick, bounded movement, food, growth, eating, death, respawn, ranking, and match lifecycle. The browser never computes or submits an authoritative position, score, kill, rank, or match result.

## Target boundaries

| Boundary | Responsibility | Must not own |
| --- | --- | --- |
| Browser client (`apps/web`) | Phaser rendering, mouse intent, presentation, and Colyseus session transport | Competitive state, collision decisions, scores, balances, and settlement decisions |
| Game server (`apps/game-server`) | Deterministic authoritative simulation, validation, collisions, deaths, respawns, score, and match result | Wallet custody, blockchain transactions, and client-trusted decisions |
| Shared game core (`packages/game-core`) | Pure server-consumed simulation and central game configuration | Browser authority or payment/chain logic |
| Protocol and validation (`packages/protocol`, `packages/validation`) | Shared contracts and runtime validation of untrusted payloads | Simulation authority or business logic |
| Matchmaking (`services/matchmaking`, planned) | Queues, skill/ruleset selection, capacity allocation, and server assignment | Simulation and prize calculation |
| Database | Accounts, durable match summaries, audit records, and server-produced statistics | Real-time simulation authority |
| Payment layer | Entry authorization, stablecoin-provider integration, payouts, and audit trail | Gameplay rules and match-result generation |
| Blockchain adapter | Chain-specific transaction and settlement integration behind an internal interface | Game mechanics and direct client authority |
| Admin layer | Moderation, support, operational visibility, and auditable overrides | Silent or unaudited outcome changes |

The frontend is never authoritative for competitive results. A future shared protocol package may define versioned input and snapshot messages, but it cannot contain authority logic that allows a browser to determine an outcome.

## Data flow

```text
player input
  -> authenticated real-time transport
  -> authoritative game server
  -> signed/validated match result
  -> durable database record
  -> leaderboard and, later, settlement adapters
```

For paid modes, entry authorization occurs before matchmaking; settlement consumes completed, server-produced results after the match. Neither payment success nor token ownership changes simulation rules.

## Technology choices

- **Workspace manager:** npm workspaces, already available with Node.js and sufficient for the initial small codebase.
- **Web application:** TypeScript, Vite, and Phaser 3.90.0 for browser rendering/input.
- **Real-time transport:** Colyseus core with its WebSocket transport and built-in `joinOrCreate` matchmaking. No custom socket or matchmaking framework is used.
- **Validation:** Zod validates join names and each movement intent at the game-server boundary.
- **Database, chain, payment provider, hosting:** deliberately not implemented. PostgreSQL/Prisma are the planned persistence choice when durable accounts/matches are introduced.

## Security baseline

- Clients are untrusted and must send intent/input, never results.
- Validate message schema, rate, session identity, and allowed state transitions at each server boundary.
- Run deterministic server simulation so results can be reproduced and investigated.
- Store a minimal audit trail for competitive matches and future settlement decisions.
- Keep secrets outside source control. Only committed `.env.example` files may document required variables.
- The development game server accepts only configured local web origins, caps payload size through Colyseus transport defaults, and retains only the newest validated movement intent per player.
