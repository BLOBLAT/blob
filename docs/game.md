# BLOB game rules

## Free Mode round

Free Mode is a real, session-based multiplayer round in the authoritative
Colyseus room `blob_arena`. It can contain a small roster of server-owned,
clearly marked **Arena Bots** when fewer live players are present. They are
not fake people: every bot has `isBot: true` in the synchronized state, is
labelled `BOT · ARENA …` in the ranking/results UI, is excluded from real
visitor metrics and chat, and is never admitted to Paid Mode. There are no
fake statistics, payments, or client-decided outcomes.

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
| Free Mode Arena Bots | Server-selected 3–5 per round |

When a human enters Free Mode, the server creates a deterministic, varied
roster of three to five Arena Bots for that round. This makes the normal
minimum population available immediately, while the UI states the real-player
and bot counts separately. Each bot is a server-side participant—not a
Colyseus client—and follows the same intent/movement pipeline as a human:
it flees larger BLOBs, pursues safely smaller targets, collects nearby food,
and otherwise roams. To avoid an impossible perfect-autopilot opponent, bot
decisions use a bounded cadence and perception/food-search ranges, with a
server-configured movement-speed cap below a human's maximum. A human always
displaces a bot if the round reaches capacity.

The server then creates a unique `matchId` and `roundId`, freezes movement for
the countdown, safely spawns participants, then starts the active round. Free
Mode also admits players who arrive during an active round: they receive a
server-selected safe spawn and temporary spawn protection immediately. The
active world's size remains fixed for that round. This Free Mode policy is
configuration-driven; future Paid Mode has bots disabled and can retain a
next-round queue instead.

At 00:00 the server stops progression, freezes a single immutable final result, enters FINISHED, then exposes it during RESULTS. After the results interval, the same room returns to matchmaking.

## Movement and camera

Clients send only normalized direction intent. The server validates finite values in [-1, 1], rate-limits movement updates, applies a valid explicit zero intent immediately, clamps position to the server-owned world bounds, and treats input as zero after a short fallback timeout. A stopped mouse, released touch, stale tab, or temporary network interruption therefore cannot produce indefinite drift without a brief packet hiccup looking like a released control.

Desktop supports mouse steering with WASD/arrow fallback. Phones use a fixed, thumb-reachable touch joystick: releasing the finger sends zero intent, the player may switch its lower-corner side with the in-game hand button, and the browser remembers that non-sensitive presentation preference locally. The canvas disables browser touch scrolling while steering.

The authoritative world is a bounded rectangle. Its dimensions and food target are calculated deterministically from the round's player count; two players do not receive the same oversized space as a full 32-player round. The client receives those dimensions, sets matching Phaser camera bounds, smoothly interpolates synchronized positions for rendering only, follows the local BLOB, and uses a slightly wider camera on compact touch viewports. Interpolation never changes authoritative state or sends a position to the server.

## Growth, combat, and respawn

- Food is created and replenished by the server. Each collected pellet increases the collector's mass and personal foodCollected statistic.

- A BLOB can eat another only when the server verifies collision range and the configured mass ratio advantage.

- The eater receives the configured percentage of the defeated BLOB's mass and an elimination. The defeated BLOB records a death.

- Free Mode enables respawn after a server-controlled delay. Spawns are inside bounds, attempt to avoid live BLOBs, and have short spawn protection.

- The active leaderboard contains only alive participants and is calculated by the server.

The HUD presents mass, rank, alive count, personal food eaten, and the authoritative round timer. It deliberately does not present a misleading global food-object counter.

## Identity and Arena Chat

Wallet connection is optional and never changes Free Mode rules. An anonymous
player gets a server-assigned temporary `BLOB-…` name. A wallet-backed profile
can use one globally unique, case/spacing-normalized display name only after
the platform API has verified an off-chain message signature and issued an
expiring game-identity ticket. A claimed name returns a clear conflict instead
of silently impersonating another player. The browser cannot make the game
server accept an arbitrary profile name, and the arena never receives the
wallet address.

**Arena Chat** appears beneath the active game. It carries messages only
between currently connected players in that same room. Messages are plain text
only, bounded to 240 characters, normalized by the server, and rate-limited.
Links—including normal URLs, `www` forms, and common obfuscated domain forms—
contact details, and common wallet-phishing phrases are rejected by the server.
Production first creates a signed private audit record in Platform API
PostgreSQL, then broadcasts the message; audit records expire after 90 days by
default. It records a name snapshot but never a wallet address, cookie, or IP.
Chat cannot determine a match result or change gameplay state.

## Ranking and result

The winner is the participant with the greatest final mass. Ties are resolved server-side in this order:

1. Longer survival time.
2. Earlier server join sequence.
3. Stable player ID ordering.

The result lists the top three and each player's final rank, mass, food collected, eliminations, deaths, and survival time. The browser renders this finalized server data; it never calculates a winner.

## Authority and mode boundary

The browser never controls position, speed, mass, collisions, deaths, rank, timer, result, or rewards. It sends input and renders synchronized Colyseus state plus transient server events.

FREE and future PAID modes share one game engine and are controlled by mode configuration. Paid Mode is not playable or funded today. Its future settlement service may consume an immutable AuthoritativeMatchResult, but it will not change the game's combat, movement, or winner rules and the game server will not hold keys or transfer funds.
