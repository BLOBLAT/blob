# Production deployment

This guide configures the existing BLOB monorepo for a public Free Mode deployment. It does not deploy a Colyseus server to Vercel and does not enable paid matches, USDC transfers, wallet custody, or blockchain settlement. Wallet-backed profiles are a separate API and database deployment.

## Production architecture

```text
https://blob.lat
  -> Cloudflare (DNS, CDN, TLS)
  -> Vercel / apps/web (static Vite and Phaser client)
  -> HTTPS + WSS
  -> Railway / apps/game-server (persistent Node.js + Colyseus)
  -> blob_arena authoritative simulation
```

GitHub (`BLOBLAT/blob`, `main`) is the source of truth. Vercel deploys only `apps/web`. Railway runs only the persistent `apps/game-server` process, from the repository root so its workspace dependencies resolve. Cloudflare never routes `blob.lat` to the game server.

When wallet profiles are enabled, add this independent path. It must not share a process with Colyseus:

```text
https://blob.lat -> Vercel / apps/web
https://api.blob.lat -> Railway / services/platform-api -> Railway PostgreSQL
https://blob.lat -> WSS -> Railway / apps/game-server
```

The repository root contains [`railway.toml`](../railway.toml). Railway/Railpack discovers this file automatically, installs workspace dependencies, builds `@blob/game-server`, starts that workspace, polls `/health`, and restarts only after a process failure. Its explicit start command prevents Railpack from trying—and failing—to infer a root-level start command in this npm-workspaces monorepo. The custom build command deliberately does not run a second `npm ci`: Railpack already installs dependencies before it runs that command.

## 1. Deploy the persistent game server to Railway

**MANUAL DASHBOARD ACTION REQUIRED:** Railway access is required for these steps.

1. In Railway, select **New Project** → **Deploy from GitHub repo**.
2. Connect and select `BLOBLAT/blob`; deploy the `main` branch.
3. Create one service for the game server. Leave Railway's **Root Directory** empty so commands run from the repository root. Do not set it to `apps/game-server`: the server imports workspace packages from `packages/`.
4. Ensure the service uses Node 22.x. The repository requires `>=22.12.0 <23` and includes `.nvmrc`.
5. Do not enter a conflicting custom build or start command in the Railway dashboard. The checked-in `railway.toml` is the deployment configuration and takes precedence over dashboard values. Its production commands are:

   ```sh
   npm run build --workspace=@blob/game-server
   npm run start --workspace=@blob/game-server
   ```

   The root `npm start` is also a deliberate fallback for generic Node start-command detection and delegates to that same workspace command.

6. Add these Railway service variables:

   ```sh
   NODE_ENV=production
   BLOB_WEB_ORIGIN=https://blob.lat,https://<current-vercel-production-host>
   ```

   Railway supplies `PORT` automatically. Do not hardcode it in Railway or source code; the game server reads `process.env.PORT` and binds to `0.0.0.0`.

   Replace `<current-vercel-production-host>` with the actual deployed `https://…vercel.app` origin while both that host and `blob.lat` should work. When `www.blob.lat` is enabled, use this exact comma-separated form:

   ```sh
   BLOB_WEB_ORIGIN=https://blob.lat,https://www.blob.lat,https://<current-vercel-production-host>
   ```

   Origins include the scheme, have no trailing slash, and are not wildcard patterns.

7. Deploy the Railway service, then generate its public domain. It must be an HTTPS URL such as `https://<railway-generated-host>`.
8. Test the public service before connecting the browser:

   ```sh
   curl -i https://<railway-generated-host>/health
   ```

   Expect HTTP 200 and JSON containing `"status":"ok"`. Railway health checks may use `/health` without authentication.

The service has no filesystem persistence assumption and no browser-only dependency. It can be moved to another persistent Node/WebSocket host with the same root install, build, start command, and environment variables.

## 2. Configure Vercel for the web client

**MANUAL DASHBOARD ACTION REQUIRED:** The available Vercel connection does not expose this project, so Vercel project settings and environment variables must be changed by an authorized dashboard user.

Configure the existing Vercel project as follows:

| Setting | Value |
| --- | --- |
| Git repository | `BLOBLAT/blob` |
| Production branch | `main` |
| Root Directory | `apps/web` |
| Node.js | Node 22.x, compatible with `>=22.12.0 <23` |
| Install Command | `cd ../.. && npm ci` |
| Build Command | `npm run build` |
| Output Directory | `dist` |

In **Settings → Environment Variables**, create this value for the Production environment after Railway has provided its public hostname:

```sh
VITE_GAME_SERVER_URL=https://<persistent-game-server-host>
```

Add the same variable for Preview only when preview builds are intentionally allowed to reach that public Free Mode server. A preview without this variable safely reports that the game server is not configured; it never falls back to localhost.

Redeploy Vercel after changing a `VITE_` variable. Vite embeds these variables at build time. Then open the Vercel URL, pass the temporary access gate, select **Play Free**, and confirm the game panel progresses from server health check to **Connected**.

### Enable wallet profiles only after `api.blob.lat` is healthy

Do not point this variable at a temporary `*.up.railway.app` hostname. A
wallet session is an HTTP-only same-site cookie, so modern browsers can block
it across unrelated sites. Once the API custom domain below returns HTTP 200,
set this additional Production Vercel variable and redeploy:

```sh
VITE_PLATFORM_API_URL=https://api.blob.lat
```

If this variable is absent, the profile dialog clearly says that profiles are
not configured and Free Mode remains playable. It must never fall back to a
production localhost address.

## 3. Deploy the wallet/profile Platform API

Create exactly two additional Railway resources in the existing BLOB project:

1. one managed **PostgreSQL** service;
2. one persistent service named `platform-api`, sourced from `BLOBLAT/blob` on
   `main`.

Keep the service Root Directory empty: this is a shared npm-workspace
monorepo. Configure its build and deploy fields from the repository root:

```sh
npm run build --workspace=@blob/platform-api
npm run prisma:migrate:deploy --workspace=@blob/platform-api
npm run start --workspace=@blob/platform-api
```

Use `/health`, one replica, and restart policy `ON_FAILURE`. Railway supplies
`PORT`; the API binds to `0.0.0.0`. Configure these private service variables:

```sh
DATABASE_URL=${{Postgres.DATABASE_URL}}
NODE_ENV=production
RAILPACK_NODE_VERSION=22.12.0
PLATFORM_PUBLIC_ORIGIN=https://blob.lat
PLATFORM_WEB_ORIGIN=https://blob.lat
PLATFORM_GAME_TICKET_PRIVATE_KEY_BASE64=<random-32-byte-Ed25519-secret-in-base64>
```

`PLATFORM_GAME_TICKET_PRIVATE_KEY_BASE64` must exist only on `platform-api`.
Derive its Ed25519 public key and set only that value on the existing game
server:

```sh
BLOB_PROFILE_TICKET_PUBLIC_KEY=<matching-base58-Ed25519-public-key>
```

Never set either key as a `VITE_` variable, commit it, reuse the API private
key for Solana, or give the game server the private key. These keys authenticate
only ephemeral display-name tickets; they do not authorize payments.

Generate the Railway public API domain, deploy, and test:

```sh
curl -i https://<railway-platform-api-domain>/health
```

Expect HTTP 200 and `{"service":"blob-platform-api","status":"ok"}`. A
database failure deliberately yields HTTP 503 without a connection error.

### Add `api.blob.lat`

**MANUAL DNS ACTION MAY BE REQUIRED:** Add `api.blob.lat` as a custom Railway
domain for the `platform-api` service. Railway will provide both a target and,
when required, an ownership-verification TXT record. In Cloudflare DNS, create
only those exact Railway records, then wait until Railway marks the domain and
certificate healthy. Do not point `api.blob.lat` at Vercel or proxy it to the
game server. Verify:

```sh
curl -i https://api.blob.lat/health
```

Only after that exact test succeeds should Vercel receive
`VITE_PLATFORM_API_URL=https://api.blob.lat`.

## 4. Connect `blob.lat` through Cloudflare to Vercel

**MANUAL DASHBOARD ACTION REQUIRED:** DNS, Cloudflare SSL, and Vercel domain configuration cannot be changed by Git commits.

1. In Vercel, open the web project → **Settings → Domains** and add `blob.lat`. Add `www.blob.lat` only if it will be served or redirected.
2. Copy the exact DNS verification/target instructions shown by Vercel for those domains.
3. In Cloudflare DNS, inspect existing `blob.lat` and `www` A, AAAA, and CNAME records. Remove or replace only records that point to an old host. Create the Vercel-directed record(s) exactly as Vercel instructs; do not guess an address or point this web domain at Railway.
4. In Cloudflare SSL/TLS, use a mode compatible with Vercel's valid origin certificate, normally **Full (strict)** after Vercel has issued the certificate.
5. Wait for Vercel to mark the domain as configured, then verify:

   ```sh
   curl -I https://blob.lat
   ```

   Expect a successful Vercel-served response, not a Cloudflare 525.

Cloudflare error 525 means Cloudflare could not complete TLS to its configured origin. It is an external DNS/origin/TLS problem, not a Vite or Colyseus code failure. Verify the Cloudflare record is targeting Vercel, the Vercel domain is verified, and no stale origin remains before changing application code.

## 5. Later: add `game.blob.lat`

`game.blob.lat` is a separate host from `blob.lat`.

1. Add `game.blob.lat` as a custom domain on the Railway game-server service.
2. Create the Cloudflare DNS record using the exact target Railway provides.
3. Verify `https://game.blob.lat/health` returns HTTP 200.
4. Change Vercel's Production `VITE_GAME_SERVER_URL` to `https://game.blob.lat` and redeploy the web app.

Do not route `game.blob.lat` through Vercel serverless functions. The Colyseus process requires a persistent HTTP/WebSocket service; browser HTTPS requests upgrade to WSS at that service.

## Environment matrix

| Environment | Web: `VITE_GAME_SERVER_URL` | Game server: `NODE_ENV` | Game server: `PORT` | Game server: `BLOB_WEB_ORIGIN` |
| --- | --- | --- | --- | --- |
| Local | Optional; Vite-only fallback is `http://127.0.0.1:2567` | optional | optional, defaults to `2567` | optional; local origins are the default |
| Vercel Preview | Explicit public server URL only when preview play is intended | `production` on the remote service | host-provided | include the exact preview origin only if it needs access |
| Production | `https://<persistent-game-server-host>` | `production` | provided by Railway/host | `https://blob.lat` plus other explicitly served web origins |

Do not commit `.env` files, Railway hostnames that are not public configuration, or any secrets. `VITE_` values are intentionally visible in the browser bundle and must never contain secrets.

## User-visible failure states

The client reports these states without exposing server error messages or stack traces:

- missing production URL: **Game server not configured**;
- unavailable or failing `/health`: **Game server unavailable**;
- connection timeout: **Connection timed out**;
- failed secure/WebSocket connection: **Could not connect**;
- dropped session: **Connection lost — retrying**;
- successful room join: **Connected — server state is live**.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Vercel build fails to resolve a workspace package | Confirm Root Directory is `apps/web`, run the root workspace install command, and keep imported workspace dependencies in `apps/web/package.json`. |
| Game says not configured | Set `VITE_GAME_SERVER_URL` in the correct Vercel environment and redeploy. |
| Game health check fails | Visit `https://<persistent-game-server-host>/health`, inspect Railway deployment logs, and confirm the service is public. |
| Railway says “No start command detected” | Confirm the service deploys the `main` revision containing root `railway.toml`, keep Railway Root Directory empty, and remove any dashboard Config-as-Code path that points elsewhere. |
| Railway reports it is not listening | Confirm `railway.toml` is in the deployed revision, inspect the service logs, and ensure Railway supplies `PORT`; the process binds to `0.0.0.0`. |
| Browser cannot establish WebSocket | Use an HTTPS game URL, confirm `/health` works, and ensure the browser origin appears exactly in `BLOB_WEB_ORIGIN`. |
| CORS/origin rejection | Use comma-separated full origins in `BLOB_WEB_ORIGIN`; do not use `*` in production. |
| `blob.lat` returns Cloudflare 525 | Correct Cloudflare → Vercel DNS/origin/TLS configuration using the Vercel Domain screen; this cannot be repaired in Git. |
| Custom domain does not resolve | Wait for DNS propagation and Vercel/Railway domain verification; check for stale A, AAAA, or CNAME records. |
