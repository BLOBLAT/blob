# Local development

## Prerequisites

- Node.js 22.12.0+ and npm 11.8.0+

## Run the playable local stack

```sh
npm install
npm run dev
```

This starts:

- Vite browser client at `http://127.0.0.1:5173`
- Colyseus game server at `http://127.0.0.1:2567`

Open the Vite URL in two browser windows or profiles. Select **Play Free** in each window. Both clients use the same authoritative `blob_arena` room and should see one another in the in-match ranking.

Useful focused commands:

```sh
npm run dev:web
npm run dev:server
npm run typecheck
npm test
npm run build
npm run check
```

## Environment variables

- `VITE_GAME_SERVER_URL` — optional browser URL for the game server; documented in `apps/web/.env.example`.
- `BLOB_GAME_PORT` — optional game-server port; defaults to `2567`.
- `BLOB_WEB_ORIGIN` — comma-separated allowed browser origins for the game server; defaults to the local Vite origins only.

Do not commit `.env` files or production secrets. No environment variable currently enables payments, wallets, or chain access.

## Verification

`npm test` includes unit tests for validation, arena lifecycle/rules, paid-match transitions, integer prize calculations, and a smoke test that starts a server, connects two SDK clients, exchanges state/input, and shuts down the room/server cleanly.
