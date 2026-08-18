# BLOB architecture

## Current baseline

The repository is an npm-workspace monorepo. `apps/web` is the only active application and provides the public BLOB landing shell. It intentionally contains no gameplay simulation, multiplayer emulation, wallet connection, payment flow, leaderboard, or statistics.

## Target boundaries

| Boundary | Responsibility | Must not own |
| --- | --- | --- |
| Browser client (`apps/web`) | Rendering, player input, presentation, and authenticated session transport | Competitive state, collision decisions, scores, balances, and settlement decisions |
| Game server (`services/game-server`) | Deterministic authoritative simulation, validation, collisions, deaths, respawns, score, and match result | Wallet custody, blockchain transactions, and client-trusted decisions |
| Matchmaking (`services/matchmaking`) | Queues, skill/ruleset selection, capacity allocation, and server assignment | Simulation and prize calculation |
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

## Initial technology choices

- **Workspace manager:** npm workspaces, already available with Node.js and sufficient for the initial small codebase.
- **Web application:** TypeScript and Vite. This provides fast local development without imposing a UI framework before the game client needs one.
- **Real-time transport:** deferred until the authoritative game-server slice; WebSocket is the default candidate, selected with protocol and load requirements.
- **Database, chain, payment provider, hosting:** deliberately deferred. Selecting them now would create unused operational surface and false product behavior.

## Security baseline

- Clients are untrusted and must send intent/input, never results.
- Validate message schema, rate, session identity, and allowed state transitions at each server boundary.
- Run deterministic server simulation so results can be reproduced and investigated.
- Store a minimal audit trail for competitive matches and future settlement decisions.
- Keep secrets outside source control. Only committed `.env.example` files may document required variables.
