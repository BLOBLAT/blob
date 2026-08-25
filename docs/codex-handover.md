# BLOB Codex handover

This file is the shortest safe starting point for a new Codex session working
on BLOB. Read it together with \`AGENTS.md\`; the latter is authoritative when
there is a conflict.

## What BLOB is today

BLOB is a server-authoritative multiplayer arena game with a public Free Mode.
The browser renders state and sends bounded movement intent. The game server
alone owns positions, food, collisions, growth, deaths, ranks, bots, round
lifecycle, and results.

The production topology is deliberately split:

\`\`\`text
blob.lat -> Cloudflare -> Vercel (apps/web)
                         -> HTTPS/WSS -> Railway (apps/game-server)
                                            -> Colyseus blob_arena

Vercel /v1/* rewrite -> Railway-private platform API (services/platform-api)
\`\`\`

Do not move the persistent Colyseus server to Vercel. Do not add a wallet,
payment, token, transfer, keypair, or database dependency to the game client,
game core, or game server.

## Repository map

- \`apps/web\` — Vite landing page, wallet/profile UI, Phaser renderer, controls,
  and arena chat presentation.
- \`apps/game-server\` — Colyseus room, strict origin and message admission,
  \`/health\`, and chat delivery/audit hand-off.
- \`packages/game-core\` — deterministic game rules and all arena tuning. Edit
  values here rather than scattering gameplay constants.
- \`packages/protocol\` — shared room, message, event, lifecycle, and state
  vocabulary.
- \`packages/validation\` — Zod validation and profile/chat moderation policy.
- \`packages/shared\` — future paid-match state and bigint accounting only.
- \`services/platform-api\` — PostgreSQL-backed wallet challenge/profile boundary,
  signed game identity tickets, paid admission and settlement orchestration.
- \`programs/blob-escrow\` — isolated future Anchor escrow program. It is not
  deployed and must not be pulled into Free Mode.
- \`docs\` — canonical operating documentation. Read \`architecture.md\`,
  \`development.md\`, \`deployment.md\`, \`game.md\`, and \`security.md\` before a
  cross-boundary change.

## Current operational state

- The canonical website is \`https://blob.lat\` and Vercel deploys \`apps/web\`
  automatically from \`main\`.
- The game server is a separate Railway service. Its public health endpoint is
  expected to return \`{"service":"blob-game-server","status":"ok"}\`.
- The browser uses \`VITE_GAME_SERVER_URL\`; never place a production hostname in
  client source.
- Browser profile requests use same-site \`https://blob.lat/v1/*\` while the
  \`api.blob.lat\` certificate route is being recovered. The Vercel proxy origin
  is server-only. Do not expose it in a Vite variable.
- The temporary access gate remains intentionally enabled in
  \`apps/web/src/accessGate.ts\`. Do not place its credential in docs, commits,
  tickets, or chat. Its one removal switch is \`ACCESS_GATE_ENABLED\`.
- Free Mode contains clearly marked server-controlled \`ARENA BOT\` participants
  only to keep empty population rounds playable. They are not humans, cannot
  chat, and can never join Paid Mode.

## Current control and rendering rules

- Desktop mouse steering stores the pointer in **screen coordinates** and
  reprojects it through the moving camera every frame. Do not store a one-time
  world point: that makes the BLOB stop as the camera catches up.
- Keyboard uses W/A/S/D and arrows only while a form field is not focused.
  Phaser global keyboard capture is forbidden because it blocks chat/profile
  typing. Clicking the arena blurs a text field and returns control to the game.
- The stage has an explicit desktop height. The leaderboard panel may scroll
  internally; it must never resize the Phaser parent based on the number of
  rankings. Phone stage height is fixed and its DOM joystick lives below the
  canvas, never inside it.
- The client sends input at a bounded rate. The server validates it, rate limits
  it, and turns stale or released input into zero. Do not make the browser
  decide position, speed, mass, collision, or ranking.

## Start locally

Use Node \`>=22.12.0 <23\` and npm \`>=10\`.

\`\`\`powershell
cd C:\Users\user\Desktop\BLOBsite
npm ci
npm run dev
\`\`\`

\`npm run dev\` starts Vite at \`http://127.0.0.1:5173\` and the game server at
\`http://127.0.0.1:2567\`. Open two private/separate browser sessions, unlock the
temporary gate through the normal UI, and join Free Mode in both. Verify both
clients see each other, move, collect food, chat, die/respawn, and update the
leaderboard.

The platform API is separate and requires its documented local PostgreSQL and
environment setup:

\`\`\`powershell
npm run dev:platform
\`\`\`

Never create or commit \`.env\` files. Use the checked-in \`.env.example\` files
and \`docs/development.md\` for variable names.

## Required checks before a commit

\`\`\`powershell
npm run check
npm audit --omit=dev
git diff --check
git status --short
\`\`\`

For a web-only change, also perform a browser check: chat accepts \`wasd WASD\`,
clicking the arena prevents arrow-key page scroll, the Free Mode connection is
live, and canvas dimensions stay fixed while leaderboard entries change. Run
the actual game-server health endpoint only after verifying its URL from the
current Railway configuration.

Commit a focused change, then push only when the user asks:

\`\`\`powershell
git push origin main
\`\`\`

Confirm Vercel marks the new deployment \`Ready\`, \`blob.lat\` returns HTTP 200,
and the persistent game service health endpoint remains HTTP 200. Do not say a
deployment is healthy merely because a TypeScript build succeeded.

## Production operations

Use the Railway MCP integration or authenticated Railway CLI for read-only
diagnostics first: service status, deployment history, logs, health, CPU,
memory, and network. The Railway project is named \`powerful-eagerness\`, and the
production environment is named \`production\`; discover IDs at runtime instead
of committing them.

Use Vercel’s authenticated CLI for deployment status if MCP permissions are
insufficient. The Vercel project is \`blob\` in the \`bloblat1\` scope. Its Root
Directory is \`apps/web\`; a push to \`main\` is normally enough for a web-only
release. Do not publish \`apps/game-server\` as a Vercel function.

\`api.blob.lat\` may still need Cloudflare/Railway certificate recovery. Browser
profiles remain routed through the same-site Vercel \`/v1/*\` bridge until a
direct \`https://api.blob.lat/health\` certificate and health response are both
verified. Do not change DNS or TLS mode blindly.

## Security non-negotiables

- Do not log or commit environment values, cookies, wallet addresses, session
  tokens, signing messages, private keys, seeds, API keys, or deployment-only
  URLs.
- Profile names reach Colyseus only through short-lived Ed25519 tickets issued
  by the platform API. A browser-supplied name is never authoritative.
- Arena chat must be validated server-side, rate limited, link/contact/phishing
  blocked, plain text rendered with \`textContent\`, and persisted only through
  the signed private audit path. Never create a public chat archive or DMs.
- Paid Mode remains disabled. Future USDC entry/revive/payout handling is
  platform API + escrow-program work; use bigint/base units and a settlement
  interface, not frontend numbers or game-server transfers.
- Treat room join, WebSocket upgrade, health, and chat endpoints as public
  ingress. Preserve bounds, rate limits, origin checks, and cheap health
  behavior.

## Safe first-turn checklist for a new Codex

1. Run \`git status --short\`, \`git branch -a\`, and \`git log --oneline -12\`.
2. Read \`AGENTS.md\`, this file, and the relevant documents named above.
3. Inspect the exact component involved before proposing a rewrite.
4. Check live health and current deployment state before blaming the client.
5. Make the smallest server-authoritative fix, test locally and in production
   where access permits, then report evidence and blockers honestly.

Suggested opening prompt for a fresh Codex session:

\`\`\`text
You are continuing the BLOB project in C:\Users\user\Desktop\BLOBsite.
Read AGENTS.md and docs/codex-handover.md in full before acting. Preserve the
server-authoritative Colyseus architecture and the working Vercel/Railway split.
Inspect git status and current production health first. Do not disclose or
commit credentials, do not activate Paid Mode, and do not replace working
systems. Implement, test, commit, and push only the user-authorized scope.
\`\`\`
