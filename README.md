# BLOB

**Eat. Grow. Survive.**

BLOB is an independent Web3 skill game and meme brand built around server-authoritative multiplayer survival gameplay: collect food, grow, hunt smaller blobs, survive, and climb a real in-match leaderboard.

Free Mode will be a complete playable experience. Paid competition is planned as a separate layer with stablecoin-oriented entry and settlement, never as a source of game authority or pay-to-win advantage.

## Status

Free Mode is a real multiplayer round foundation. Two or more browser clients can enter matchmaking, see an authoritative countdown, play a server-timed 10-minute ACTIVE round, collect food, grow, eat eligible opponents, respawn, and view a live in-match leaderboard. The server finalizes the top three and each player's real round statistics before returning the room to matchmaking.

The browser sends normalized intent only. The server owns phase, timer, match and round identifiers, world dimensions, position, food, mass, eating, respawn, rank, and final result. Desktop uses mouse steering with keyboard fallback; mobile uses a release-to-stop touch joystick. A configurable stale-input timeout prevents indefinite drifting when input stops.

The public site and the authoritative server are intentionally separate: Vercel deploys `apps/web`, while `apps/game-server` runs on a persistent Node.js/WebSocket host. The root [`railway.toml`](railway.toml) makes this workspace's Railpack build, start command, and `/health` check explicit. See [the production deployment guide](docs/deployment.md) before enabling Free Mode in production.

The public build is temporarily protected by a client-side private-build gate. It is a visibility measure only, not authentication; its single removal switch is documented for contributors in `AGENTS.md`.

There is no persistent account system, wallet connection, payment processing, global leaderboard, token, or blockchain contract. Paid-mode code is currently limited to pure state-machine and prize-calculation domain modules.

## Local development

Requires Node.js 22.12.0+ and npm 10+.

```sh
npm install
npm run dev
```

Open the Vite URL (normally `http://127.0.0.1:5173`) in two browser windows or profiles, then select **Play Free** in both. The game server runs at `http://127.0.0.1:2567`.

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
