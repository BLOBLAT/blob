# Development and deployment

## Requirements

- Node.js `22.12.0` through the current Node 22 release (`.nvmrc` pins `22.12.0`)
- npm 10 or newer; the repository currently uses npm 11.8.0

Do not deploy this repository with Node 24. The root `engines` range is the source of truth.

## Run locally

From the repository root:

```sh
npm ci
npm run dev
```

This starts the full local Free Mode stack:

- Vite browser client: `http://127.0.0.1:5173`
- persistent Colyseus server: `http://127.0.0.1:2567`

Open `http://127.0.0.1:5173` in two browser windows or browser profiles. Click **Play Free** in both. The two blobs should see one another, food, authoritative mass/rank changes, death, and respawn.

To run each process separately:

```sh
npm run dev:server
npm run dev:web
```

The web client falls back to `http://127.0.0.1:2567` only while Vite is running in development mode. To point a local browser at another server, create `apps/web/.env.local`:

```sh
VITE_GAME_SERVER_URL=http://127.0.0.1:2567
```

Do not commit `.env.local`.

## Production topology

```text
BLOB.LAT visitor
  -> HTTPS -> Vercel / apps/web
  -> WSS/HTTPS -> persistent Node.js service / apps/game-server
  -> Colyseus blob_arena
```

Vercel hosts only the Vite frontend. It must not host `apps/game-server`: a normal Vercel frontend deployment does not provide a persistent WebSocket process. Deploy the game server to a Node.js host that supports a continuously running HTTP/WebSocket service and custom environment variables.

### Deploy `apps/web` to Vercel

Configure the existing Vercel project as follows:

| Setting | Value |
| --- | --- |
| Node.js | Node 22.x, compatible with `>=22.12.0 <23` |
| Root Directory | `apps/web` |
| Install Command | `cd ../.. && npm ci` |
| Build Command | `npm run build` |
| Output Directory | `dist` |

In Vercel **Settings → Environment Variables**, set this for Production (and Preview if preview deployments should connect to the game):

```sh
VITE_GAME_SERVER_URL=https://game.your-domain.example
```

Use the public HTTPS URL of the separately deployed game service, without a trailing slash. Colyseus uses this HTTPS endpoint for matchmaker requests and upgrades its live connection to secure WSS automatically. Never hardcode this URL in source code. Changing a `VITE_` variable requires a new Vercel build/deployment because Vite embeds it at build time.

### Deploy `apps/game-server` to a persistent Node.js service

Deploy from the repository root so npm workspaces and the shared TypeScript packages resolve correctly. The deployable app directory is `apps/game-server`.

Use these commands:

```sh
npm ci
npm run build --workspace=@blob/game-server
npm run start --workspace=@blob/game-server
```

The exact production start command is:

```sh
npm run start --workspace=@blob/game-server
```

Set these service environment variables:

```sh
NODE_ENV=production
PORT=<port supplied by your host>
BLOB_WEB_ORIGIN=https://your-web-domain.example
```

`PORT` is required by most hosting providers; the server reads it and falls back to `2567` only for local operation. `BLOB_WEB_ORIGIN` is required in production and accepts a comma-separated allowlist when more than one known web origin is necessary, for example:

```sh
BLOB_WEB_ORIGIN=https://blob.lat,https://www.blob.lat
```

Use the exact deployed Vercel production origin(s), including scheme and no trailing slash. The server applies this allowlist to HTTP CORS responses and WebSocket upgrade requests. Local development defaults only to `http://127.0.0.1:5173` and `http://localhost:5173`.

Terminate TLS at the host or a reverse proxy so the public service is HTTPS and its WebSocket upgrade is WSS. A page served by Vercel over HTTPS cannot connect to an insecure `http://`/`ws://` production game server.

### Verify a deployment

1. Confirm the persistent service is healthy:

   ```sh
   curl -i https://game.your-domain.example/health
   ```

   Expect HTTP 200 and `{"service":"blob-game-server","status":"ok"}`.

2. Open the Vercel site, click **Play Free**, and confirm the panel changes from `Connecting…` to `Connected`.
3. In browser developer tools, verify the game service has a successful HTTPS matchmaker request and a WSS connection. There must be no mixed-content warning.
4. Open a second private window or another browser, click **Play Free**, and confirm both players appear in each client’s arena and leaderboard. Move, collect food, grow, eat a smaller blob, and wait for respawn.

### Connection troubleshooting

| Symptom | Check |
| --- | --- |
| `Server unavailable` immediately | Verify that Vercel has `VITE_GAME_SERVER_URL`, then redeploy the web app. |
| Timeout after eight seconds | Verify the game service is running, public, and its `/health` endpoint returns 200. |
| Browser reports mixed content or WSS fails | Use an HTTPS public game URL and configure TLS/WSS on the persistent host. |
| CORS or WebSocket origin rejection | Match `BLOB_WEB_ORIGIN` exactly to the Vercel site origin; do not use `*`. |
| One client connects but a second does not | Check the game service logs, room capacity, and that both windows use the same `VITE_GAME_SERVER_URL`. |

## Verification commands

```sh
npm run typecheck
npm test
npm run build --workspace=@blob/web
npm run build --workspace=@blob/game-server
npm run check
git diff --check
npm audit --omit=dev
```

`npm test` includes deterministic simulation checks plus a real two-client Colyseus smoke test. The server test binds an ephemeral local port, joins two SDK clients to the same room, validates state/input propagation, rejects an invalid movement command, and verifies disconnect cleanup.
