# Development and deployment

## Requirements

- Node.js `22.12.0` through the current Node 22 release (`.nvmrc` pins `22.12.0`)
- npm 10 or newer; the repository currently uses npm 11.8.0

Do not deploy this repository with Node 24. The root `engines` range is the source of truth.

For the canonical Vercel, Railway, Cloudflare, custom-domain, and environment-variable instructions, read [the production deployment guide](deployment.md). The temporary client-side private-build gate is currently disabled for the public launch; its single control remains documented in `AGENTS.md` and must not be changed incidentally.

## Run locally

From the repository root:

```sh
npm ci
npm run dev
```

This starts the full local Free Mode stack:

- Vite browser client: `http://127.0.0.1:5173`
- persistent Colyseus server: `http://127.0.0.1:2567`

Open `http://127.0.0.1:5173` in one browser window and click **Play Free**.
The server should show the real-player count plus a clearly marked roster of
three to five Arena Bots, then start a normal round after the countdown. Open
a second browser window or profile to verify both real clients see one
another, the same bots, food, authoritative mass/rank changes, death, and
respawn.

To run each process separately:

```sh
npm run dev:server
npm run dev:web
```

`services/platform-api` is intentionally not included in `npm run dev`: it
requires a real PostgreSQL `DATABASE_URL`. Once a local database is provisioned
and its schema applied, start it separately with `npm run dev:platform`. Set
`VITE_PLATFORM_API_URL=http://127.0.0.1:3000` in `apps/web/.env.local` to use
wallet profiles locally. Free Mode does not require the API and remains fully
playable if it is unavailable.

To make verified display names reach the local arena, generate a disposable
32-byte Ed25519 private key, set it as
`PLATFORM_GAME_TICKET_PRIVATE_KEY_BASE64` for the platform API, derive its
base58 public key, and set that public key as
`BLOB_PROFILE_TICKET_PUBLIC_KEY` for the game server. Never commit either
value; do not use a Solana wallet key for this purpose.

Profile display names are globally unique and are restricted to ASCII letters,
numbers, spaces, underscores, and hyphens (3–16 characters). The Platform API
normalizes them before storing a uniqueness key and rejects protected staff,
system, bot, payment, wallet, Solana, and infrastructure-looking names,
including simple separator/leetspeak variants such as `BLOB-admin` and
`m0d_erator`. The game server repeats the policy when verifying a signed
identity ticket. A legacy profile that no longer meets the policy can still
rename itself, but receives no named arena ticket until it chooses a compliant
name; Free Mode falls back to an anonymous server-assigned BLOB name.

The web client falls back to `http://127.0.0.1:2567` only while Vite is running in development mode. To point a local browser at another server, create `apps/web/.env.local`:

```sh
VITE_GAME_SERVER_URL=http://127.0.0.1:2567
```

Do not commit `.env.local`.

## Round manual test

With the default round tuning, the first human client remains in matchmaking
only long enough for the server to create its clearly disclosed three-to-five
Arena Bot roster. It then sees the server countdown and the shared 10-minute
round timer. Add a second browser client and verify that real players and bots
are explicitly distinguished in the live ranking. To manually test control
safety, steer briefly with the mouse or touch joystick and stop moving or
release: the BLOB must stop within the configured stale-input interval. At
round end, verify the same top-three result and personal statistics on both
clients, then confirm the room returns to matchmaking without carrying bots
into the next lobby.

## Production topology summary

```text
BLOB.LAT visitor
  -> HTTPS -> Vercel / apps/web
  -> WSS/HTTPS -> persistent Node.js service / apps/game-server
  -> Colyseus blob_arena
```

Vercel hosts only the Vite frontend. It must not host `apps/game-server`: a normal Vercel frontend deployment does not provide a persistent WebSocket process. Deploy the game server to a Node.js host that supports a continuously running HTTP/WebSocket service and custom environment variables. Use [the production deployment guide](deployment.md) for the exact Railway and Cloudflare steps.

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
VITE_GAME_SERVER_URL=https://<persistent-game-server-host>
```

Use the public HTTPS URL of the separately deployed game service, without a trailing slash. Colyseus uses this HTTPS endpoint for matchmaker requests and upgrades its live connection to secure WSS automatically. Never hardcode this URL in source code. Changing a `VITE_` variable requires a new Vercel build/deployment because Vite embeds it at build time.

### Deploy `apps/game-server` to a persistent Node.js service

Deploy from the repository root so npm workspaces and the shared TypeScript packages resolve correctly. The deployable app directory is `apps/game-server`.

For Railway, the repository-root [`railway.toml`](../railway.toml) makes these commands and the `/health` check explicit. Leave Railway Root Directory empty so it discovers that file and all workspace packages. Its only valid `RAILWAY_SERVICE_NAME` values are `blob` and `platform-api`; an unknown name fails closed. Do not replace the checked-in commands with a dashboard-only override.

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
BLOB_WEB_ORIGIN=https://blob.lat,https://<current-vercel-production-host>
```

`PORT` is required by most hosting providers; the server reads it and falls back to `2567` only for local operation. `BLOB_WEB_ORIGIN` is required in production and accepts a comma-separated allowlist when more than one known web origin is necessary, for example:

```sh
BLOB_WEB_ORIGIN=https://blob.lat,https://www.blob.lat
```

Use the exact deployed Vercel production origin(s), including scheme and no trailing slash. The server applies this allowlist to HTTP CORS responses and WebSocket upgrade requests. Local development defaults only to `http://127.0.0.1:5173` and `http://localhost:5173`.

Terminate TLS at the host or a reverse proxy so the public service is HTTPS and its WebSocket upgrade is WSS. A page served by Vercel over HTTPS cannot connect to an insecure `http://`/`ws://` production game server.

### Deploy `services/platform-api` separately (profiles only)

Do this only after provisioning managed PostgreSQL. This service is separate
from both Vercel and the authoritative Colyseus server. In Railway, create a
new persistent service with an empty Root Directory. The repository-root
[`railway.toml`](../railway.toml) detects `RAILWAY_SERVICE_NAME=platform-api`
and runs the workspace build, migration, and start commands. Set:

```sh
DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<database>?schema=public
NODE_ENV=production
PORT=<provided-by-railway>
PLATFORM_PUBLIC_ORIGIN=https://blob.lat
PLATFORM_WEB_ORIGIN=https://blob.lat,https://www.blob.lat
PLATFORM_GAME_TICKET_PRIVATE_KEY_BASE64=<separate-random-32-byte-private-key>
BLOB_ARENA_CHAT_AUDIT_PUBLIC_KEY_BASE58=<separate-base58-public-key>
BLOB_CHAT_RETENTION_DAYS=90
```

Production uses a host-only `__Host-blob_session` cookie by default and rejects
a weaker custom cookie name. The API applies both per-wallet limits and a
bounded process-local aggregate limit to wallet challenge and verification
calls. The aggregate default is 180 requests per route per 60-second window;
configure `PLATFORM_AUTH_GLOBAL_RATE_LIMIT` and
`PLATFORM_GLOBAL_RATE_LIMIT_WINDOW_MS` together only when the documented
traffic capacity is insufficient. The separate short global window prevents a
small random-wallet burst from locking legitimate wallets out for the
per-wallet 10-minute period. Retain an edge/WAF limit when the service becomes
public: the process-local brake is intentionally not shared across replicas.

The separate `GET /v1/me/game-ticket` signing endpoint is also bounded: the
defaults allow 15 ticket requests per authenticated profile and 240 across the
single API process in the same ten-minute window. This covers normal arena
joins and reconnects while preventing an authenticated session from creating
unbounded Ed25519 signing work. The browser remains able to join Free Mode
anonymously if an identity ticket cannot be obtained.

For production chat auditing, generate a second, independent Ed25519 key pair
outside the repository. Put only the public base58 half on `platform-api` as
shown above. Put the matching private base64 half only on `blob`, together
with the private Railway endpoint:

```sh
BLOB_ARENA_CHAT_AUDIT_PRIVATE_KEY_BASE64=<matching-random-32-byte-private-key>
BLOB_CHAT_RETENTION_DAYS=90
PLATFORM_CHAT_AUDIT_ORIGIN=http://platform-api.railway.internal:8080
```

Accepted messages are signed and persisted before room broadcast. They contain
no wallet/cookie/IP and Platform API deletes them after the configured retention
period. `8080` is the current production Platform API listener port on Railway;
if that service's `PORT` changes, update this single game-server variable to
match. If this bridge is unavailable, only chat fails closed; arena gameplay
does not depend on it.

Apply the committed baseline before starting the service:

```sh
npm run prisma:migrate:deploy --workspace=@blob/platform-api
```
Before exposing browser profiles, attach a same-site HTTPS custom domain such
as `https://api.blob.lat` to the Platform API. Do not point
`VITE_PLATFORM_API_URL` at a third-party Railway hostname: modern browsers can
block the opaque HTTP-only profile session cookie in that cross-site setup.
The API starts only after PostgreSQL accepts a real query, and `/health`
returns HTTP 503 whenever that probe fails. Once the direct custom domain
returns HTTP 200, set this Vercel production variable and redeploy the web
client:

```sh
VITE_PLATFORM_API_URL=https://api.blob.lat
```

If the direct custom-domain certificate is still being issued, keep browser
cookies same-site through the checked-in Vercel `/v1/*` rewrite instead. Set
both Production variables in Vercel and redeploy:

```sh
VITE_PLATFORM_API_URL=https://blob.lat
PLATFORM_API_PROXY_ORIGIN=https://<platform-api-railway-public-host>
```

The latter is server-only Vercel build configuration, not a `VITE_` variable.
It must contain the public Platform API HTTPS origin, never a secret. Once the
direct `api.blob.lat/health` endpoint is healthy, remove that proxy origin,
restore the direct API URL above, and redeploy.

Leave `SOLANA_RPC_URL`, `SOLANA_USDC_MINT`, and
`BLOB_ESCROW_PROGRAM_ID` unset until the audited paid-mode escrow rollout.
They are server-only values, never Vite variables. This does not enable paid
matches; it only enables opt-in wallet-backed profiles.

### Verify a deployment

1. Confirm the persistent service is healthy:

   ```sh
   curl -i https://<persistent-game-server-host>/health
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

`npm test` includes deterministic simulation checks plus a real two-client
Colyseus smoke test. The server test binds an ephemeral local port, joins two
SDK clients to the same room, validates state/input propagation, rejects an
invalid movement command, verifies disconnect cleanup, and proves that three
disclosed Arena Bots synchronize without increasing the real-client metric.

It also verifies Arena Chat with two real room clients: a normalized plain-text
message is delivered under the server-owned player name and a URL is rejected
by the server. The live buffer is process-local and limited to 80 messages.
Production chat additionally requires its signed private Platform API audit
bridge; accepted messages are durably retained for the configured 90-day
window. Local development deliberately uses the bounded live buffer unless a
developer configures the private audit bridge.

## Live landing-page metrics

The footer's **LIVE VISITORS** and **BLOBS IN THE PIT** counters are live,
ephemeral server values, not analytics. After a gated page is opened, the
browser sends a random per-tab ID to `POST /presence` every 30 seconds while
visible. The game server retains that ID only in memory for 75 seconds and
does not store accounts, wallet addresses, raw IP addresses, user agents,
cookies, or historical traffic. The write endpoint additionally requires the
exact `BLOB_WEB_ORIGIN` and applies a short per-process rate limit keyed by a
randomly salted one-way client-address fingerprint; that fingerprint expires
after one minute and is never persisted. `GET /metrics` returns the current
`{ liveVisitors, arenaPlayers }` snapshot.

These values reset when the game-server process restarts and are deliberately
bounded to 10,000 recent browser sessions. Do not relabel them as an all-time
visitor count without a separate privacy-reviewed persistence design.

## Escrow-program host tests

`programs/blob-escrow` is not an npm workspace and is never launched with the
web or game server. It has an isolated Anchor/Rust dependency graph. The
host-side test suite validates its real program types and pure on-chain
accounting without creating a keypair, starting a validator, or contacting a
Solana cluster.

On this Windows workspace, use a temporary Cargo target directory so compiled
artifacts do not appear in the repository:

```powershell
$env:CARGO_TARGET_DIR = Join-Path $env:TEMP "blob-escrow-cargo-target"
& "$env:USERPROFILE\.cargo\bin\cargo.exe" test --manifest-path programs\blob-escrow\programs\blob_escrow\Cargo.toml
```

The committed program source pins Anchor 0.32.1. Official Solana/Anchor
guidance requires WSL for the full Solana CLI, SBF/BPF build, local validator,
and `anchor test` flow on Windows. The repository also provides
`programs/blob-escrow/scripts/localnet-smoke.sh`, which uses only a temporary
workspace, throwaway local keypairs, and `solana-test-validator` to build and
deploy the escrow locally. Do not generate a persistent deployer keypair or
run a devnet deployment from this repository. A controlled external deployment
procedure must first replace the intentionally non-deployable program ID,
fund the deployment signer on devnet, and run integration tests.

The localnet smoke test passed using Ubuntu 22.04 WSL with Anchor 0.32.1 and
Solana/Agave 2.3.0. The escrow `Cargo.lock` intentionally pins a small set of
indirect dependencies compatible with the bundled Solana 2.3 SBF compiler
(Rust/Cargo 1.84). Keep that lockfile committed; upgrading it without a fresh
SBF/localnet test can reintroduce unsupported Rust 2024 or Rust 1.85
dependencies.
