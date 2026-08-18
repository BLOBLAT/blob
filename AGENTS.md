# BLOB contributor guide

## Product rules

- Prioritize: security, correctness, gameplay, UX, performance, then scale.
- BLOB is server-authoritative. Clients send input only; they never decide positions, collisions, scoring, match outcomes, balances, or leaderboard results.
- Free Mode must be a complete, honest game when implemented. Never add fake multiplayer, payments, leaderboards, statistics, or competitive outcomes.
- Keep paid competition isolated from the game simulation. Payment and chain integrations may validate entry and settlement, but must not alter competitive rules or authoritative results.
- Competitive gameplay must remain skill-based: no pay-to-win mechanics and no RNG that decides competitive outcomes.

## Repository layout

- `apps/web` — public website and future browser game client.
- `services` — future deployable authoritative services, such as the game server and matchmaking.
- `packages` — future shared, versioned code such as protocol contracts; do not place server authority here.
- `docs` — architecture decisions and operating guidance.

See `docs/architecture.md` before introducing a cross-boundary dependency.

## Working conventions

- Use TypeScript for new application and shared-code work.
- Keep browser code presentation- and input-focused. Treat every client message as untrusted at the server boundary.
- Do not add blockchain contracts, real payment processing, cloud infrastructure, secrets, or wallet prompts until their scoped product work begins.
- Add tests with simulation, transport, payment, or settlement behavior. Deterministic simulation tests are preferred.
- Update documentation when a boundary, authority rule, or operational command changes.

## Commands

From the repository root:

```sh
npm install
npm run dev:web
npm run check
```

`npm run check` runs the current type and production-build checks for all active workspaces.
