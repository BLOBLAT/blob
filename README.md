# BLOB

**Eat. Grow. Survive.**

BLOB is an independent Web3 skill game and meme brand built around server-authoritative multiplayer survival gameplay: collect food, grow, hunt smaller blobs, survive, and climb a real in-match leaderboard.

Free Mode will be a complete playable experience. Paid competition is planned as a separate layer with stablecoin-oriented entry and settlement, never as a source of game authority or pay-to-win advantage.

## Status

Free Mode is a real multiplayer round foundation. A single browser client can
enter matchmaking and receive a server-selected roster of three to five
**clearly labelled Arena Bots**, so a round remains playable while live
players arrive. Bots run only inside the authoritative Free Mode simulation,
use the same movement, food, collision, death, and respawn rules, never count
as real visitors, never chat, and never enter Paid Mode. The server finalizes
the top three and each participant's actual round statistics before returning
the room to matchmaking.

The browser sends normalized intent only. The server owns phase, timer, match and round identifiers, world dimensions, position, food, mass, eating, respawn, rank, and final result. Desktop uses mouse steering with keyboard fallback; mobile uses a release-to-stop touch joystick. A configurable stale-input timeout prevents indefinite drifting when input stops.

The public site and the authoritative server are intentionally separate: Vercel deploys `apps/web`, while `apps/game-server` runs on a persistent Node.js/WebSocket host. The root [`railway.toml`](railway.toml) makes this workspace's Railpack build, start command, and `/health` check explicit. See [the production deployment guide](docs/deployment.md) before enabling Free Mode in production.

The public build is temporarily protected by a client-side private-build gate. It is a visibility measure only, not authentication; its single removal switch is documented for contributors in `AGENTS.md`.

The footer also shows two intentionally small, real-time metrics from the
authoritative game server: active browser presence and BLOBs currently in the
arena. They are in-memory live values, not historical analytics or a claimed
all-time visitor count.

Free Mode remains wallet-free. A separate `services/platform-api` provides an
opt-in Solana wallet sign-in/profile foundation: the wallet signs an off-chain
one-time message, the service verifies Ed25519 ownership, and a secure session
can store a display name. A short-lived API-signed identity ticket lets the
authoritative game server accept that profile name without receiving the wallet
address or trusting a browser-supplied name. The browser never signs in
automatically and no login message approves a transaction or transfers funds.

Free Mode also has transient **Arena Chat** below the game. It is carried by
the same live Colyseus room as the active arena and shows only messages from
real connected players. The server accepts plain text only, rejects links,
applies anti-spam and duplicate-message limits, and keeps only the last 80
messages in that room's memory. It is not a durable social feed or a source of
competitive authority.

The same isolated service contains an unexposed paid-match domain: bigint
native-USDC pool accounting, 5% fee calculation, standard Skill vs disclosed
Rebuy Arena rules, and finalized-chain-transfer verification. The separate
[`programs/blob-escrow`](programs/blob-escrow) Anchor source fixes native-USDC,
match terms, result hash recording, entry/refund handling, authority-attested
revives, and deterministic 5% settlement with an immutable per-match top-three
payout split on-chain. It has host-side
tests only: no program ID, keypair, devnet deployment, blockchain transaction,
USDC custody, or paid match is enabled. See [paid-mode.md](docs/paid-mode.md)
for the required security and deployment gates.

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
- `services/platform-api` — deployed wallet/profile and paid-match orchestration boundary; never a game-server dependency
- `programs/blob-escrow` — isolated Anchor native-USDC escrow source; never a Free Mode dependency
- `docs` — architecture and engineering decisions

Read [the architecture guide](docs/architecture.md) and [contributor guide](AGENTS.md) before extending the platform.
