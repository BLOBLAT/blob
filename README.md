# BLOB

**Eat. Grow. Survive.**

BLOB is an independent Web3 skill game and meme brand. The product is being built around server-authoritative multiplayer survival gameplay: collect food, grow, hunt smaller blobs, survive, and climb a real leaderboard.

Free Mode will be a complete playable experience. Paid competition is planned as a separate layer with stablecoin-oriented entry and settlement, never as a source of game authority or pay-to-win advantage.

## Status

This repository currently contains the BLOB product foundation and public landing shell. No game simulation, multiplayer, payments, token, blockchain contract, wallet flow, leaderboard, or player statistics are implemented yet.

## Local development

Requires Node.js 22.12.0+ and npm 10+.

```sh
npm install
npm run dev:web
```

Open the local URL printed by Vite. Run the baseline checks with:

```sh
npm run check
```

## Project layout

- `apps/web` — public site and future browser game client
- `services` — future authoritative backend services
- `packages` — future shared, versioned code
- `docs` — architecture and engineering decisions

Read [the architecture guide](docs/architecture.md) and [contributor guide](AGENTS.md) before extending the platform.
