# BLOB

**Eat. Grow. Survive.**

BLOB is an independent Web3 skill game and meme brand built around server-authoritative multiplayer survival gameplay: collect food, grow, hunt smaller blobs, survive, and climb a real in-match leaderboard.

Free Mode will be a complete playable experience. Paid competition is planned as a separate layer with stablecoin-oriented entry and settlement, never as a source of game authority or pay-to-win advantage.

## Status

The first real Free Mode slice is implemented for local development: two browser clients can join the same Colyseus arena, see server-synchronized state, send movement intent, collect food, grow, eat eligible opponents, respawn, and view a live match leaderboard.

There is no production deployment, persistent account system, wallet connection, payment processing, global leaderboard, token, or blockchain contract. Paid-mode code is currently limited to pure state-machine and prize-calculation domain modules.

## Local development

Requires Node.js 22.12.0+ and npm 10+.

```sh
npm install
npm run dev
```

Open the Vite URL (normally `http://127.0.0.1:5173`) in two browser windows, then select **Play Free** in both. The game server runs at `http://127.0.0.1:2567`.

Run the full checks with:

```sh
npm run check
```

## Project layout

- `apps/web` — public site and Phaser browser client
- `apps/game-server` — authoritative Colyseus arena server
- `packages/protocol` — room, lifecycle, and wire-contract types
- `packages/validation` — runtime validation of untrusted input
- `packages/game-core` — deterministic simulation and game configuration
- `packages/shared` — paid-match state machine and integer prize domain
- `services` — future API, payment, and chain deployables
- `docs` — architecture and engineering decisions

Read [the architecture guide](docs/architecture.md) and [contributor guide](AGENTS.md) before extending the platform.
