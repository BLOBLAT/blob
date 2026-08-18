# BLOB game rules

## Free Mode round

Free Mode is a real, session-based multiplayer round in the authoritative Colyseus room blob_arena. There are no bots, fake statistics, payments, or client-decided outcomes.

The server owns this explicit lifecycle:

WAITING → MATCHMAKING → COUNTDOWN → ACTIVE → FINISHED → RESULTS → WAITING

The default tuning lives only in packages/game-core/src/index.ts:

| Setting | Default |
| --- | ---: |
| Minimum players | 2 |
| Maximum players | 32 |
| Matchmaking window | 120 seconds |
| Countdown | 10 seconds |
| Active round | 10 minutes |
| Results screen | 15 seconds |
| Simulation tick | 50 ms |

One player waits in matchmaking. When at least two players are queued, the server creates a unique matchId and roundId, freezes movement for the countdown, safely spawns participants, then starts the active round. Players connecting after countdown remain queued for the next round rather than changing a live round's population.

At 00:00 the server stops progression, freezes a single immutable final result, enters FINISHED, then exposes it during RESULTS. After the results interval, the same room returns to matchmaking.

## Movement and camera

Clients send only normalized direction intent. The server validates finite values in [-1, 1], rate-limits input, uses only the most recent valid input, clamps position to the server-owned world bounds, and treats input as zero after a short timeout. A stopped mouse, released touch, stale tab, or temporary network interruption therefore cannot produce indefinite drift.

Desktop supports mouse steering with WASD/arrow fallback. Phones use a touch joystick: releasing the finger sends zero intent and the canvas disables browser touch scrolling while steering.

The authoritative world is a bounded rectangle. Its dimensions and food target are calculated deterministically from the round's player count; two players do not receive the same oversized space as a full 32-player round. The client receives those dimensions, sets matching Phaser camera bounds, and follows the local BLOB.

## Growth, combat, and respawn

- Food is created and replenished by the server. Each collected pellet increases the collector's mass and personal foodCollected statistic.

- A BLOB can eat another only when the server verifies collision range and the configured mass ratio advantage.

- The eater receives the configured percentage of the defeated BLOB's mass and an elimination. The defeated BLOB records a death.

- Free Mode enables respawn after a server-controlled delay. Spawns are inside bounds, attempt to avoid live BLOBs, and have short spawn protection.

- The active leaderboard contains only alive participants and is calculated by the server.

The HUD presents mass, rank, alive count, personal food eaten, and the authoritative round timer. It deliberately does not present a misleading global food-object counter.

## Ranking and result

The winner is the participant with the greatest final mass. Ties are resolved server-side in this order:

1. Longer survival time.
2. Earlier server join sequence.
3. Stable player ID ordering.

The result lists the top three and each player's final rank, mass, food collected, eliminations, deaths, and survival time. The browser renders this finalized server data; it never calculates a winner.

## Authority and mode boundary

The browser never controls position, speed, mass, collisions, deaths, rank, timer, result, or rewards. It sends input and renders synchronized Colyseus state plus transient server events.

FREE and future PAID modes share one game engine and are controlled by mode configuration. Paid Mode is not playable or funded today. Its future settlement service may consume an immutable AuthoritativeMatchResult, but it will not change the game's combat, movement, or winner rules and the game server will not hold keys or transfer funds.
