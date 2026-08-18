# Future services

Deployable backend services will live here when their implementation begins:

- `game-server` for the authoritative real-time simulation.
- `matchmaking` for queueing and server allocation.
- `api` for account-facing and administrative APIs, if a separate boundary becomes necessary.
- `payments` for entry and settlement orchestration, isolated from game rules.

Do not create service stubs solely to simulate functionality. Their contracts and authority boundaries are defined in `../docs/architecture.md`.
