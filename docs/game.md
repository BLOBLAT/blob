# BLOB game — first playable slice

## Implemented

Local Free Mode is a real Colyseus room named `blob_arena`. Multiple browser clients call `joinOrCreate`, so they share a server instance and observe the same server-synchronized state.

The authoritative server implements:

- fixed 50 ms simulation ticks inside the Colyseus room;
- a bounded 2400 × 1400 arena;
- server-created player spawns and deterministic food placement;
- normalized mouse-direction intent, validated as finite values in `[-1, 1]`;
- server-calculated movement, input rate limiting, input expiry, and world clamping;
- food collection, mass growth, collision/eating rules, kills, death, respawn, and spawn protection;
- server-issued rank, mass, kills, score, and match state;
- the lifecycle `LOBBY → COUNTDOWN → PLAYING → RESULTS → LOBBY`.

The browser renders Colyseus state with Phaser and sends only the most recent direction intent. Mouse or touch steers toward the pointer; WASD and arrow keys are also supported. It cannot submit a position, collision, score, kill, rank, or result.

The camera follows the local blob and reduces zoom gradually as that blob grows. The HUD and leaderboard are presentation of Colyseus state only: current mass, rank, living player count, food population, and respawn status never originate in the browser.

All tuning values are in `packages/game-core/src/index.ts`. Food and spawn positions are deterministic rather than competitive-outcome RNG.

## Not implemented

- authentication, durable accounts, and cross-session profiles;
- persistence, match history, global rankings, achievements, cosmetics, referrals, or tournaments;
- spectator mode, bots, account-based reconnect reservation, rate-limit infrastructure, or production observability;
- skill matchmaking or paid-mode room lifecycle.

The in-match leaderboard is real only for the current authoritative room. No global player counts or fake statistics are shown.
