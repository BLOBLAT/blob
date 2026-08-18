# Shared packages

- `protocol` contains room names, wire-contract types, and lifecycle states.
- `validation` contains Zod schemas applied at untrusted boundaries.
- `game-core` contains the deterministic arena simulation used by the authoritative server.
- `shared` contains the paid-match state machine, payment-domain interfaces, and integer prize calculation.

These packages do not grant authority to browser code. The game server alone runs the simulation; no concrete payment or blockchain adapter exists yet.
